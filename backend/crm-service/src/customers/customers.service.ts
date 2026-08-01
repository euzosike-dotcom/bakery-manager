import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { CreateCustomerDto, UpdateCustomerStatusDto } from './dto/customer.dto';

/**
 * CRUD-lite (SDD-style scope decision, see migration 012's header comment):
 * no Lead/Customer conversion workflow, no dedup/merge, no soft-delete —
 * enough to prove Sales/Accounting can link against a real customer record.
 */
@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  create(tenantId: string, dto: CreateCustomerDto) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.customer.create({
        data: {
          tenantId,
          customerId: dto.customerId ?? randomUUID(),
          customerCode: dto.customerCode,
          customerName: dto.customerName,
          customerType: dto.customerType ?? 'RETAIL',
          contactPerson: dto.contactPerson,
          phone: dto.phone,
          email: dto.email,
          address: dto.address,
          plantId: dto.plantId,
          customerStatus: 'PROSPECT',
          createdAt: new Date(),
        },
      }),
    );
  }

  findAll(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.customer.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } }),
    );
  }

  async findOne(tenantId: string, customerId: string) {
    const customer = await this.prisma.forTenant(tenantId, (tx) =>
      tx.customer.findUnique({ where: { tenantId_customerId: { tenantId, customerId } } }),
    );
    if (!customer) throw new NotFoundException(`Customer ${customerId} not found`);
    return customer;
  }

  async updateStatus(tenantId: string, customerId: string, dto: UpdateCustomerStatusDto) {
    const existing = await this.prisma.forTenant(tenantId, (tx) =>
      tx.customer.findUnique({ where: { tenantId_customerId: { tenantId, customerId } } }),
    );
    if (!existing) throw new NotFoundException(`Customer ${customerId} not found`);

    return this.prisma.forTenant(tenantId, (tx) =>
      tx.customer.update({
        where: { tenantId_customerId: { tenantId, customerId } },
        data: { customerStatus: dto.customerStatus },
      }),
    );
  }
}
