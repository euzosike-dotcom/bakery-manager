import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AuthorizationService } from './authorization.service';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../common/prisma.service';

const TENANT = 'tenant-1';
const PROCUREMENT_MGR_ROLE = 'role-procurement-mgr';
const FINANCE_CONTROLLER_ROLE = 'role-finance-controller';

function makePrisma(tx: Record<string, unknown>): PrismaService {
  return { forTenant: jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(tx)) } as unknown as PrismaService;
}

function makeAudit(): AuditService {
  return { recordEntry: jest.fn().mockResolvedValue({}) } as unknown as AuditService;
}

describe('AuthorizationService.checkAuthority', () => {
  it('authorizes a role that has the required permission flag', async () => {
    const tx = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          userId: 'user-1',
          role: { roleId: PROCUREMENT_MGR_ROLE, roleCode: 'PROCUREMENT_MGR', canPost: true },
        }),
      },
    };
    const audit = makeAudit();
    const service = new AuthorizationService(makePrisma(tx), audit);

    const result = await service.checkAuthority(TENANT, {
      userId: 'user-1',
      requiredPermission: 'can_post',
      moduleName: 'ACCOUNTING',
      recordIdRef: 'bill-1',
    });

    expect(result).toEqual({ authorized: true, roleCode: 'PROCUREMENT_MGR' });
    expect(audit.recordEntry).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ actionType: 'AUTHORIZATION_CHECK', overrideFlag: false }),
    );
  });

  it('denies and audits (override_flag=true) a role that lacks the required permission', async () => {
    const tx = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          userId: 'user-2',
          role: { roleId: 'role-clerk', roleCode: 'STORES_CLERK', canPost: false },
        }),
      },
    };
    const audit = makeAudit();
    const service = new AuthorizationService(makePrisma(tx), audit);

    await expect(
      service.checkAuthority(TENANT, {
        userId: 'user-2',
        requiredPermission: 'can_post',
        moduleName: 'ACCOUNTING',
        recordIdRef: 'bill-1',
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(audit.recordEntry).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({
        actionType: 'POSTING_AUTHORITY_DENIED',
        overrideFlag: true,
        reasonCode: 'UNAUTHORIZED_POSTING_ATTEMPT',
      }),
    );
  });

  it('treats a missing userId as an automatic denial, not a validation error', async () => {
    const tx = { user: { findUnique: jest.fn() } };
    const audit = makeAudit();
    const service = new AuthorizationService(makePrisma(tx), audit);

    await expect(
      service.checkAuthority(TENANT, {
        requiredPermission: 'can_post',
        moduleName: 'ACCOUNTING',
        recordIdRef: 'bill-1',
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(tx.user.findUnique).not.toHaveBeenCalled();
    expect(audit.recordEntry).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ reasonCode: 'UNAUTHORIZED_POSTING_ATTEMPT' }),
    );
  });
});

