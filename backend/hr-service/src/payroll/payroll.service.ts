import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { KafkaProducerService, PostingAuthorityClient } from '@metrock/backend-common';
import { PrismaService } from '../common/prisma.service';
import { CalculatePayrollRunDto } from './dto/payroll.dto';
import { computeStatutoryDeductions, TaxBand } from './payroll-tax';

/**
 * Revenue-Based Payroll (SDD §3.F):
 *
 *   Payroll Pool     = Plant Revenue x Payroll Ratio
 *   Employee Salary  = Payroll Pool x Grade Weight(employee)
 *
 * Deliberately split into two separate, both online-only actions —
 * `calculateRun` and `postRun` — rather than one atomic action: the SDD
 * requires payroll posting to be "online-only, finance-gated... never
 * executed offline, never eligible for offline queuing" given its
 * downstream financial and legal weight, and splitting calculation from
 * posting lets a finance user review the computed numbers (same
 * `payroll_records` a real payslip run would show) before they commit to
 * the GL — mirrors NcrService's submit-then-verify split (Slice #3).
 *
 * Grade weights are NOT validated to sum to 1.0 across a plant's active
 * employees — they're tenant-configurable master data (migration 019's
 * header comment), same "configured, not enforced" pattern as Fleet's
 * fuel-variance tolerance. A misconfigured set of weights will simply
 * under- or over-allocate the pool; that's a real, documented gap, not
 * silently handled.
 *
 * netSalary = grossSalary - statutory deductions (PAYE + pension, see
 * payroll-tax.ts), computed fresh per employee at calculation time —
 * 027_statutory_payroll_deductions.sql. Both feed the same GL posting as
 * before (postRun sums net_salary, unaffected by this).
 */
@Injectable()
export class PayrollService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly postingAuthority: PostingAuthorityClient,
  ) {}

  async calculateRun(tenantId: string, dto: CalculatePayrollRunDto) {
    const existing = await this.prisma.forTenant(tenantId, (tx) =>
      tx.payrollRun.findUnique({
        where: { tenantId_plantId_payrollPeriod: { tenantId, plantId: dto.plantId, payrollPeriod: dto.payrollPeriod } },
      }),
    );
    if (existing) {
      throw new BadRequestException(
        `A payroll run for plant ${dto.plantId} / period ${dto.payrollPeriod} already exists (${existing.payrollRunId})`,
      );
    }

    const [year, month] = dto.payrollPeriod.split('-').map(Number);
    const periodStart = new Date(Date.UTC(year, month - 1, 1));
    const periodEnd = new Date(Date.UTC(year, month, 1)); // first day of the NEXT month, exclusive upper bound

    return this.prisma.forTenant(tenantId, async (tx) => {
      const plant = await tx.plant.findUnique({ where: { tenantId_plantId: { tenantId, plantId: dto.plantId } } });
      if (!plant) throw new NotFoundException(`Plant ${dto.plantId} not found`);

      // Plant Revenue: confirmed sales_orders at this plant within the
      // period. Read directly off sales-service's table rather than
      // journal_entries — see migration 020's grant comment for why.
      const orders = await tx.salesOrder.findMany({
        where: {
          tenantId,
          plantId: dto.plantId,
          orderStatus: 'CONFIRMED',
          orderDate: { gte: periodStart, lt: periodEnd },
        },
      });
      const plantRevenue = orders.reduce((sum, o) => sum + Number(o.totalOrderValue), 0);
      const payrollRatio = Number(plant.payrollRatio);
      const payrollPool = plantRevenue * payrollRatio;

      const employees = await tx.employee.findMany({
        where: { tenantId, plantId: dto.plantId, employmentStatus: 'ACTIVE' },
        include: { grade: true },
      });

      const tenantRow = await tx.tenantRegistry.findUnique({ where: { tenantId } });
      if (!tenantRow) throw new NotFoundException(`Tenant ${tenantId} not found`);
      const pensionEmployeeRate = Number(tenantRow.pensionEmployeeRate);

      const bandRows = await tx.payrollTaxBand.findMany({ where: { tenantId }, orderBy: { bandOrder: 'asc' } });
      const bands: TaxBand[] = bandRows.map((b) => ({
        thresholdMin: Number(b.thresholdMin),
        thresholdMax: b.thresholdMax === null ? null : Number(b.thresholdMax),
        rate: Number(b.rate),
      }));

      const payrollRunId = randomUUID();
      await tx.payrollRun.create({
        data: {
          tenantId,
          payrollRunId,
          plantId: dto.plantId,
          payrollPeriod: dto.payrollPeriod,
          payrollStatus: 'CALCULATED',
          postedToBooksFlag: false,
          plantRevenue,
          payrollRatioUsed: payrollRatio,
          totalPayrollPool: payrollPool,
          createdAt: new Date(),
        },
      });

      for (const employee of employees) {
        const gradeWeight = Number(employee.grade.gradeWeight);
        const grossSalary = payrollPool * gradeWeight;
        const deductions = computeStatutoryDeductions(grossSalary, pensionEmployeeRate, bands);
        await tx.payrollRecord.create({
          data: {
            tenantId,
            payrollRecordId: randomUUID(),
            payrollRunId,
            employeeId: employee.employeeId,
            gradeWeightUsed: gradeWeight,
            grossSalary,
            totalDeductions: deductions.totalDeductions,
            deductionsBreakdown: { payeAmount: deductions.payeAmount, pensionAmount: deductions.pensionAmount },
            netSalary: grossSalary - deductions.totalDeductions,
          },
        });
      }

      return tx.payrollRun.findUnique({
        where: { tenantId_payrollRunId: { tenantId, payrollRunId } },
        include: { records: { include: { employee: true } } },
      });
    });
  }

  findAll(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.payrollRun.findMany({ where: { tenantId }, include: { records: true }, orderBy: { createdAt: 'desc' } }),
    );
  }

  async postRun(tenantId: string, payrollRunId: string, userId: string | undefined) {
    await this.postingAuthority.checkAuthority({
      tenantId,
      userId,
      requiredPermission: 'can_post',
      moduleName: 'HR',
      recordIdRef: payrollRunId,
    });

    const runResult = await this.prisma.forTenant(tenantId, async (tx) => {
      const run = await tx.payrollRun.findUnique({
        where: { tenantId_payrollRunId: { tenantId, payrollRunId } },
        include: { records: true },
      });
      if (!run) throw new NotFoundException(`Payroll run ${payrollRunId} not found`);
      if (run.payrollStatus === 'POSTED') {
        throw new BadRequestException(`Payroll run ${payrollRunId} is already posted`);
      }

      const total = run.records.reduce((sum, r) => sum + Number(r.netSalary), 0);

      await tx.payrollRun.update({
        where: { tenantId_payrollRunId: { tenantId, payrollRunId } },
        data: { payrollStatus: 'POSTED', postedToBooksFlag: true },
      });

      return { total, plantId: run.plantId };
    });

    // Kafka publish happens AFTER this transaction commits — same
    // reasoning as every other module's producer call.
    await this.kafka.publish(tenantId, 'payroll.run_posted.v1', {
      event_id: randomUUID(),
      tenant_id: tenantId,
      plant_id: runResult.plantId,
      payroll_run_id: payrollRunId,
      net_salary_total: runResult.total,
      posted_at: new Date().toISOString(),
    });

    return { payrollRunId, posted: true, netSalaryTotal: runResult.total };
  }
}
