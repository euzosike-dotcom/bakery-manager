import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { CreateApprovalMatrixDto } from './dto/approval-matrix.dto';

@Injectable()
export class ApprovalMatrixService {
  constructor(private readonly prisma: PrismaService) {}

  create(tenantId: string, dto: CreateApprovalMatrixDto) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.approvalMatrix.create({
        data: {
          tenantId,
          approvalMatrixId: randomUUID(),
          moduleName: dto.moduleName,
          transactionType: dto.transactionType,
          plantId: dto.plantId,
          thresholdMin: dto.thresholdMin,
          thresholdMax: dto.thresholdMax,
          approvalLevel1RoleId: dto.approvalLevel1RoleId,
          approvalLevel2RoleId: dto.approvalLevel2RoleId,
          approvalLevel3RoleId: dto.approvalLevel3RoleId,
          isActive: true,
        },
      }),
    );
  }

  findAll(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) => tx.approvalMatrix.findMany({ where: { tenantId } }));
  }
}
