import { LoggerService, LogLevel } from '@nestjs/common';
import { inspect } from 'util';
import { getRequestId } from './request-context';

/**
 * One JSON object per line to stdout, replacing Nest's default colored/
 * pretty-printed `ConsoleLogger` — the Go `ledger-service` already logs
 * this way via `log/slog` (see its `internal/kafka/consumer.go`); this
 * brings the 8 Node services to the same baseline instead of leaving
 * them on human-formatted text that nothing can parse without a regex.
 * Deliberately hand-rolled instead of pulling in `pino`/`winston` — this
 * is ~40 lines with zero third-party dependency, matching this repo's
 * established preference (see `keycloak-auth.ts`'s doc comment on
 * choosing `jsonwebtoken`/`jwks-rsa` over `jose` for the same reason).
 *
 * `app.useLogger(new StructuredLogger('procurement-service'))` in each
 * service's `main.ts` retroactively affects every `new Logger(context)`
 * call already in that service's code, application-wide — Nest's
 * `Logger` class delegates every instance's method calls to whatever
 * `useLogger` installed (`Logger.overrideLogger`, which is what
 * `useLogger` calls internally), so no individual `Logger.log(...)`
 * call site anywhere needed to change.
 */
export class StructuredLogger implements LoggerService {
  constructor(private readonly service: string) {}

  log(message: unknown, ...optionalParams: unknown[]) {
    this.write('log', message, optionalParams);
  }
  error(message: unknown, ...optionalParams: unknown[]) {
    this.write('error', message, optionalParams);
  }
  warn(message: unknown, ...optionalParams: unknown[]) {
    this.write('warn', message, optionalParams);
  }
  debug(message: unknown, ...optionalParams: unknown[]) {
    this.write('debug', message, optionalParams);
  }
  verbose(message: unknown, ...optionalParams: unknown[]) {
    this.write('verbose', message, optionalParams);
  }
  fatal(message: unknown, ...optionalParams: unknown[]) {
    this.write('fatal', message, optionalParams);
  }

  private write(level: LogLevel, message: unknown, optionalParams: unknown[]) {
    // Nest's own calling convention: Logger.error(msg, stack?, context?),
    // every other level as (msg, ...extra, context?) — the trailing
    // string is context, and for error() specifically a second-to-last
    // string is the stack. Best-effort, not a byte-exact reimplementation
    // of Nest's internal ConsoleLogger param-sniffing.
    let context: string | undefined;
    let stack: string | undefined;
    if (level === 'error' && optionalParams.length >= 2) {
      [stack, context] = optionalParams as [string, string];
    } else if (optionalParams.length >= 1 && typeof optionalParams[optionalParams.length - 1] === 'string') {
      const last = optionalParams[optionalParams.length - 1] as string;
      if (level === 'error' && last.includes('\n')) {
        stack = last;
      } else {
        context = last;
      }
    }

    const entry = {
      level,
      message: typeof message === 'string' ? message : inspect(message, { depth: 4 }),
      service: this.service,
      context,
      stack,
      requestId: getRequestId(),
      timestamp: new Date().toISOString(),
    };
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
}
