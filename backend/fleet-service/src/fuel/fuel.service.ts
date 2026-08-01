import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { KafkaProducerService } from '@metrock/backend-common';
import { PrismaService } from '../common/prisma.service';
import { CreateFuelRecordDto, SyncPushResultDto } from './dto/fuel-record.dto';

export interface CreateFuelRecordOptions {
  createdOffline: boolean;
}

/**
 * Fuel records are the other canonical offline-capture use case (SDD
 * §3.E) alongside trip logs. Fuel Variance = Expected − Actual
 * consumption, where Expected is derived from the vehicle's class norm
 * (`vehicle_class_fuel_norms.litres_per_km`) applied to the linked trip's
 * mileage delta. A variance outside the configured tolerance band auto-
 * creates a `maintenance_requests` row (FUEL_VARIANCE_INVESTIGATION) —
 * the same shared review queue the mileage-threshold check in
 * TripsService feeds, since either a mechanical fault or fuel diversion
 * could explain it and this platform doesn't assume which (SDD §3.E).
 *
 * Variance is NEVER posted financially — only actual `fuel_cost` is
 * (SDD §3.E note). See Matrix Scenario #9 for why a fuel record
 * referencing a since-cancelled trip is still accepted and posted, only
 * flagged via `orphanedTripReference`, never rejected.
 */
@Injectable()
export class FuelService {
  private readonly logger = new Logger(FuelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  async createFuelRecord(
    tenantId: string,
    dto: CreateFuelRecordDto,
    options: CreateFuelRecordOptions,
  ): Promise<SyncPushResultDto> {
    const clientEventId = dto.clientEventId ?? randomUUID();

    const existing = await this.prisma.forTenant(tenantId, (tx) =>
      tx.fuelRecord.findUnique({ where: { tenantId_clientEventId: { tenantId, clientEventId } } }),
    );
    if (existing) {
      this.logger.log(`Fuel record clientEventId=${clientEventId} already applied — idempotent no-op`);
      return { clientEventId, status: 'ACKED', serverEntityId: existing.fuelRecordId, message: 'Already applied (idempotent replay)' };
    }

    const fuelRecordId = dto.fuelRecordId ?? randomUUID();

    const result = await this.prisma.forTenant(tenantId, async (tx) => {
      const vehicle = await tx.vehicle.findUnique({ where: { tenantId_vehicleId: { tenantId, vehicleId: dto.vehicleId } } });
      if (!vehicle) throw new NotFoundException(`Vehicle ${dto.vehicleId} not found`);

      let orphanedTripReference = false;
      let varianceTriggered = false;

      if (dto.tripLogId) {
        const trip = await tx.tripLog.findUnique({ where: { tenantId_tripLogId: { tenantId, tripLogId: dto.tripLogId } } });
        if (!trip) throw new NotFoundException(`Trip log ${dto.tripLogId} not found`);

        if (trip.tripStatus === 'CANCELLED') {
          // Matrix Scenario #9: still accepted and posted, never rejected
          // over this referential race — the fuel was physically bought.
          orphanedTripReference = true;
        } else {
          const norm = await tx.vehicleClassFuelNorm.findUnique({
            where: { tenantId_vehicleClass: { tenantId, vehicleClass: vehicle.vehicleClass } },
          });
          if (norm) {
            const mileageDelta = Number(trip.endMileage) - Number(trip.startMileage);
            const expected = Number(norm.litresPerKm) * mileageDelta;
            const actual = dto.litres;
            const variance = expected - actual;
            const toleranceAmount = expected * (Number(norm.tolerancePercent) / 100);

            if (Math.abs(variance) > toleranceAmount) {
              await tx.maintenanceRequest.create({
                data: {
                  tenantId,
                  maintenanceRequestId: randomUUID(),
                  vehicleId: dto.vehicleId,
                  reason: 'FUEL_VARIANCE_INVESTIGATION',
                  requestStatus: 'OPEN',
                  notes: `Fuel record ${fuelRecordId} against trip ${dto.tripLogId}: expected ${expected.toFixed(3)}L, actual ${actual}L, variance ${variance.toFixed(3)}L (tolerance ${toleranceAmount.toFixed(3)}L)`,
                  createdAt: new Date(),
                },
              });
              varianceTriggered = true;
            }
          }
        }
      }

      // Raw insert, not tx.fuelRecord.create() — same bigserial sync_seq
      // reason as TripsService's trip_logs insert.
      await tx.$executeRaw`
        INSERT INTO fuel_records (
          tenant_id, fuel_record_id, vehicle_id, trip_log_id, litres, fuel_cost,
          expense_claim_reference, orphaned_trip_reference, posting_status,
          client_event_id, device_id, created_offline
        ) VALUES (
          ${tenantId}::uuid, ${fuelRecordId}::uuid, ${dto.vehicleId}::uuid, ${dto.tripLogId ?? null}::uuid,
          ${dto.litres}, ${dto.fuelCost}, ${dto.expenseClaimReference ?? null}, ${orphanedTripReference}, 'PENDING',
          ${clientEventId}::uuid, ${dto.deviceId ?? null}::uuid, ${options.createdOffline}
        )
      `;

      return { fuelRecordId, orphanedTripReference, varianceTriggered };
    });

    // Kafka publish happens AFTER this transaction commits, not inside it
    // — same reasoning as every other module's producer call (a slow/
    // unavailable broker must not roll back a capture that already
    // succeeded in Postgres).
    await this.kafka.publish(tenantId, 'fleet.fuel_recorded.v1', {
      event_id: randomUUID(),
      tenant_id: tenantId,
      fuel_record_id: result.fuelRecordId,
      vehicle_id: dto.vehicleId,
      fuel_cost: dto.fuelCost,
      posted_at: new Date().toISOString(),
    });

    const messages: string[] = ['Fuel record logged and posted.'];
    if (result.orphanedTripReference) messages.push('Referenced trip was cancelled — flagged for review.');
    if (result.varianceTriggered) messages.push('Fuel variance outside tolerance — a maintenance investigation was opened.');

    return { clientEventId, status: 'ACKED', serverEntityId: result.fuelRecordId, message: messages.join(' ') };
  }
}
