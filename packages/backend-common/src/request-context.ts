import { AsyncLocalStorage } from 'async_hooks';

/**
 * Carries the current request's correlation id through whatever async
 * call chain handles it — set once by `RequestIdMiddleware` at the top
 * of the request, read by `StructuredLogger` (every log line emitted
 * while handling this request gets tagged automatically, no call site
 * has to thread it through manually) and by `PostingAuthorityClient`
 * (forwarded as `x-request-id` on its outbound call to governance-
 * service, so one request's logs can be followed across that service
 * boundary too).
 *
 * `AsyncLocalStorage` rather than a request-scoped Nest provider: this
 * needs to be readable from plain functions (the logger) that have no
 * DI context of their own, and Nest's request-scoped providers add a
 * per-request instantiation cost to every injectable in the chain that
 * this platform's request volume has no reason to pay for.
 */
export interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