describe('AuthorizationService.checkApprovalAuthority', () => {
  const singleTierBand = {
    approvalLevel1RoleId: PROCUREMENT_MGR_ROLE,
    approvalLevel2RoleId: null,
    approvalLevel3RoleId: null,
  };

  it('authorizes the exact role named by the matching threshold band', async () => {
    const tx = {
      approvalMatrix: { findFirst: jest.fn().mockResolvedValue(singleTierBand) },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          userId: 'user-1',
          role: { roleId: PROCUREMENT_MGR_ROLE, roleCode: 'PROCUREMENT_MGR' },
        }),
      },
    };
    const audit = makeAudit();
    const service = new AuthorizationService(makePrisma(tx), audit);

    const result = await service.checkApprovalAuthority(TENANT, {
      userId: 'user-1',
      moduleName: 'PROCUREMENT',
      transactionType: 'PURCHASE_ORDER',
      recordIdRef: 'po-1',
      amount: 320000,
    });

    expect(result).toEqual({ authorized: true, roleCode: 'PROCUREMENT_MGR', hasNextStage: false });
  });

  it('denies a real role that is simply the wrong tier, reason INSUFFICIENT_APPROVAL_TIER', async () => {
    const tx = {
      approvalMatrix: { findFirst: jest.fn().mockResolvedValue(singleTierBand) },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          userId: 'user-2',
          role: { roleId: FINANCE_CONTROLLER_ROLE, roleCode: 'FINANCE_CONTROLLER' },
        }),
      },
    };
    const audit = makeAudit();
    const service = new AuthorizationService(makePrisma(tx), audit);

    await expect(
      service.checkApprovalAuthority(TENANT, {
        userId: 'user-2',
        moduleName: 'PROCUREMENT',
        transactionType: 'PURCHASE_ORDER',
        recordIdRef: 'po-1',
        amount: 320000,
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(audit.recordEntry).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({
        actionType: 'APPROVAL_DENIED',
        reasonCode: 'INSUFFICIENT_APPROVAL_TIER',
        overrideFlag: true,
      }),
    );
  });

  it('denies with UNAUTHORIZED_POSTING_ATTEMPT when there is no identity at all', async () => {
    const tx = {
      approvalMatrix: { findFirst: jest.fn().mockResolvedValue(singleTierBand) },
      user: { findUnique: jest.fn() },
    };
    const audit = makeAudit();
    const service = new AuthorizationService(makePrisma(tx), audit);

    await expect(
      service.checkApprovalAuthority(TENANT, {
        moduleName: 'PROCUREMENT',
        transactionType: 'PURCHASE_ORDER',
        recordIdRef: 'po-1',
        amount: 320000,
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(audit.recordEntry).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ reasonCode: 'UNAUTHORIZED_POSTING_ATTEMPT' }),
    );
  });

  it('fails closed with NO_APPROVAL_MATRIX_CONFIGURED when no band matches', async () => {
    const tx = {
      approvalMatrix: { findFirst: jest.fn().mockResolvedValue(null) },
      user: { findUnique: jest.fn() },
    };
    const audit = makeAudit();
    const service = new AuthorizationService(makePrisma(tx), audit);

    await expect(
      service.checkApprovalAuthority(TENANT, {
        userId: 'user-1',
        moduleName: 'PROCUREMENT',
        transactionType: 'PURCHASE_ORDER',
        recordIdRef: 'po-1',
        amount: 999999999,
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(audit.recordEntry).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ actionType: 'APPROVAL_DENIED', reasonCode: 'NO_APPROVAL_MATRIX_CONFIGURED' }),
    );
  });

  it('prefers a plant-specific band and short-circuits without querying the tenant-wide one', async () => {
    const plantBand = { approvalLevel1RoleId: FINANCE_CONTROLLER_ROLE, approvalLevel2RoleId: null, approvalLevel3RoleId: null };
    const findFirst = jest.fn().mockResolvedValueOnce(plantBand);
    const tx = {
      approvalMatrix: { findFirst },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          userId: 'user-1',
          role: { roleId: FINANCE_CONTROLLER_ROLE, roleCode: 'FINANCE_CONTROLLER' },
        }),
      },
    };
    const audit = makeAudit();
    const service = new AuthorizationService(makePrisma(tx), audit);

    const result = await service.checkApprovalAuthority(TENANT, {
      userId: 'user-1',
      moduleName: 'PROCUREMENT',
      transactionType: 'PURCHASE_ORDER',
      recordIdRef: 'po-1',
      amount: 100000,
      plantId: 'plant-1',
    });

    expect(result.authorized).toBe(true);
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ plantId: 'plant-1' }) }));
  });

  it('falls back to the tenant-wide band when no plant-specific one matches', async () => {
    const globalBand = { approvalLevel1RoleId: PROCUREMENT_MGR_ROLE, approvalLevel2RoleId: null, approvalLevel3RoleId: null };
    const findFirst = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(globalBand);
    const tx = {
      approvalMatrix: { findFirst },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          userId: 'user-1',
          role: { roleId: PROCUREMENT_MGR_ROLE, roleCode: 'PROCUREMENT_MGR' },
        }),
      },
    };
    const audit = makeAudit();
    const service = new AuthorizationService(makePrisma(tx), audit);

    const result = await service.checkApprovalAuthority(TENANT, {
      userId: 'user-1',
      moduleName: 'PROCUREMENT',
      transactionType: 'PURCHASE_ORDER',
      recordIdRef: 'po-1',
      amount: 100000,
      plantId: 'plant-1',
    });

    expect(result.authorized).toBe(true);
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(findFirst).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: expect.objectContaining({ plantId: null }) }));
  });

  it('treats threshold_max as an EXCLUSIVE upper bound (gt, not gte)', async () => {
    const findFirst = jest.fn().mockResolvedValue(singleTierBand);
    const tx = { approvalMatrix: { findFirst }, user: { findUnique: jest.fn().mockResolvedValue(null) } };
    const audit = makeAudit();
    const service = new AuthorizationService(makePrisma(tx), audit);

    await service
      .checkApprovalAuthority(TENANT, {
        moduleName: 'PROCUREMENT',
        transactionType: 'PURCHASE_ORDER',
        recordIdRef: 'po-1',
        amount: 500000,
      })
      .catch(() => undefined);

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          thresholdMin: { lte: 500000 },
          OR: [{ thresholdMax: null }, { thresholdMax: { gt: 500000 } }],
        }),
      }),
    );
  });

  it.each([
    [1, { approvalLevel1RoleId: 'r1', approvalLevel2RoleId: 'r2', approvalLevel3RoleId: null }, true],
    [2, { approvalLevel1RoleId: 'r1', approvalLevel2RoleId: 'r2', approvalLevel3RoleId: null }, false],
    [1, { approvalLevel1RoleId: 'r1', approvalLevel2RoleId: null, approvalLevel3RoleId: null }, false],
    [3, { approvalLevel1RoleId: 'r1', approvalLevel2RoleId: 'r2', approvalLevel3RoleId: 'r3' }, false],
  ])('resolves hasNextStage correctly for stage %i', async (stage, band, expectedHasNextStage) => {
    const roleIdForStage = [null, band.approvalLevel1RoleId, band.approvalLevel2RoleId, band.approvalLevel3RoleId][stage];
    const tx = {
      approvalMatrix: { findFirst: jest.fn().mockResolvedValue(band) },
      user: { findUnique: jest.fn().mockResolvedValue({ userId: 'u1', role: { roleId: roleIdForStage, roleCode: 'X' } }) },
    };
    const audit = makeAudit();
    const service = new AuthorizationService(makePrisma(tx), audit);

    const result = await service.checkApprovalAuthority(TENANT, {
      userId: 'u1',
      moduleName: 'PROCUREMENT',
      transactionType: 'PURCHASE_ORDER',
      recordIdRef: 'po-1',
      amount: 100,
      stage,
    });

    expect(result.hasNextStage).toBe(expectedHasNextStage);
  });

  it.each([0, 4])('rejects an out-of-range stage (%i) with BadRequestException', async (stage) => {
    const tx = { approvalMatrix: { findFirst: jest.fn() }, user: { findUnique: jest.fn() } };
    const audit = makeAudit();
    const service = new AuthorizationService(makePrisma(tx), audit);

    await expect(
      service.checkApprovalAuthority(TENANT, {
        moduleName: 'PROCUREMENT',
        transactionType: 'PURCHASE_ORDER',
        recordIdRef: 'po-1',
        amount: 100,
        stage,
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
