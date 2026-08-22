import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PostingAuthorityClient } from '@metrock/backend-common';
import { PrismaService } from '../common/prisma.service';
import { SubmitAgentOnboardingDto } from './dto/agent-onboarding.dto';

/**
 * Sales Agent Onboarding: initiate a request, route it through
 * approval_matrix (module SALES, transaction_type AGENT_ONBOARDING), and
 * provision the real agent_master row on final approval. Same shape every
 * other approval_matrix module in this platform follows — creation calls
 * no authority check at all, only approve/reject do, via
 * checkApprovalAuthority, and reject requires the identical tier-check as
 * approve — except this is the first module where a real seeded band
 * populates a SECOND approval level (governance_seed.sql): a request
 * above the tenant's configured capital threshold needs two sequential
 * sign-offs, not one. approve() below needed no special casing for that —
 * `hasNextStage` already generalizes to however many levels a band
 * actually has.
 */
@Injectable()
export class AgentOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postingAuthority: PostingAuthorityClient,
  ) {}

  async submitOnboarding(tenantId: string, dto: SubmitAgentOnboardingDto, userId: string | undefined) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.agentOnboardingRequest.create({
        data: {
          tenantId,
          onboardingRequestId: randomUUID(),
          agentCode: dto.agentCode,
          agentName: dto.agentName,
          agentType: dto.agentType ?? 'FIELD_AGENT',
          plantId: dto.plantId,
          requestedTradingCapital: dto.requestedTradingCapital,
          capitalCap: dto.capitalCap,
          baseDiscountPercent: dto.baseDiscountPercent ?? 0,
          submittedByUserId: userId,
          status: 'PENDING_APPROVAL',
        },
      }),
    );
  }

  findAllRequests(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.agentOnboardingRequest.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } }),
    );
  }

  async approveOnboarding(tenantId: string, onboardingRequestId: string, userId: string | undefined) {
    const request = await this.prisma.forTenant(tenantId, (tx) =>
      tx.agentOnboardingRequest.findUnique({ where: { tenantId_onboardingRequestId: { tenantId, onboardingRequestId } } }),
    );
    if (!request) throw new NotFoundException(`Agent onboarding request ${onboardingRequestId} not found`);
    if (request.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        `Agent onboarding request ${onboardingRequestId} is not pending approval (status=${request.status})`,
      );
    }

    const result = await this.postingAuthority.checkApprovalAuthority({
      tenantId,
      userId,
      moduleName: 'SALES',
      transactionType: 'AGENT_ONBOARDING',
      recordIdRef: onboardingRequestId,
      amount: Number(request.requestedTradingCapital),
      stage: request.currentApprovalStage,
    });

    if (result.hasNextStage) {
      return this.prisma.forTenant(tenantId, (tx) =>
        tx.agentOnboardingRequest.update({
          where: { tenantId_onboardingRequestId: { tenantId, onboardingRequestId } },
          data: { currentApprovalStage: request.currentApprovalStage + 1 },
        }),
      );
    }

    // Final stage: provision the real agent — the whole point of this
    // workflow. agent_master is the same table every other Sales & Agent
    // Capital feature already reads/writes; this is simply its first-ever
    // real create path (previously seed-file-only).
    const agentId = randomUUID();
    return this.prisma.forTenant(tenantId, async (tx) => {
      await tx.agentMaster.create({
        data: {
          tenantId,
          agentId,
          agentCode: request.agentCode,
          agentName: request.agentName,
          agentType: request.agentType,
          plantId: request.plantId,
          agentStatus: 'ACTIVE',
          approvedTradingCapital: request.requestedTradingCapital,
          capitalCap: request.capitalCap,
          baseDiscountPercent: request.baseDiscountPercent,
        },
      });

      return tx.agentOnboardingRequest.update({
        where: { tenantId_onboardingRequestId: { tenantId, onboardingRequestId } },
        data: { status: 'PROVISIONED', pendingApproverRoleId: null, agentId },
      });
    });
  }

  async rejectOnboarding(tenantId: string, onboardingRequestId: string, userId: string | undefined) {
    const request = await this.prisma.forTenant(tenantId, (tx) =>
      tx.agentOnboardingRequest.findUnique({ where: { tenantId_onboardingRequestId: { tenantId, onboardingRequestId } } }),
    );
    if (!request) throw new NotFoundException(`Agent onboarding request ${onboardingRequestId} not found`);
    if (request.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        `Agent onboarding request ${onboardingRequestId} is not pending approval (status=${request.status})`,
      );
    }

    // Rejecting requires the SAME approval-tier gate as approving, at
    // whatever stage the request currently sits at — see
    // procurement-service's rejectPurchaseOrder for the identical
    // reasoning: a lower-tier approver can reject what they could have
    // approved, not reject something above their own tier.
    await this.postingAuthority.checkApprovalAuthority({
      tenantId,
      userId,
      moduleName: 'SALES',
      transactionType: 'AGENT_ONBOARDING',
      recordIdRef: onboardingRequestId,
      amount: Number(request.requestedTradingCapital),
      stage: request.currentApprovalStage,
    });

    return this.prisma.forTenant(tenantId, (tx) =>
      tx.agentOnboardingRequest.update({
        where: { tenantId_onboardingRequestId: { tenantId, onboardingRequestId } },
        data: { status: 'REJECTED', pendingApproverRoleId: null },
      }),
    );
  }
}
