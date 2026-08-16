import {
  CallHandler,
  Controller,
  DynamicModule,
  ExecutionContext,
  Get,
  Header,
  Inject,
  Injectable,
  Module,
  NestInterceptor,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { SkipThrottle } from '@nestjs/throttler';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

const METRICS_REGISTRY = Symbol('METRICS_REGISTRY');
const HTTP_REQUEST_COUNTER = Symbol('HTTP_REQUEST_COUNTER');
const HTTP_REQUEST_DURATION = Symbol('HTTP_REQUEST_DURATION');

/**
 * `GET /metrics` in Prometheus's text exposition format — one `Registry`
 * per service process, seeded with prom-client's `collectDefaultMetrics`
 * (process CPU/memory/event-loop-lag/GC, all free) plus a request
 * counter and duration histogram this module's own interceptor fills in
 * for every HTTP request. Every metric is labeled `service` so
 * Prometheus (`infra/prometheus/prometheus.yml`, scraping all 8 Node
 * services + ledger-service by port) can tell them apart without relying
 * on the scrape target address alone.
 *
 * `MetricsModule.forRoot(serviceName)` (a dynamic module, same pattern
 * `ThrottlerModule.forRoot(...)` already uses in `rate-limit.module.ts`)
 * rather than a plain static module — the service name has to come from
 * each consuming service, this module can't know it on its own.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(
    @Inject(HTTP_REQUEST_COUNTER) private readonly requestCounter: Counter<string>,
    @Inject(HTTP_REQUEST_DURATION) private readonly requestDuration: Histogram<string>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const start = process.hrtime.bigint();
    // req.route is only populated once Nest's router has matched a
    // handler — undefined for a 404, which is fine, those get labeled
    // by their raw path rather than a route template.
    const route = () => (req.route?.path as string | undefined) ?? req.path;

    return next.handle().pipe(
      tap({
        next: () => this.record(req.method, route(), res.statusCode, start),
        error: () => this.record(req.method, route(), res.statusCode || 500, start),
      }),
    );
  }

  private record(method: string, route: string, statusCode: number, start: bigint) {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const labels = { method, route, status_code: String(statusCode) };
    this.requestCounter.inc(labels);
    this.requestDuration.observe(labels, seconds);
  }
}

@SkipThrottle()
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS_REGISTRY) private readonly registry: Registry) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(): Promise<string> {
    return this.registry.metrics();
  }
}

@Module({})
export class MetricsModule {
  static forRoot(serviceName: string): DynamicModule {
    const registry = new Registry();
    registry.setDefaultLabels({ service: serviceName });
    collectDefaultMetrics({ register: registry });

    const requestCounter = new Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests handled',
      labelNames: ['method', 'route', 'status_code'],
      registers: [registry],
    });
    const requestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    });

    return {
      module: MetricsModule,
      controllers: [MetricsController],
      providers: [
        { provide: METRICS_REGISTRY, useValue: registry },
        { provide: HTTP_REQUEST_COUNTER, useValue: requestCounter },
        { provide: HTTP_REQUEST_DURATION, useValue: requestDuration },
        { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
      ],
      exports: [METRICS_REGISTRY],
    };
  }
}
