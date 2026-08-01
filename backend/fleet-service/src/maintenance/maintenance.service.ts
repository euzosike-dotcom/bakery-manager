import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { KafkaProducerService } from '@metrock/backend-common';
import { PrismaService } from '../common/prisma.service';
import { CompleteMaintenanceRequestDto } from './dto/maintenance.dto';

/**
 * The shared review queue fed by both the mileage service-threshold check
 * (TripsService) and fuel-variance investigation (FuelService) — SDD
 * §3.E deliberately routes both possibilities into one queue rather than
 * assuming a root cause. Completion is an online-only back-office action
 * (mirrors NcrService.verifyNcr, Slice #3) — no offline path, no
 * client_event_id/sync plumbing — since it's inherently a connected
 * back-office decision, not a field capture. Only completion posts to
 * the GL; auto-creation never does.
 */
@Injectable()
export class MaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  findAll(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.maintenanceRequest.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } }),
    );
  }

  async completeMaintenanceRequest(tenantId: string, maintenanceRequestId: string, dto: CompleteMaintenanceRequestDto) {
    const totalCost = dto.partsCost + dto.labourCost;

    await this.prisma.forTenant(tenantId, async (tx) => {
      const request = await tx.maintenanceRequest.findUnique({
        where: { tenantId_maintenanceRequestId: { tenantId, maintenanceRequestId } },
      });
      if (!request) throw new NotFoundException(`Maintenance request ${maintenanceRequestId} not found`);
      if (request.requestStatus === 'COMPLETED') {
        throw new BadRequestException(`Maintenance request ${maintenanceRequestId} is already completed`);
      }

      await tx.maintenanceRequest.update({
        where: { tenantId_maintenanceRequestId: { tenantId, maintenanceRequestId } },
        data: {
          requestStatus: 'COMPLETED',
          partsCost: dto.partsCost,
          labourCost: dto.labourCost,
          completedAt: new Date(),
        },
      });
    });

    // Kafka publish happens AFTER this transaction commits — same
    // reasoning as every other module's producer call.
    await this.kafka.publish(tenantId, 'fleet.maintenance_completed.v1', {
      event_id: randomUUID(),
      tenant_id: tenantId,
      maintenance_request_id: maintenanceRequestId,
      total_cost: totalCost,
      posted_at: new Date().toISOString(),
    });

    return { maintenanceRequestId, completed: true, totalCost };
  }
}
