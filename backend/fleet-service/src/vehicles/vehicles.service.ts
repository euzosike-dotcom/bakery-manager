import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class VehiclesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.vehicle.findMany({ where: { tenantId }, include: { assignedDriver: true } }),
    );
  }
}
