import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { runWithRequestContext } from './request-context';

/**
 * Assigns every request a correlation id — reuses an incoming
 * `x-request-id` if the caller already set one (e.g. another service's
 * `PostingAuthorityClient` forwarding its own), otherwise generates a
 * fresh one with `crypto.randomUUID()` (Node stdlib, no new dependency
 * for something this small). Echoed back as a response header so the
 * caller can correlate too.
 *
 * MUST be applied before `KeycloakAuthMiddleware` in each service's
 * `AppModule.configure()` (register it first) — a request that fails
 * auth should still get a request id on its log line, not just the ones
 * that make it past the guard.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const requestId = req.header('x-request-id') ?? randomUUID();
    res.setHeader('x-request-id', requestId);
    runWithRequestContext({ requestId }, next);
  }
}
