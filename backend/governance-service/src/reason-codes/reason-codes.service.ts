import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { CreateReasonCodeDto } from './dto/reason-code.dto';

@Injectable()
export class ReasonCodesService {
  constructor(private readonly prisma: PrismaService) {}

  create(tenantId: string, dto: CreateReasonCodeDto) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.reasonCode.create({
        data: {
          tenantId,
          reasonCodeId: randomUUID(),
          reasonCode: dto.reasonCode,
          reasonGroup: dto.reasonGroup,
          description: dto.description,
          isActive: true,
        },
      }),
    );
  }

  findAll(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) => tx.reasonCode.findMany({ where: { tenantId } }));
  }
}
