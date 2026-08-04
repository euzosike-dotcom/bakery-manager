import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { CreateUserDto } from './dto/user.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateUserDto) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      if (dto.roleId) {
        const role = await tx.role.findUnique({ where: { tenantId_roleId: { tenantId, roleId: dto.roleId } } });
        if (!role) throw new NotFoundException(`Role ${dto.roleId} not found`);
      }

      return tx.user.create({
        data: {
          tenantId,
          userId: randomUUID(),
          fullName: dto.fullName,
          email: dto.email,
          employeeCode: dto.employeeCode,
          roleId: dto.roleId,
          plantId: dto.plantId,
          department: dto.department,
          userStatus: 'ACTIVE',
          mfaEnabled: false,
        },
      });
    });
  }

  findAll(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.user.findMany({ where: { tenantId }, include: { role: true, plant: true } }),
    );
  }
}
