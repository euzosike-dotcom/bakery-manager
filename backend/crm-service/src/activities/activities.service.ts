import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { CreateActivityDto, SyncPushResultDto } from './dto/activity.dto';

export interface CreateActivityOptions {
  createdOffline: boolean;
}

/**
 * Activities are this module's offline-capturable surface (migration 012's
 * header comment) — a field sales rep logging a call/visit/note against a
 * customer, same pattern as every other module's field-facing capture
 * (docs/SDD.md §2.1). No financial consequence, so unlike Sales/Procurement/
 * Manufacturing there's no Kafka publish here at all.
 */
@Injectable()
export class ActivitiesService {
  private readonly logger = new Logger(ActivitiesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createActivity(
    tenantId: string,
    dto: CreateActivityDto,
    options: CreateActivityOptions,
  ): Promise<SyncPushResultDto> {
    const clientEventId = dto.clientEventId ?? randomUUID();

    const existing = await this.prisma.forTenant(tenantId, (tx) =>
      tx.activity.findUnique({ where: { tenantId_clientEventId: { tenantId, clientEventId } } }),
    );
    if (existing) {
      this.logger.log(`Activity clientEventId=${clientEventId} already applied — idempotent no-op`);
      return { clientEventId, status: 'ACKED', serverEntityId: existing.activityId, message: 'Already applied (idempotent replay)' };
    }

    const activityId = dto.activityId ?? randomUUID();
    await this.prisma.forTenant(tenantId, async (tx) => {
      const customer = await tx.customer.findUnique({ where: { tenantId_customerId: { tenantId, customerId: dto.customerId } } });
      if (!customer) throw new NotFoundException(`Customer ${dto.customerId} not found`);

      await tx.$executeRaw`
        INSERT INTO activities (
          tenant_id, activity_id, customer_id, activity_type, notes, activity_date,
          created_by_user_id, client_event_id, device_id, created_offline
        ) VALUES (
          ${tenantId}::uuid, ${activityId}::uuid, ${dto.customerId}::uuid, ${dto.activityType}, ${dto.notes ?? null},
          ${dto.activityDate ? new Date(dto.activityDate) : new Date()},
          ${dto.createdByUserId ?? null}::uuid, ${clientEventId}::uuid, ${dto.deviceId ?? null}::uuid, ${options.createdOffline}
        )
      `;
    });

    return { clientEventId, status: 'ACKED', serverEntityId: activityId, message: 'Activity logged.' };
  }

  findAll(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.activity.findMany({ where: { tenantId }, orderBy: { activityDate: 'desc' } }),
    );
  }
}
