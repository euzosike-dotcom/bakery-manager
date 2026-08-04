import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { CreateRoleDto } from './dto/role.dto';

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  create(tenantId: string, dto: CreateRoleDto) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.role.create({
        data: {
          tenantId,
          roleId: randomUUID(),
          roleCode: dto.roleCode,
          roleName: dto.roleName,
          roleCategory: dto.roleCategory,
          canApprove: dto.canApprove ?? false,
          canPost: dto.canPost ?? false,
          canOverride: dto.canOverride ?? false,
          isActive: true,
        },
      }),
    );
  }

  findAll(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) => tx.role.findMany({ where: { tenantId } }));
  }
}
