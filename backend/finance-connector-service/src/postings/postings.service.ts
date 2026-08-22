import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class PostingsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.externalLedgerPosting.findMany({ orderBy: { receivedAt: 'desc' } }),
    );
  }
}
