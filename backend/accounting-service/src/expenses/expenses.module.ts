import { Module } from '@nestjs/common';
import { ExpenseCategoriesController, ExpenseRequestsController } from './expenses.controller';
import { ExpensesService } from './expenses.service';

@Module({
  controllers: [ExpenseCategoriesController, ExpenseRequestsController],
  providers: [ExpensesService],
})
export class ExpensesModule {}
