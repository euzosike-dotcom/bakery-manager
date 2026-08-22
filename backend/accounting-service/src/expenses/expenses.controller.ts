import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { ExpensesService } from './expenses.service';
import { CreateExpenseCategoryDto } from './dto/expense-category.dto';
import { CreateExpenseRequestDto } from './dto/expense-request.dto';

@Controller('expense-categories')
export class ExpenseCategoriesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  findAll(@CurrentTenant() tenant: TenantContext) {
    return this.expenses.findAllCategories(tenant.tenantId);
  }

  @Post()
  create(@CurrentTenant() tenant: TenantContext, @Body() dto: CreateExpenseCategoryDto) {
    return this.expenses.createCategory(tenant.tenantId, dto);
  }

  @Post(':categoryId/deactivate')
  deactivate(@CurrentTenant() tenant: TenantContext, @Param('categoryId') categoryId: string) {
    return this.expenses.deactivateCategory(tenant.tenantId, categoryId);
  }
}

@Controller('expense-requests')
export class ExpenseRequestsController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  findAll(@CurrentTenant() tenant: TenantContext) {
    return this.expenses.findAllRequests(tenant.tenantId);
  }

  @Post()
  create(@CurrentTenant() tenant: TenantContext, @Body() dto: CreateExpenseRequestDto) {
    return this.expenses.createExpenseRequest(tenant.tenantId, dto, tenant.userId);
  }

  @Post(':expenseRequestId/approve')
  approve(@CurrentTenant() tenant: TenantContext, @Param('expenseRequestId') expenseRequestId: string) {
    return this.expenses.approveExpenseRequest(tenant.tenantId, expenseRequestId, tenant.userId);
  }

  @Post(':expenseRequestId/reject')
  reject(@CurrentTenant() tenant: TenantContext, @Param('expenseRequestId') expenseRequestId: string) {
    return this.expenses.rejectExpenseRequest(tenant.tenantId, expenseRequestId, tenant.userId);
  }
}
