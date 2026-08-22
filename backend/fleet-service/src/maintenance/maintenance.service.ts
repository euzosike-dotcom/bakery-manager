import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { KafkaProducerService, PostingAuthorityClient } from '@metrock/backend-common';
import { PrismaService } from '../common/prisma.service';
import { CompleteMaintenanceRequestDto } from './dto/maintenance.dto';

/**
 * The shared review queue fed by both the mileage service-threshold check
 * (TripsService) and fuel-variance investigation (FuelService) — SDD
 * §3.E deliberately routes both possibilities into one queue rather than
 * assuming a root cause. Online-only, no offline path — inherently a
 * connected back-office decision, not a field capture.
 *
 * Amount-routed approval (docs/RUNBOOK.md's "approval_matrix expansion"
 * section, migration 023) split what used to be one atomic
 * `complete()` call into two: the repair cost is only known at
 * completion time, so `submit()` (still `POST .../complete`, same DTO —
 * only its effect changed) records the now-known cost and moves
 * `OPEN` -> `PENDING_APPROVAL` with NO Kafka publish and NO GL effect
 * yet; a separate `approve()`/`reject()` — mirroring procurement-
 * service's PO approve/reject, including that submission itself calls
 * no authority check at all, only approve/reject do, via
 * `checkApprovalAuthority` — is what actually finalizes to `COMPLETED`
 * and publishes `fleet.maintenance_completed.v1`, the event that posts
 * to the GL.
 */
@Injectable()
export class MaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly postingAuthority: PostingAuthorityClient,
  ) {}

  findAll(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.maintenanceRequest.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } }),
    );
  }

  async submitMaintenanceRequest(
    tenantId: string,
    maintenanceRequestId: string,
    dto: CompleteMaintenanceRequestDto,
    _userId: string | undefined,
  ) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const request = await tx.maintenanceRequest.findUnique({
        where: { tenantId_maintenanceRequestId: { tenantId, maintenanceRequestId } },
      });
      if (!request) throw new NotFoundException(`Maintenance request ${maintenanceRequestId} not found`);
      if (request.requestStatus !== 'OPEN') {
        throw new BadRequestException(
          `Maintenance request ${maintenanceRequestId} is not open (status=${request.requestStatus})`,
        );
      }

      return tx.maintenanceRequest.update({
        where: { tenantId_maintenanceRequestId: { tenantId, maintenanceRequestId } },
        data: {
          requestStatus: 'PENDING_APPROVAL',
          partsCost: dto.partsCost,
          labourCost: dto.labourCost,
        },
      });
    });
  }

  async approveMaintenanceCompletion(tenantId: string, maintenanceRequestId: string, userId: string | undefined) {
    const request = await this.prisma.forTenant(tenantId, (tx) =>
      tx.maintenanceRequest.findUnique({ where: { tenantId_maintenanceRequestId: { tenantId, maintenanceRequestId } } }),
    );
    if (!request) throw new NotFoundException(`Maintenance request ${maintenanceRequestId} not found`);
    if (request.requestStatus !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        `Maintenance request ${maintenanceRequestId} is not pending approval (status=${request.requestStatus})`,
      );
    }

    const totalCost = Number(request.partsCost) + Number(request.labourCost);

    const result = await this.postingAuthority.checkApprovalAuthority({
      tenantId,
      userId,
      moduleName: 'FLEET',
      transactionType: 'MAINTENANCE_COMPLETION',
      recordIdRef: maintenanceRequestId,
      amount: totalCost,
      stage: request.currentApprovalStage,
    });

    if (result.hasNextStage) {
      return this.prisma.forTenant(tenantId, (tx) =>
        tx.maintenanceRequest.update({
          where: { tenantId_maintenanceRequestId: { tenantId, maintenanceRequestId } },
          data: { currentApprovalStage: request.currentApprovalStage + 1 },
        }),
      );
    }

    const updated = await this.prisma.forTenant(tenantId, (tx) =>
      tx.maintenanceRequest.update({
        where: { tenantId_maintenanceRequestId: { tenantId, maintenanceRequestId } },
        data: { requestStatus: 'COMPLETED', pendingApproverRoleId: null, completedAt: new Date() },
      }),
    );

    // Kafka publish happens AFTER the transaction commits — same
    // reasoning as every other module's producer call. This is the one
    // moment a maintenance request's cost actually posts to the GL.
    await this.kafka.publish(tenantId, 'fleet.maintenance_completed.v1', {
      event_id: randomUUID(),
      tenant_id: tenantId,
      maintenance_request_id: maintenanceRequestId,
      total_cost: totalCost,
      posted_at: new Date().toISOString(),
    });

    return { maintenanceRequestId, completed: true, totalCost, request: updated };
  }

  async rejectMaintenanceCompletion(tenantId: string, maintenanceRequestId: string, userId: string | undefined) {
    const request = await this.prisma.forTenant(tenantId, (tx) =>
      tx.maintenanceRequest.findUnique({ where: { tenantId_maintenanceRequestId: { tenantId, maintenanceRequestId } } }),
    );
    if (!request) throw new NotFoundException(`Maintenance request ${maintenanceRequestId} not found`);
    if (request.requestStatus !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        `Maintenance request ${maintenanceRequestId} is not pending approval (status=${request.requestStatus})`,
      );
    }

    const totalCost = Number(request.partsCost) + Number(request.labourCost);

    // Same approval-tier gate as approving — a lower-tier approver can
    // reject what they could have approved, not reject something above
    // their own tier (procurement-service's rejectPurchaseOrder is the
    // identical precedent).
    await this.postingAuthority.checkApprovalAuthority({
      tenantId,
      userId,
      moduleName: 'FLEET',
      transactionType: 'MAINTENANCE_COMPLETION',
      recordIdRef: maintenanceRequestId,
      amount: totalCost,
      stage: request.currentApprovalStage,
    });

    return this.prisma.forTenant(tenantId, (tx) =>
      tx.maintenanceRequest.update({
        where: { tenantId_maintenanceRequestId: { tenantId, maintenanceRequestId } },
        data: { requestStatus: 'REJECTED', pendingApproverRoleId: null },
      }),
    );
  }
}
