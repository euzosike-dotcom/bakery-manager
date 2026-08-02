import { Controller, Get } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { EmployeesService } from './employees.service';

@Controller('employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  findAll(@CurrentTenant() tenant: TenantContext) {
    return this.employees.findAll(tenant.tenantId);
  }
}
