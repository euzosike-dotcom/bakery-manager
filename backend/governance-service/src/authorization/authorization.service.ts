import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
 * This is the one place in the whole platform that check is actually
 * implemented and enforced — the other seven domain services' posting
 * endpoints (GRN, batch close, sales order, bill/invoice payment, fuel/
 * maintenance, payroll run) do NOT call this before posting; retrofitting
 * it into all of them is real, honest, out-of-scope work (see README
 * "Known gaps"), not something this slice quietly assumes is already
 * true elsewhere. What's proven here is the mechanism itself: given a
 * user and a required permission, it correctly authorizes a role that
 * has it, and — the part the SDD specifically calls out — correctly
 * DENIES, AUDITS (with `override_flag = true` and a reason_code, never
 * silently), and ALERTS on a role that doesn't, rather than either
 * silently allowing or silently rejecting.
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
    const user = await this.prisma.forTenant(tenantId, (tx) =>
      tx.user.findUnique({ where: { tenantId_userId: { tenantId, userId: dto.userId } }, include: { role: true } }),
    );
    if (!user) throw new NotFoundException(`User ${dto.userId} not found`);

    const permissionField = PERMISSION_FIELD[dto.requiredPermission];
    const authorized = user.role ? Boolean(user.role[permissionField]) : false;

    if (authorized) {
      await this.audit.recordEntry(tenantId, {
        userId: dto.userId,
        moduleName: dto.moduleName,
        recordIdRef: dto.recordIdRef,
        actionType: 'AUTHORIZATION_CHECK',
        newValueSnapshot: { requiredPermission: dto.requiredPermission, result: 'AUTHORIZED' },
        overrideFlag: false,
      });
      return { authorized: true, roleCode: user.role?.roleCode };
    }

    await this.audit.recordEntry(tenantId, {
      userId: dto.userId,
      moduleName: dto.moduleName,
      recordIdRef: dto.recordIdRef,
      actionType: 'POSTING_AUTHORITY_DENIED',
      newValueSnapshot: {
        requiredPermission: dto.requiredPermission,
        roleCode: user.role?.roleCode ?? null,
        result: 'DENIED',
      },
      overrideFlag: true,
      reasonCode: 'UNAUTHORIZED_POSTING_ATTEMPT',
    });

    // Stand-in for a real alerting pipeline — see class doc comment.
    this.logger.error(
      `ALERT: user=${dto.userId} role=${user.role?.roleCode ?? 'NONE'} attempted ${dto.requiredPermission} ` +
        `on ${dto.moduleName}/${dto.recordIdRef} without authority — audited with override_flag=true`,
    );

    throw new ForbiddenException(
      `User ${dto.userId} (role ${user.role?.roleCode ?? 'none'}) lacks ${dto.requiredPermission} authority for ${dto.moduleName}`,
    );
  }
}
