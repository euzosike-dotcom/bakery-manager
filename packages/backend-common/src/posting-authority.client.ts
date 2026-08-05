import { ForbiddenException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

export type PostingPermission = 'can_approve' | 'can_post' | 'can_override';

export interface CheckAuthorityParams {
  tenantId: string;
  userId?: string;
  requiredPermission: PostingPermission;
  moduleName: string;
  recordIdRef: string;
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

  constructor(private readonly governanceBaseUrl: string) {}

  async checkAuthority(params: CheckAuthorityParams): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.governanceBaseUrl}/authorization-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': params.tenantId },
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
}
