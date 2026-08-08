import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';

/**
 * Every one of the 8 NestJS services' `main.ts` was byte-identical
 * boilerplate around this concern (same as `ValidationPipe` before it),
 * so it lives here once rather than 8 times — same reasoning as every
 * other shared cross-cutting concern in this package.
 *
 * Two genuinely different gaps, addressed differently:
 *
 * - `helmet()` — an ACTIVE gap: these are pure JSON APIs (no server-
 *   rendered views), so helmet's defaults are safe out of the box with no
 *   per-service CSP tuning needed. Always on.
 * - CORS — NOT an active gap today. A browser enforces same-origin by
 *   default with zero server config; nothing today calls these APIs from
 *   a browser (only the native Flutter app + curl, neither subject to
 *   CORS). Gated behind `CORS_ALLOWED_ORIGINS` (comma-separated) so it's
 *   ready — correctly, as an explicit allow-list, never a bare
 *   `app.enableCors()` (which permits every origin) — for whenever the
 *   SDD's Web Console client actually exists, without changing behavior
 *   for anyone before then. Unset means exactly what it means today:
 *   no CORS headers at all.
 */
export function applySecurityMiddleware(app: INestApplication): void {
  app.use(helmet());

  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (allowedOrigins.length > 0) {
    app.enableCors({ origin: allowedOrigins });
  }
}
