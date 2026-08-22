import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PostingAuthorityClient } from '@metrock/backend-common';
import { AgentOnboardingService } from './agent-onboarding.service';
import { PrismaService } from '../common/prisma.service';

const TENANT = 'tenant-1';
const REQUEST_ID = 'request-1';

function makePrisma(tx: Record<string, unknown>): PrismaService {
  return { forTenant: jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(tx)) } as unknown as PrismaService;
}

function makePostingAuthority(result: { hasNextStage: boolean } = { hasNextStage: false }): PostingAuthorityClient {
  return { checkApprovalAuthority: jest.fn().mockResolvedValue(result) } as unknown as PostingAuthorityClient;
}

function makeTx(overrides: { request?: Record<string, unknown> | null } = {}) {
  let agentCreated: Record<string, unknown> | undefined;
  return {
    agentOnboardingRequest: {
      create: jest.fn().mockImplementation(({ data }) => data),
      findUnique: jest.fn().mockResolvedValue(overrides.request ?? null),
      update: jest.fn().mockImplementation(({ data }) => ({ ...overrides.request, ...data })),
    },
    agentMaster: {
      create: jest.fn().mockImplementation(({ data }) => {
        agentCreated = data;
      }),
    },
    _agentCreated: () => agentCreated,
  };
}

describe('AgentOnboardingService.approveOnboarding', () => {
  const baseRequest = {
    onboardingRequestId: REQUEST_ID,
    status: 'PENDING_APPROVAL',
    currentApprovalStage: 1,
    agentCode: 'AG-0099',
    agentName: 'New Agent',
    agentType: 'FIELD_AGENT',
    plantId: 'plant-1',
    requestedTradingCapital: 100000,
    capitalCap: null,
    baseDiscountPercent: 0,
  };

  it('404s on an unknown request', async () => {
    const tx = makeTx({ request: null });
    const service = new AgentOnboardingService(makePrisma(tx), makePostingAuthority());

    await expect(service.approveOnboarding(TENANT, REQUEST_ID, 'user-1')).rejects.toThrow(NotFoundException);
  });

  it('rejects a request that is not pending approval', async () => {
    const tx = makeTx({ request: { ...baseRequest, status: 'PROVISIONED' } });
    const service = new AgentOnboardingService(makePrisma(tx), makePostingAuthority());

    await expect(service.approveOnboarding(TENANT, REQUEST_ID, 'user-1')).rejects.toThrow(BadRequestException);
  });

  it('single-level band: provisions the real agent immediately on the one required approval', async () => {
    const tx = makeTx({ request: baseRequest });
    const postingAuthority = makePostingAuthority({ hasNextStage: false });
    const service = new AgentOnboardingService(makePrisma(tx), postingAuthority);

    await service.approveOnboarding(TENANT, REQUEST_ID, 'user-1');

    expect(postingAuthority.checkApprovalAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ moduleName: 'SALES', transactionType: 'AGENT_ONBOARDING', amount: 100000, stage: 1 }),
    );
    expect(tx.agentMaster.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentCode: 'AG-0099',
          agentStatus: 'ACTIVE',
          approvedTradingCapital: 100000,
        }),
      }),
    );
    expect(tx.agentOnboardingRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PROVISIONED', agentId: expect.any(String) }) }),
    );
  });

  it('two-level band: stage 1 approval only advances the stage — no agent is provisioned yet', async () => {
    const tx = makeTx({ request: { ...baseRequest, requestedTradingCapital: 300000 } });
    const postingAuthority = makePostingAuthority({ hasNextStage: true });
    const service = new AgentOnboardingService(makePrisma(tx), postingAuthority);

    await service.approveOnboarding(TENANT, REQUEST_ID, 'user-1');

    expect(tx.agentOnboardingRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { currentApprovalStage: 2 } }),
    );
    expect(tx.agentMaster.create).not.toHaveBeenCalled();
  });

  it('two-level band: stage 2 approval is what actually provisions the agent', async () => {
    const tx = makeTx({ request: { ...baseRequest, requestedTradingCapital: 300000, currentApprovalStage: 2 } });
    const postingAuthority = makePostingAuthority({ hasNextStage: false });
    const service = new AgentOnboardingService(makePrisma(tx), postingAuthority);

    await service.approveOnboarding(TENANT, REQUEST_ID, 'user-2');

    expect(postingAuthority.checkApprovalAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 2 }),
    );
    expect(tx.agentMaster.create).toHaveBeenCalled();
    expect(tx.agentOnboardingRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PROVISIONED' }) }),
    );
  });
});

describe('AgentOnboardingService.rejectOnboarding', () => {
  const baseRequest = {
    onboardingRequestId: REQUEST_ID,
    status: 'PENDING_APPROVAL',
    currentApprovalStage: 1,
    agentCode: 'AG-0099',
    requestedTradingCapital: 100000,
  };

  it('requires the same tier-check as approve, and never provisions an agent', async () => {
    const tx = makeTx({ request: baseRequest });
    const postingAuthority = makePostingAuthority();
    const service = new AgentOnboardingService(makePrisma(tx), postingAuthority);

    await service.rejectOnboarding(TENANT, REQUEST_ID, 'user-1');

    expect(postingAuthority.checkApprovalAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ moduleName: 'SALES', transactionType: 'AGENT_ONBOARDING', amount: 100000, stage: 1 }),
    );
    expect(tx.agentMaster.create).not.toHaveBeenCalled();
    expect(tx.agentOnboardingRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'REJECTED', pendingApproverRoleId: null } }),
    );
  });

  it('rejects a request that is not pending approval', async () => {
    const tx = makeTx({ request: { ...baseRequest, status: 'REJECTED' } });
    const service = new AgentOnboardingService(makePrisma(tx), makePostingAuthority());

    await expect(service.rejectOnboarding(TENANT, REQUEST_ID, 'user-1')).rejects.toThrow(BadRequestException);
  });
});
