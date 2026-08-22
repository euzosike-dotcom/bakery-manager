import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PostingAuthorityClient } from '@metrock/backend-common';
import { PrismaService } from '../common/prisma.service';
import { CreateExpenseCategoryDto } from './dto/expense-category.dto';
import { CreateExpenseRequestDto } from './dto/expense-request.dto';

const ACCOUNTS_PAYABLE = '2110';

/**
 * Expense Management (explicit user request): expense requests, amount-
 * routed approval, booking to the chart of accounts, and configurable
 * expense categories. An expense request's own posting is a direct write
 * into journal_entries/journal_lines, exactly like a manual journal entry
 * (JournalsService) — there's no source domain event to react to via
 * Kafka, the request itself IS the operator-initiated proposal.
 *
 * Same PENDING_APPROVAL/POSTED/REJECTED + current_approval_stage/
 * pending_approver_role_id shape, and the same rule every approval_matrix
 * module in this platform follows: creation calls no authority check at
 * all, only approve/reject do, via checkApprovalAuthority, and reject
 * requires the identical tier-check as approve (migration 022's journal
 * entries, procurement-service's PO approve/reject).
 */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postingAuthority: PostingAuthorityClient,
  ) {}

  async createCategory(tenantId: string, dto: CreateExpenseCategoryDto) {
    // A category that books against a non-EXPENSE account (or an account
    // that doesn't exist at all) would silently corrupt whatever report
    // reads chart_of_accounts by account_type — checked here, not left to
    // whatever eventually posts the first request against it.
    const account = await this.prisma.forTenant(tenantId, (tx) =>
      tx.chartOfAccount.findUnique({ where: { tenantId_accountCode: { tenantId, accountCode: dto.glAccountCode } } }),
    );
    if (!account) {
      throw new BadRequestException(`Account ${dto.glAccountCode} does not exist in the chart of accounts`);
    }
    if (account.accountType !== 'EXPENSE') {
      throw new BadRequestException(
        `Account ${dto.glAccountCode} is ${account.accountType}, not EXPENSE — an expense category must book to an EXPENSE account`,
      );
    }

    return this.prisma.forTenant(tenantId, (tx) =>
      tx.expenseCategory.create({
        data: {
          tenantId,
          categoryId: randomUUID(),
          categoryName: dto.categoryName,
          glAccountCode: dto.glAccountCode,
        },
      }),
    );
  }

  findAllCategories(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) => tx.expenseCategory.findMany({ where: { tenantId } }));
  }

  async deactivateCategory(tenantId: string, categoryId: string) {
    const category = await this.prisma.forTenant(tenantId, (tx) =>
      tx.expenseCategory.findUnique({ where: { tenantId_categoryId: { tenantId, categoryId } } }),
    );
    if (!category) throw new NotFoundException(`Expense category ${categoryId} not found`);

    return this.prisma.forTenant(tenantId, (tx) =>
      tx.expenseCategory.update({
        where: { tenantId_categoryId: { tenantId, categoryId } },
        data: { isActive: false },
      }),
    );
  }

  async createExpenseRequest(tenantId: string, dto: CreateExpenseRequestDto, userId: string | undefined) {
    const category = await this.prisma.forTenant(tenantId, (tx) =>
      tx.expenseCategory.findUnique({ where: { tenantId_categoryId: { tenantId, categoryId: dto.categoryId } } }),
    );
    if (!category) throw new BadRequestException(`Expense category ${dto.categoryId} not found`);
    if (!category.isActive) throw new BadRequestException(`Expense category ${dto.categoryId} is not active`);

    return this.prisma.forTenant(tenantId, (tx) =>
      tx.expenseRequest.create({
        data: {
          tenantId,
          expenseRequestId: randomUUID(),
          categoryId: dto.categoryId,
          amount: dto.amount,
          description: dto.description,
          submittedByUserId: userId,
          status: 'PENDING_APPROVAL',
        },
        include: { category: true },
      }),
    );
  }

  findAllRequests(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.expenseRequest.findMany({ where: { tenantId }, include: { category: true }, orderBy: { createdAt: 'desc' } }),
    );
  }

  async approveExpenseRequest(tenantId: string, expenseRequestId: string, userId: string | undefined) {
    const request = await this.prisma.forTenant(tenantId, (tx) =>
      tx.expenseRequest.findUnique({
        where: { tenantId_expenseRequestId: { tenantId, expenseRequestId } },
        include: { category: true },
      }),
    );
    if (!request) throw new NotFoundException(`Expense request ${expenseRequestId} not found`);
    if (request.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(`Expense request ${expenseRequestId} is not pending approval (status=${request.status})`);
    }

    const result = await this.postingAuthority.checkApprovalAuthority({
      tenantId,
      userId,
      moduleName: 'ACCOUNTING',
      transactionType: 'EXPENSE_REQUEST',
      recordIdRef: expenseRequestId,
      amount: Number(request.amount),
      stage: request.currentApprovalStage,
    });

    if (result.hasNextStage) {
      return this.prisma.forTenant(tenantId, (tx) =>
        tx.expenseRequest.update({
          where: { tenantId_expenseRequestId: { tenantId, expenseRequestId } },
          data: { currentApprovalStage: request.currentApprovalStage + 1 },
          include: { category: true },
        }),
      );
    }

    // Final stage: book it. Dr the category's own EXPENSE account, Cr
    // Accounts Payable (2110, already seeded since Procurement's first
    // slice) — the expense becomes a payable owed to whoever incurred it,
    // actual cash payment is a separate later step, same shape as Fleet's
    // maintenance-completion posting and Procurement's GRN posting.
    const journalEntryId = randomUUID();
    return this.prisma.forTenant(tenantId, async (tx) => {
      await tx.journalEntry.create({
        data: {
          tenantId,
          journalEntryId,
          sourceEventId: randomUUID(),
          sourceModule: 'accounting_expense',
          postingDate: new Date(),
          status: 'POSTED',
          memo: request.description ?? `Expense: ${request.category.categoryName}`,
        },
      });
      await tx.journalLine.create({
        data: {
          tenantId,
          journalLineId: randomUUID(),
          journalEntryId,
          accountCode: request.category.glAccountCode,
          debitAmount: request.amount,
          creditAmount: 0,
        },
      });
      await tx.journalLine.create({
        data: {
          tenantId,
          journalLineId: randomUUID(),
          journalEntryId,
          accountCode: ACCOUNTS_PAYABLE,
          debitAmount: 0,
          creditAmount: request.amount,
        },
      });

      return tx.expenseRequest.update({
        where: { tenantId_expenseRequestId: { tenantId, expenseRequestId } },
        data: { status: 'POSTED', pendingApproverRoleId: null, journalEntryId },
        include: { category: true },
      });
    });
  }

  async rejectExpenseRequest(tenantId: string, expenseRequestId: string, userId: string | undefined) {
    const request = await this.prisma.forTenant(tenantId, (tx) =>
      tx.expenseRequest.findUnique({ where: { tenantId_expenseRequestId: { tenantId, expenseRequestId } } }),
    );
    if (!request) throw new NotFoundException(`Expense request ${expenseRequestId} not found`);
    if (request.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(`Expense request ${expenseRequestId} is not pending approval (status=${request.status})`);
    }

    // Rejecting requires the SAME approval-tier gate as approving — see
    // procurement-service's rejectPurchaseOrder for the identical
    // reasoning: a lower-tier approver can reject what they could have
    // approved, not reject something above their own tier.
    await this.postingAuthority.checkApprovalAuthority({
      tenantId,
      userId,
      moduleName: 'ACCOUNTING',
      transactionType: 'EXPENSE_REQUEST',
      recordIdRef: expenseRequestId,
      amount: Number(request.amount),
      stage: request.currentApprovalStage,
    });

    return this.prisma.forTenant(tenantId, (tx) =>
      tx.expenseRequest.update({
        where: { tenantId_expenseRequestId: { tenantId, expenseRequestId } },
        data: { status: 'REJECTED', pendingApproverRoleId: null },
        include: { category: true },
      }),
    );
  }
}
