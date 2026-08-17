import { ForbiddenException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { M2MTokenClient } from './m2m-token.client';
import { getRequestId } from './request-context';

export type PostingPermission = 'can_approve' | 'can_post' | 'can_override';

export interface CheckAuthorityParams {
  tenantId: string;
  userId?: string;
  requiredPermission: PostingPermission;
  moduleName: string;
  recordIdRef: string;
}

export interface CheckApprovalAuthorityParams {
  tenantId: string;
  userId?: string;
  moduleName: string;
  transactionType: string;
  recordIdRef: string;
  amount: number;
  plantId?: string;
  /** Which approval_matrix level to check — defaults server-side to 1. */
  stage?: number;
}

export interface ApprovalAuthorityResult {
  authorized: true;
  roleCode?: string;
  /** Whether the resolved threshold band names a further approval level
   *  (approval_level_{stage+1}_role_id) — tells the caller whether to
   *  advance the transaction's own stage counter or finalize it. */
  hasNextStage: boolean;
}

/**
 * Thin HTTP client to governance-service's `POST /authorization-check`
 * (docs/SDD.md §4.2's "Governance warning") — the platform's FIRST
 * synchronous service-to-service call. Every other cross-service
 * interaction so far has been either a direct read-only DB query (each
 * service's own Prisma copy of another module's table) or an async
 * Kafka event; this is deliberately different, since an authorization
 * decision has to be made and audited before the caller's own posting
 * transaction proceeds — there's no sensible way to make that
 * eventually-consistent.
 *
 * Callers should treat `checkAuthority` as "throws or the caller may
 * proceed" — it never returns a boolean to check. A denial (403, thrown
 * as `ForbiddenException`) or an unreachable governance-service (thrown
 * as `ServiceUnavailableException`, fail-CLOSED — a posting action must
 * not silently proceed just because the authority check couldn't be
 * reached) both stop the caller's own posting logic from ever running.
 *
 * No circuit breaker, retry, or explicit timeout is configured — the
 * underlying `fetch` call uses whatever default applies, and a slow/down
 * governance-service will make every gated posting endpoint slow/fail
 * with it. Acceptable for now (six endpoints, one dev environment); a
 * production deployment would want this hardened, or handled by a real
 * API Gateway instead of direct service-to-service calls (see README
 * "Known gaps").
 */
@Injectable()
export class PostingAuthorityClient {
  private readonly logger = new Logger(PostingAuthorityClient.name);

  constructor(
    private readonly governanceBaseUrl: string,
    private readonly m2mTokenClient: M2MTokenClient,
  ) {}

  /**
   * Attaches this service's own real machine-to-machine bearer token
   * (docs/RUNBOOK.md's "Machine-to-machine auth" section) — proves WHICH
   * service is calling, replacing the old plain `x-tenant-id`-only
   * header that proved nothing. `x-tenant-id` still travels as data (the
   * token itself carries no tenant, since a service account isn't
   * tenant-scoped), same as before, now just gated behind that proof.
   * Also forwards the caller's own correlation id (see
   * `request-context.ts`) so one inbound request's logs can be followed
   * into governance-service's own log stream — absent outside a request
   * context (e.g. a test calling this directly), which is fine,
   * `RequestIdMiddleware` always sets one for real HTTP traffic.
   */
  private async headers(tenantId: string): Promise<Record<string, string>> {
    const requestId = getRequestId();
    const token = await this.m2mTokenClient.getToken();
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-tenant-id': tenantId,
      ...(requestId ? { 'x-request-id': requestId } : {}),
    };
  }

  async checkAuthority(params: CheckAuthorityParams): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.governanceBaseUrl}/authorization-check`, {
        method: 'POST',
        headers: await this.headers(params.tenantId),
        body: JSON.stringify({
          userId: params.userId,
          requiredPermission: params.requiredPermission,
          moduleName: params.moduleName,
          recordIdRef: params.recordIdRef,
        }),
      });
    } catch (err) {
      this.logger.error(`Could not reach governance-service for authorization check: ${(err as Error).message}`);
      throw new ServiceUnavailableException('Posting-authority check unavailable — governance-service unreachable');
    }

    if (res.ok) return;

    const body = (await res.json().catch(() => ({ message: undefined }))) as { message?: string };
    if (res.status === 403) {
      throw new ForbiddenException(body.message ?? 'Posting authority denied');
    }
    throw new ServiceUnavailableException(body.message ?? `Posting-authority check failed with status ${res.status}`);
  }

  /**
   * Calls governance-service's `POST /approval-check` — a deliberately
   * SEPARATE decision from `checkAuthority` above, not a variant of it:
   * this resolves an amount against `approval_matrix`'s threshold bands
   * to find the SPECIFIC role required to approve at this value and
   * stage, rather than checking a blanket `can_approve` flag (see
   * governance-service's `AuthorizationService.checkApprovalAuthority`
   * doc comment for why the binary flag alone can't express "which
   * tier"). Unlike `checkAuthority`, this returns data on success
   * (`hasNextStage`) rather than resolving to void — the caller needs it
   * to decide whether to advance its own transaction's approval stage or
   * finalize it.
   */
  async checkApprovalAuthority(params: CheckApprovalAuthorityParams): Promise<ApprovalAuthorityResult> {
    let res: Response;
    try {
      res = await fetch(`${this.governanceBaseUrl}/approval-check`, {
        method: 'POST',
        headers: await this.headers(params.tenantId),
        body: JSON.stringify({
          userId: params.userId,
          moduleName: params.moduleName,
          transactionType: params.transactionType,
          recordIdRef: params.recordIdRef,
          amount: params.amount,
          plantId: params.plantId,
          stage: params.stage,
        }),
      });
    } catch (err) {
      this.logger.error(`Could not reach governance-service for approval-authority check: ${(err as Error).message}`);
      throw new ServiceUnavailableException('Approval-authority check unavailable — governance-service unreachable');
    }

    if (res.ok) {
      return (await res.json()) as ApprovalAuthorityResult;
    }

    const body = (await res.json().catch(() => ({ message: undefined }))) as { message?: string };
    if (res.status === 403) {
      throw new ForbiddenException(body.message ?? 'Approval authority denied');
    }
    throw new ServiceUnavailableException(body.message ?? `Approval-authority check failed with status ${res.status}`);
  }
}
