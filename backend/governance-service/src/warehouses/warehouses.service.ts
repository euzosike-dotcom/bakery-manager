import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { CreateWarehouseDto } from './dto/warehouse.dto';

@Injectable()
export class WarehousesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateWarehouseDto) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const plant = await tx.plant.findUnique({ where: { tenantId_plantId: { tenantId, plantId: dto.plantId } } });
      if (!plant) throw new NotFoundException(`Plant ${dto.plantId} not found`);

      return tx.warehouse.create({
        data: {
          tenantId,
          warehouseId: randomUUID(),
          warehouseCode: dto.warehouseCode,
          warehouseName: dto.warehouseName,
          plantId: dto.plantId,
          warehouseType: dto.warehouseType,
          isActive: true,
          createdAt: new Date(),
        },
      });
    });
  }

  findAll(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) => tx.warehouse.findMany({ where: { tenantId } }));
  }
}
