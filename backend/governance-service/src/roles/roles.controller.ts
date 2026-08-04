import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { RolesService } from './roles.service';
import { CreateRoleDto } from './dto/role.dto';

@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Post()
  create(@CurrentTenant() tenant: TenantContext, @Body() dto: CreateRoleDto) {
    return this.roles.create(tenant.tenantId, dto);
  }

  @Get()
  findAll(@CurrentTenant() tenant: TenantContext) {
    return this.roles.findAll(tenant.tenantId);
  }
}
