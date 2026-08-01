import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

export interface AgentCapitalStatus {
  agentId: string;
  agentCode: string;
  agentName: string;
  approvedTradingCapital: number;
  outstandingExposure: number;
  availableCapital: number;
}

/**
 * `availableCapital` is computed live from `trading_capital_ledger` every
 * time — NEVER cached or stored as a running-balance column. This is the
 * single most important invariant in this module (SDD §2.3 Conflict Matrix
 * scenario #2 / #7): a client's locally-cached "available capital" is
 * advisory only; the number that actually blocks or allows an order is
 * always this same computation, run again on the server at order-creation
 * time (see SalesService.createSalesOrder, which duplicates this query
 * inline rather than calling out to this service — it needs the read and
 * the trading_capital_ledger write in the SAME transaction, which ruled out
 * sharing a transaction handle across service boundaries without fighting
 * Prisma's generated types).
 */
@Injectable()
export class AgentsService {
  constructor(private readonly prisma: PrismaService) {}

  async listAgents(tenantId: string): Promise<AgentCapitalStatus[]> {
    const agents = await this.prisma.forTenant(tenantId, (tx) => tx.agentMaster.findMany());
    return Promise.all(agents.map((agent) => this.toCapitalStatus(tenantId, agent)));
  }

  async getAgentCapitalStatus(tenantId: string, agentId: string): Promise<AgentCapitalStatus> {
    const agent = await this.prisma.forTenant(tenantId, (tx) =>
      tx.agentMaster.findUnique({ where: { tenantId_agentId: { tenantId, agentId } } }),
    );
    if (!agent) throw new NotFoundException(`Agent ${agentId} not found`);
    return this.toCapitalStatus(tenantId, agent);
  }

  private async toCapitalStatus(
    tenantId: string,
    agent: { agentId: string; agentCode: string; agentName: string; approvedTradingCapital: unknown },
  ): Promise<AgentCapitalStatus> {
    const aggregate = await this.prisma.forTenant(tenantId, (tx) =>
      tx.tradingCapitalLedger.aggregate({
        where: { tenantId, agentId: agent.agentId },
        _sum: { debitValue: true, creditValue: true },
      }),
    );
    const debit = Number(aggregate._sum.debitValue ?? 0);
    const credit = Number(aggregate._sum.creditValue ?? 0);
    const outstandingExposure = debit - credit;
    const approvedTradingCapital = Number(agent.approvedTradingCapital);
    return {
      agentId: agent.agentId,
      agentCode: agent.agentCode,
      agentName: agent.agentName,
      approvedTradingCapital,
      outstandingExposure,
      availableCapital: approvedTradingCapital - outstandingExposure,
    };
  }
}
