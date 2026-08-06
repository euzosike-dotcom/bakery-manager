import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CheckPostingAuthorityDto } from './dto/authorization.dto';
import { CheckApprovalAuthorityDto } from './dto/approval-authority.dto';

const PERMISSION_FIELD = {
  can_approve: 'canApprove',
  can_post: 'canPost',
  can_override: 'canOverride',
} as const;

interface ApprovalBand {
  approvalLevel1RoleId: string | null;
  approvalLevel2RoleId: string | null;
  approvalLevel3RoleId: string | null;
}

function roleIdForStage(band: ApprovalBand, stage: number): string | null {
  switch (stage) {
    case 1:
      return band.approvalLevel1RoleId;
    case 2:
      return band.approvalLevel2RoleId;
    case 3:
      return band.approvalLevel3RoleId;
    default:
      return null;
  }
}

/**
 * Posting-authority enforcement (docs/SDD.md §4.2's "Governance
 * warning"): "Any attempt to bypass posting-authority checks... must
 * itself be captured in audit_log with override_flag = true and a
 * mandatory reason_code, and must raise a real-time alert... an
 * authorization bypass attempt is a security event whether or not it
 * succeeds."
 *
 * This is the one place in the whole platform this check is actually
 * implemented — every other service calls out to it over HTTP (via
 * `@metrock/backend-common`'s `PostingAuthorityClient`, the platform's
 * first synchronous service-to-service call; everything else is either a
 * DB read or an async Kafka event) rather than duplicating the logic.
 * It's wired into the six ONLINE-ONLY finalization/posting endpoints
 * (NCR verify, vendor-bill payment, customer-invoice payment, manual
 * journal entry, maintenance-request completion, payroll-run posting) —
 * deliberately NOT into the offline-capturable field-capture endpoints
 * (GRN receipt, batch close, sales order creation, fuel/trip/attendance
 * capture): those are performed by operational staff (a stores clerk, a
 * production operator, a sales agent) who legitimately hold no
 * `can_post` authority, and gating them would both require a
 * synchronous online call mid-offline-capture (contradicting the
 * offline-first design) and break the already-verified capture flows
 * tested against exactly that seed data. See README "Known gaps" for the
 * full reasoning.
 *
 * Given a user and a required permission, this correctly authorizes a
 * role that has it, and — the part the SDD specifically calls out —
 * correctly DENIES, AUDITS (with `override_flag = true` and a
 * reason_code, never silently), and ALERTS on a role that doesn't, or on
 * no identity at all, rather than either silently allowing or silently
 * rejecting.
 *
 * "Raise a real-time alert" has no real alerting pipeline behind it in
 * this platform (no email/Slack/pager integration exists anywhere) — the
 * alert is a structured, distinctly-prefixed log line, the same kind of
 * documented stub as TenantContextMiddleware standing in for real
 * Keycloak auth. Swapping it for a real alert channel is a single-method
 * change here, same shape as that middleware's own doc comment promises
 * for auth.
 *
 * `checkApprovalAuthority` (below) is a DIFFERENT, stricter check than
 * `checkAuthority` above — deliberately, not redundantly. `checkAuthority`
 * answers "does this role have blanket X capability at all" (a single
 * boolean flag per role); `checkApprovalAuthority` answers "is this role
 * SPECIFICALLY the one `approval_matrix` names as the required approver
 * for THIS transaction's amount," which `can_approve` alone can't express
 * — both `PROCUREMENT_MGR` and `FINANCE_CONTROLLER` have `can_approve =
 * true` today, so the binary check alone would let either approve a
 * purchase order of any value; `approval_matrix`'s threshold bands are
 * what actually route a low-value PO to `PROCUREMENT_MGR` and a
 * high-value one to `FINANCE_CONTROLLER`, and until this method existed
 * that routing was configured, seeded, queryable data that nothing ever
 * enforced (see README "Known gaps" prior to this pass).
 */
