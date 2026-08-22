import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PostingAuthorityClient } from '@metrock/backend-common';
import { ExpensesService } from './expenses.service';
import { PrismaService } from '../common/prisma.service';

const TENANT = 'tenant-1';
const CATEGORY_ID = 'category-1';
const REQUEST_ID = 'request-1';

function makePrisma(tx: Record<string, unknown>): PrismaService {
  return { forTenant: jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(tx)) } as unknown as PrismaService;
}

function makePostingAuthority(result: { hasNextStage: boolean } = { hasNextStage: false }): PostingAuthorityClient {
  return { checkApprovalAuthority: jest.fn().mockResolvedValue(result) } as unknown as PostingAuthorityClient;
}

function makeTx(overrides: {
  account?: { accountType: string } | null;
  category?: { categoryId: string; categoryName: string; glAccountCode: string; isActive: boolean } | null;
  request?: Record<string, unknown> | null;
} = {}) {
  const journalLines: Array<{ accountCode: string; debitAmount: number; creditAmount: number }> = [];
  let journalEntryCreated: Record<string, unknown> | undefined;

  return {
    chartOfAccount: {
      findUnique: jest.fn().mockResolvedValue(overrides.account ?? null),
    },
    expenseCategory: {
      create: jest.fn().mockImplementation(({ data }) => data),
      findUnique: jest.fn().mockResolvedValue(overrides.category ?? null),
      update: jest.fn().mockImplementation(({ data }) => ({ ...overrides.category, ...data })),
    },
    expenseRequest: {
      create: jest.fn().mockImplementation(({ data }) => data),
      findUnique: jest.fn().mockResolvedValue(overrides.request ?? null),
      update: jest.fn().mockImplementation(({ data }) => ({ ...overrides.request, ...data })),
    },
    journalEntry: {
      create: jest.fn().mockImplementation(({ data }) => {
        journalEntryCreated = data;
      }),
    },
    journalLine: {
      create: jest.fn().mockImplementation(({ data }) => {
        journalLines.push({ accountCode: data.accountCode, debitAmount: Number(data.debitAmount), creditAmount: Number(data.creditAmount) });
      }),
    },
    _journalLines: journalLines,
    _journalEntryCreated: () => journalEntryCreated,
  };
}

describe('ExpensesService.createCategory', () => {
  it('rejects when the GL account does not exist', async () => {
    const tx = makeTx({ account: null });
    const service = new ExpensesService(makePrisma(tx), makePostingAuthority());

    await expect(
      service.createCategory(TENANT, { categoryName: 'Travel', glAccountCode: '9999' }),
    ).rejects.toThrow(BadRequestException);
    expect(tx.expenseCategory.create).not.toHaveBeenCalled();
  });

  it('rejects when the GL account is not an EXPENSE account', async () => {
    const tx = makeTx({ account: { accountType: 'ASSET' } });
    const service = new ExpensesService(makePrisma(tx), makePostingAuthority());

    await expect(
      service.createCategory(TENANT, { categoryName: 'Travel', glAccountCode: '1100' }),
    ).rejects.toThrow(BadRequestException);
    expect(tx.expenseCategory.create).not.toHaveBeenCalled();
  });

  it('creates the category when the GL account is a real EXPENSE account', async () => {
    const tx = makeTx({ account: { accountType: 'EXPENSE' } });
    const service = new ExpensesService(makePrisma(tx), makePostingAuthority());

    await service.createCategory(TENANT, { categoryName: 'Travel', glAccountCode: '5350' });
    expect(tx.expenseCategory.create).toHaveBeenCalled();
  });
});

