import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { TenantContext } from './tenant-context.middleware';

export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantContext => {
    const req = ctx.switchToHttp().getRequest();
    if (!req.tenantContext) {
      throw new UnauthorizedException('Tenant context not resolved');
    }
    return req.tenantContext;
  },
);
