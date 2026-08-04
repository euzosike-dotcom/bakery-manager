import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/user.dto';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  create(@CurrentTenant() tenant: TenantContext, @Body() dto: CreateUserDto) {
    return this.users.create(tenant.tenantId, dto);
  }

  @Get()
  findAll(@CurrentTenant() tenant: TenantContext) {
    return this.users.findAll(tenant.tenantId);
  }
}