describe('ExpensesService.createExpenseRequest', () => {
  it('rejects when the category does not exist', async () => {
    const tx = makeTx({ category: null });
    const service = new ExpensesService(makePrisma(tx), makePostingAuthority());

    await expect(
      service.createExpenseRequest(TENANT, { categoryId: CATEGORY_ID, amount: 5000 }, 'user-1'),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects when the category has been deactivated', async () => {
    const tx = makeTx({ category: { categoryId: CATEGORY_ID, categoryName: 'Travel', glAccountCode: '5350', isActive: false } });
    const service = new ExpensesService(makePrisma(tx), makePostingAuthority());

    await expect(
      service.createExpenseRequest(TENANT, { categoryId: CATEGORY_ID, amount: 5000 }, 'user-1'),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('ExpensesService.approveExpenseRequest', () => {
  const category = { categoryId: CATEGORY_ID, categoryName: 'Office Supplies', glAccountCode: '5350', isActive: true };

  it('rejects a request that is not pending approval', async () => {
    const tx = makeTx({ request: { expenseRequestId: REQUEST_ID, status: 'POSTED', currentApprovalStage: 1, amount: 5000, category } });
    const service = new ExpensesService(makePrisma(tx), makePostingAuthority());

    await expect(service.approveExpenseRequest(TENANT, REQUEST_ID, 'user-1')).rejects.toThrow(BadRequestException);
  });

  it('404s on an unknown request', async () => {
    const tx = makeTx({ request: null });
    const service = new ExpensesService(makePrisma(tx), makePostingAuthority());

    await expect(service.approveExpenseRequest(TENANT, REQUEST_ID, 'user-1')).rejects.toThrow(NotFoundException);
  });

  it('only advances the stage, with no GL posting, when a further approval stage is required', async () => {
    const tx = makeTx({
      request: { expenseRequestId: REQUEST_ID, status: 'PENDING_APPROVAL', currentApprovalStage: 1, amount: 5000, category },
    });
    const postingAuthority = makePostingAuthority({ hasNextStage: true });
    const service = new ExpensesService(makePrisma(tx), postingAuthority);

    await service.approveExpenseRequest(TENANT, REQUEST_ID, 'user-1');

    expect(tx.expenseRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { currentApprovalStage: 2 } }),
    );
    expect(tx.journalEntry.create).not.toHaveBeenCalled();
  });

  it('books Dr the category GL account / Cr Accounts Payable and marks the request POSTED on final-stage approval', async () => {
    const tx = makeTx({
      request: { expenseRequestId: REQUEST_ID, status: 'PENDING_APPROVAL', currentApprovalStage: 1, amount: 12000, category },
    });
    const postingAuthority = makePostingAuthority({ hasNextStage: false });
    const service = new ExpensesService(makePrisma(tx), postingAuthority);

    await service.approveExpenseRequest(TENANT, REQUEST_ID, 'user-1');

    expect(postingAuthority.checkApprovalAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ moduleName: 'ACCOUNTING', transactionType: 'EXPENSE_REQUEST', amount: 12000, stage: 1 }),
    );
    expect(tx._journalLines).toEqual([
      { accountCode: '5350', debitAmount: 12000, creditAmount: 0 },
      { accountCode: '2110', debitAmount: 0, creditAmount: 12000 },
    ]);
    expect(tx.expenseRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'POSTED', journalEntryId: expect.any(String) }) }),
    );
  });
});

describe('ExpensesService.rejectExpenseRequest', () => {
  const category = { categoryId: CATEGORY_ID, categoryName: 'Office Supplies', glAccountCode: '5350', isActive: true };

  it('requires the same tier-check as approve, and never touches the ledger', async () => {
    const tx = makeTx({
      request: { expenseRequestId: REQUEST_ID, status: 'PENDING_APPROVAL', currentApprovalStage: 1, amount: 12000, category },
    });
    const postingAuthority = makePostingAuthority();
    const service = new ExpensesService(makePrisma(tx), postingAuthority);

    await service.rejectExpenseRequest(TENANT, REQUEST_ID, 'user-1');

    expect(postingAuthority.checkApprovalAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ moduleName: 'ACCOUNTING', transactionType: 'EXPENSE_REQUEST', amount: 12000, stage: 1 }),
    );
    expect(tx.journalEntry.create).not.toHaveBeenCalled();
    expect(tx.expenseRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'REJECTED', pendingApproverRoleId: null } }),
    );
  });

  it('rejects a request that is not pending approval', async () => {
    const tx = makeTx({ request: { expenseRequestId: REQUEST_ID, status: 'REJECTED', currentApprovalStage: 1, amount: 5000, category } });
    const service = new ExpensesService(makePrisma(tx), makePostingAuthority());

    await expect(service.rejectExpenseRequest(TENANT, REQUEST_ID, 'user-1')).rejects.toThrow(BadRequestException);
  });
});
