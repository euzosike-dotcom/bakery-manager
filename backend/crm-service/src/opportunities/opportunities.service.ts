import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { CreateOpportunityDto } from './dto/opportunity.dto';

@Injectable()
export class OpportunitiesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateOpportunityDto) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const customer = await tx.customer.findUnique({
        where: { tenantId_customerId: { tenantId, customerId: dto.customerId } },
      });
      if (!customer) throw new NotFoundException(`Customer ${dto.customerId} not found`);

      return tx.opportunity.create({
        data: {
          tenantId,
          opportunityId: dto.opportunityId ?? randomUUID(),
          customerId: dto.customerId,
          opportunityName: dto.opportunityName,
          stage: 'NEW',
          estimatedValue: dto.estimatedValue,
          expectedCloseDate: dto.expectedCloseDate ? new Date(dto.expectedCloseDate) : undefined,
          ownerUserId: dto.ownerUserId,
          createdAt: new Date(),
        },
      });
    });
  }

  findAll(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.opportunity.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } }),
    );
  }
}
