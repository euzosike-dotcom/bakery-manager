import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { CreatePlantDto } from './dto/plant.dto';

@Injectable()
export class PlantsService {
  constructor(private readonly prisma: PrismaService) {}

  create(tenantId: string, dto: CreatePlantDto) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.plant.create({
        data: {
          tenantId,
          plantId: randomUUID(),
          plantCode: dto.plantCode,
          plantName: dto.plantName,
          plantType: dto.plantType,
          address: dto.address,
          capacityKgPerDay: dto.capacityKgPerDay,
          plantStatus: 'ACTIVE',
          supportsAgentSales: dto.supportsAgentSales ?? false,
          supportsProduction: dto.supportsProduction ?? true,
          supportsInterplantTransfer: false,
          payrollRatio: 0,
          createdAt: new Date(),
        },
      }),
    );
  }

  findAll(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) => tx.plant.findMany({ where: { tenantId } }));
  }
}
