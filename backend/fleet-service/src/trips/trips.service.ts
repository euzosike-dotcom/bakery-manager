import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { CreateTripLogDto, SyncPushResultDto } from './dto/trip-log.dto';

export interface CreateTripLogOptions {
  createdOffline: boolean;
}

/**
 * Trip logs are one of the two canonical offline-capture use cases named
 * in the SDD mandate (§3.E) — drivers are frequently in zero-connectivity
 * transit corridors. Single-shot capture (start_mileage + end_mileage
 * together, a completed trip logged after the fact) rather than a
 * start/then/end two-phase workflow — see migration 017's doc comment for
 * why that simplification doesn't compromise proving the offline pattern.
 *
 * Closing a trip is also where the vehicle's `current_mileage` advances
 * and the service-threshold check runs — both inside the same transaction
 * as the trip write, same "compute the consequence live, inside the
 * write's own transaction" discipline as SalesService's capital gate.
 */
@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createTripLog(
    tenantId: string,
    dto: CreateTripLogDto,
    options: CreateTripLogOptions,
  ): Promise<SyncPushResultDto> {
    const clientEventId = dto.clientEventId ?? randomUUID();

    const existing = await this.prisma.forTenant(tenantId, (tx) =>
      tx.tripLog.findUnique({ where: { tenantId_clientEventId: { tenantId, clientEventId } } }),
    );
    if (existing) {
      this.logger.log(`Trip log clientEventId=${clientEventId} already applied — idempotent no-op`);
      return { clientEventId, status: 'ACKED', serverEntityId: existing.tripLogId, message: 'Already applied (idempotent replay)' };
    }

    if (dto.endMileage < dto.startMileage) {
      throw new BadRequestException('endMileage cannot be less than startMileage');
    }

    const tripLogId = dto.tripLogId ?? randomUUID();

    const result = await this.prisma.forTenant(tenantId, async (tx) => {
      const vehicle = await tx.vehicle.findUnique({ where: { tenantId_vehicleId: { tenantId, vehicleId: dto.vehicleId } } });
      if (!vehicle) throw new NotFoundException(`Vehicle ${dto.vehicleId} not found`);

      const driver = await tx.driver.findUnique({ where: { tenantId_driverId: { tenantId, driverId: dto.driverId } } });
      if (!driver) throw new NotFoundException(`Driver ${dto.driverId} not found`);

      // Raw insert, not tx.tripLog.create() — trip_logs.sync_seq is a
      // bigserial with no Prisma-visible default, same reason every other
      // module's sync_seq-bearing table (goods_receipts, sales_orders,
      // ...) is written this way rather than through the typed client.
      await tx.$executeRaw`
        INSERT INTO trip_logs (
          tenant_id, trip_log_id, vehicle_id, driver_id, trip_date,
          start_mileage, end_mileage, trip_status, destination_note,
          client_event_id, device_id, created_offline
        ) VALUES (
          ${tenantId}::uuid, ${tripLogId}::uuid, ${dto.vehicleId}::uuid, ${dto.driverId}::uuid,
          ${dto.tripDate ? new Date(dto.tripDate) : new Date()}, ${dto.startMileage}, ${dto.endMileage},
          'COMPLETED', ${dto.destinationNote ?? null}, ${clientEventId}::uuid, ${dto.deviceId ?? null}::uuid,
          ${options.createdOffline}
        )
      `;

      // Live computation, inside this transaction — mirrors
      // SalesService's capital-gate discipline: never trust a stale
      // client-side mileage reading, recompute against the current row.
      const newMileage = Math.max(Number(vehicle.currentMileage), dto.endMileage);
      await tx.vehicle.update({
        where: { tenantId_vehicleId: { tenantId, vehicleId: dto.vehicleId } },
        data: { currentMileage: newMileage },
      });

      let maintenanceTriggered = false;
      if (newMileage >= Number(vehicle.serviceThresholdKm)) {
        const openThresholdRequest = await tx.maintenanceRequest.findFirst({
          where: { tenantId, vehicleId: dto.vehicleId, reason: 'SERVICE_THRESHOLD', requestStatus: 'OPEN' },
        });
        if (!openThresholdRequest) {
          await tx.maintenanceRequest.create({
            data: {
              tenantId,
              maintenanceRequestId: randomUUID(),
              vehicleId: dto.vehicleId,
              reason: 'SERVICE_THRESHOLD',
              requestStatus: 'OPEN',
              notes: `Mileage ${newMileage} reached service threshold ${vehicle.serviceThresholdKm}`,
              createdAt: new Date(),
            },
          });
          maintenanceTriggered = true;
        }
      }

      return { tripLogId, maintenanceTriggered };
    });

    return {
      clientEventId,
      status: 'ACKED',
      serverEntityId: result.tripLogId,
      message: result.maintenanceTriggered
        ? 'Trip logged; vehicle has reached its service threshold — a maintenance request was created.'
        : 'Trip logged.',
    };
  }
}