@Injectable()
export class AuthorizationService {
  private readonly logger = new Logger(AuthorizationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async checkAuthority(tenantId: string, dto: CheckPostingAuthorityDto) {
    // No userId at all (missing x-user-id upstream) is treated exactly
    // like an unknown userId — both resolve to "no authority", never a
    // validation error. This is deliberately the SAME code path as a
    // real denial below: an anonymous caller IS the bypass-attempt
    // scenario SDD §4.2 describes, not a separate case to special-case
    // around.
    const user = dto.userId
      ? await this.prisma.forTenant(tenantId, (tx) =>
          tx.user.findUnique({ where: { tenantId_userId: { tenantId, userId: dto.userId! } }, include: { role: true } }),
        )
      : null;

    const permissionField = PERMISSION_FIELD[dto.requiredPermission];
    const authorized = user?.role ? Boolean(user.role[permissionField]) : false;

    if (authorized) {
      await this.audit.recordEntry(tenantId, {
        userId: dto.userId,
        moduleName: dto.moduleName,
        recordIdRef: dto.recordIdRef,
        actionType: 'AUTHORIZATION_CHECK',
        newValueSnapshot: { requiredPermission: dto.requiredPermission, result: 'AUTHORIZED' },
        overrideFlag: false,
      });
      return { authorized: true, roleCode: user?.role?.roleCode };
    }

    await this.audit.recordEntry(tenantId, {
      userId: dto.userId,
      moduleName: dto.moduleName,
      recordIdRef: dto.recordIdRef,
      actionType: 'POSTING_AUTHORITY_DENIED',
      newValueSnapshot: {
        requiredPermission: dto.requiredPermission,
        roleCode: user?.role?.roleCode ?? null,
        result: 'DENIED',
      },
      overrideFlag: true,
      reasonCode: 'UNAUTHORIZED_POSTING_ATTEMPT',
    });

    // Stand-in for a real alerting pipeline — see class doc comment.
    this.logger.error(
      `ALERT: user=${dto.userId ?? 'UNKNOWN'} role=${user?.role?.roleCode ?? 'NONE'} attempted ${dto.requiredPermission} ` +
        `on ${dto.moduleName}/${dto.recordIdRef} without authority — audited with override_flag=true`,
    );

    throw new ForbiddenException(
      `User ${dto.userId ?? 'UNKNOWN'} (role ${user?.role?.roleCode ?? 'none'}) lacks ${dto.requiredPermission} authority for ${dto.moduleName}`,
    );
  }

  async checkApprovalAuthority(tenantId: string, dto: CheckApprovalAuthorityDto) {
    const stage = dto.stage ?? 1;
    if (stage < 1 || stage > 3) {
      throw new BadRequestException(`stage must be 1, 2, or 3 (got ${stage})`);
    }

    const bandWhere = {
      tenantId,
      moduleName: dto.moduleName,
      transactionType: dto.transactionType,
      isActive: true,
      thresholdMin: { lte: dto.amount },
      OR: [{ thresholdMax: null }, { thresholdMax: { gt: dto.amount } }],
    };

    // Prefer a plant-specific band over the tenant-wide one when both
    // could apply — not exercised by any currently-seeded data (every
    // approval_matrix row today has plant_id NULL), but the schema
    // supports plant scoping and procurement-service has a real plantId
    // to pass (the PO's own plant_id), so this is genuine schema
    // support, not speculative complexity for a hypothetical case.
    const band = await this.prisma.forTenant(tenantId, async (tx) => {
      if (dto.plantId) {
        const plantSpecific = await tx.approvalMatrix.findFirst({ where: { ...bandWhere, plantId: dto.plantId } });
        if (plantSpecific) return plantSpecific;
      }
      return tx.approvalMatrix.findFirst({ where: { ...bandWhere, plantId: null } });
    });

    const user = dto.userId
      ? await this.prisma.forTenant(tenantId, (tx) =>
          tx.user.findUnique({ where: { tenantId_userId: { tenantId, userId: dto.userId! } }, include: { role: true } }),
        )
      : null;

    if (!band) {
      await this.audit.recordEntry(tenantId, {
        userId: dto.userId,
        moduleName: dto.moduleName,
        recordIdRef: dto.recordIdRef,
        actionType: 'APPROVAL_DENIED',
        newValueSnapshot: { amount: dto.amount, stage, result: 'DENIED', reason: 'no matching approval_matrix band' },
        overrideFlag: true,
        reasonCode: 'NO_APPROVAL_MATRIX_CONFIGURED',
      });
      this.logger.error(
        `ALERT: no approval_matrix band configured for ${dto.moduleName}/${dto.transactionType} amount=${dto.amount} ` +
          `stage=${stage} — denying by default rather than silently allowing`,
      );
      throw new ForbiddenException(
        `No approval_matrix threshold band configured for ${dto.moduleName}/${dto.transactionType} at amount ${dto.amount}`,
      );
    }

    const requiredRoleId = roleIdForStage(band, stage);
    const authorized = requiredRoleId !== null && user?.role?.roleId === requiredRoleId;
    const hasNextStage = stage < 3 && roleIdForStage(band, stage + 1) !== null;

    if (authorized) {
      await this.audit.recordEntry(tenantId, {
        userId: dto.userId,
        moduleName: dto.moduleName,
        recordIdRef: dto.recordIdRef,
        actionType: 'APPROVAL_CHECK',
        newValueSnapshot: { amount: dto.amount, stage, roleCode: user?.role?.roleCode, result: 'AUTHORIZED' },
        overrideFlag: false,
      });
      return { authorized: true, roleCode: user?.role?.roleCode, hasNextStage };
    }

    // A real role that just isn't the one this threshold band names is a
    // meaningfully different situation from no identity at all — distinct
    // reason_code so the audit trail actually says which happened.
    const reasonCode = user?.role ? 'INSUFFICIENT_APPROVAL_TIER' : 'UNAUTHORIZED_POSTING_ATTEMPT';

    await this.audit.recordEntry(tenantId, {
      userId: dto.userId,
      moduleName: dto.moduleName,
      recordIdRef: dto.recordIdRef,
      actionType: 'APPROVAL_DENIED',
      newValueSnapshot: {
        amount: dto.amount,
        stage,
        roleCode: user?.role?.roleCode ?? null,
        requiredRoleId: requiredRoleId ?? null,
        result: 'DENIED',
      },
      overrideFlag: true,
      reasonCode,
    });

    this.logger.error(
      `ALERT: user=${dto.userId ?? 'UNKNOWN'} role=${user?.role?.roleCode ?? 'NONE'} attempted to approve ` +
        `${dto.moduleName}/${dto.recordIdRef} (amount=${dto.amount}, stage=${stage}) without the required approval ` +
        `tier — audited with override_flag=true`,
    );

    throw new ForbiddenException(
      `User ${dto.userId ?? 'UNKNOWN'} (role ${user?.role?.roleCode ?? 'none'}) is not authorized to approve ` +
        `${dto.moduleName}/${dto.transactionType} at amount ${dto.amount} (stage ${stage})`,
    );
  }
}
