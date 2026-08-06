import { BadRequestException, NotFoundException } from '@nestjs/common';
import { KafkaProducerService, PostingAuthorityClient } from '@metrock/backend-common';
import { PayrollService } from './payroll.service';
import { PrismaService } from '../common/prisma.service';

const TENANT = 'tenant-1';

function makePrisma(tx: Record<string, unknown>): PrismaService {
  return { forTenant: jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(tx)) } as unknown as PrismaService;
}

function makeKafka(): KafkaProducerService {
  return { publish: jest.fn().mockResolvedValue(undefined) } as unknown as KafkaProducerService;
}

function makePostingAuthority(): PostingAuthorityClient {
  return { checkAuthority: jest.fn().mockResolvedValue(undefined) } as unknown as PostingAuthorityClient;
}

describe('PayrollService.calculateRun — Payroll Pool = Plant Revenue x Payroll Ratio', () => {
  it('computes payroll pool from confirmed sales orders in the period, and per-employee salary from grade weight', async () => {
    const created: { payrollRun?: unknown; records: unknown[] } = { records: [] };
    const tx = {
      payrollRun: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => {
          created.payrollRun = data;
          return data;
        }),
      },
      plant: { findUnique: jest.fn().mockResolvedValue({ payrollRatio: 0.1 }) },
      salesOrder: {
        // 200,000 + 300,000 confirmed revenue within the period.
        findMany: jest.fn().mockResolvedValue([{ totalOrderValue: 200000 }, { totalOrderValue: 300000 }]),
      },
      employee: {
        findMany: jest.fn().mockResolvedValue([
          { employeeId: 'emp-1', grade: { gradeWeight: 0.6 } },
          { employeeId: 'emp-2', grade: { gradeWeight: 0.4 } },
        ]),
      },
      payrollRecord: { create: jest.fn().mockImplementation(({ data }) => created.records.push(data)) },
    };
    const service = new PayrollService(makePrisma(tx), makeKafka(), makePostingAuthority());

    await service.calculateRun(TENANT, { plantId: 'plant-1', payrollPeriod: '2026-07' });

    // Plant revenue 500,000 x ratio 0.1 = payroll pool 50,000.
    expect((created.payrollRun as { totalPayrollPool: number }).totalPayrollPool).toBe(50000);
    expect(created.records).toEqual([
      expect.objectContaining({ employeeId: 'emp-1', grossSalary: 30000 }), // 50,000 x 0.6
      expect.objectContaining({ employeeId: 'emp-2', grossSalary: 20000 }), // 50,000 x 0.4
    ]);
  });

  it('rejects creating a second payroll run for the same plant and period', async () => {
    const tx = { payrollRun: { findUnique: jest.fn().mockResolvedValue({ payrollRunId: 'existing-run' }) } };
    const service = new PayrollService(makePrisma(tx), makeKafka(), makePostingAuthority());

    await expect(service.calculateRun(TENANT, { plantId: 'plant-1', payrollPeriod: '2026-07' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('404s when the plant does not exist', async () => {
    const tx = {
      payrollRun: { findUnique: jest.fn().mockResolvedValue(null) },
      plant: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const service = new PayrollService(makePrisma(tx), makeKafka(), makePostingAuthority());

    await expect(service.calculateRun(TENANT, { plantId: 'missing-plant', payrollPeriod: '2026-07' })).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('PayrollService.postRun', () => {
  it('checks posting authority before posting, and publishes payroll.run_posted.v1 with the net salary total', async () => {
    const tx = {
      payrollRun: {
        findUnique: jest.fn().mockResolvedValue({
          payrollRunId: 'run-1',
          payrollStatus: 'CALCULATED',
          plantId: 'plant-1',
          records: [{ netSalary: 30000 }, { netSalary: 20000 }],
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const kafka = makeKafka();
    const postingAuthority = makePostingAuthority();
    const service = new PayrollService(makePrisma(tx), kafka, postingAuthority);

    const result = await service.postRun(TENANT, 'run-1', 'user-1');

    expect(postingAuthority.checkAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ requiredPermission: 'can_post', moduleName: 'HR' }),
    );
    expect(result.netSalaryTotal).toBe(50000);
    expect(kafka.publish).toHaveBeenCalledWith(TENANT, 'payroll.run_posted.v1', expect.objectContaining({ net_salary_total: 50000 }));
  });

  it('rejects posting a run that is already POSTED', async () => {
    const tx = {
      payrollRun: {
        findUnique: jest.fn().mockResolvedValue({ payrollRunId: 'run-1', payrollStatus: 'POSTED', records: [] }),
      },
    };
    const service = new PayrollService(makePrisma(tx), makeKafka(), makePostingAuthority());

    await expect(service.postRun(TENANT, 'run-1', 'user-1')).rejects.toThrow(BadRequestException);
  });
});
