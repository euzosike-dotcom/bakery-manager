import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CheckPostingAuthorityDto } from './dto/authorization.dto';

const PERMISSION_FIELD = {
  can_approve: 'canApprove',
  can_post: 'canPost',
  can_override: 'canOverride',
} as const;

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
}
