/**
 * Statutory payroll deductions (027_statutory_payroll_deductions.sql):
 * Nigerian PAYE income tax (Personal Income Tax Act, as amended by the
 * Finance Act 2020) plus pension (Pension Reform Act 2014, 8% employee
 * contribution by default). Bands and the pension rate are tenant-
 * configurable data (payroll_tax_bands, tenant_registry
 * .pension_employee_rate); the Consolidated Relief Allowance formula and
 * the annualize/de-annualize shape below are Nigeria-specific
 * application logic, not data — a real multi-country deployment would
 * need to generalize that part too, a known gap this pass doesn't solve.
 *
 * Standard Nigerian monthly PAYE computation: annualize gross pay,
 * subtract the Consolidated Relief Allowance (the greater of ₦200,000 or
 * 1% of gross income, plus 20% of gross income) and the annual pension
 * contribution, run the remainder through the progressive bands, then
 * de-annualize the result back to a monthly figure. Pure and side-
 * effect-free so it can be tested against real tax-law edge cases in
 * isolation, same reasoning as ledger-service's amountFromPayload.
 */

export interface TaxBand {
  thresholdMin: number;
  thresholdMax: number | null; // null = "and above", the top band
  rate: number;
}

export interface StatutoryDeductions {
  payeAmount: number;
  pensionAmount: number;
  totalDeductions: number;
}

const CONSOLIDATED_RELIEF_ALLOWANCE_FLOOR = 200_000;
const CONSOLIDATED_RELIEF_ALLOWANCE_MIN_RATE = 0.01;
const CONSOLIDATED_RELIEF_ALLOWANCE_FLAT_RATE = 0.2;

export function computeStatutoryDeductions(
  grossMonthly: number,
  pensionEmployeeRate: number,
  bands: TaxBand[],
): StatutoryDeductions {
  const grossAnnual = grossMonthly * 12;
  const pensionAnnual = grossAnnual * pensionEmployeeRate;

  const consolidatedReliefAllowance =
    Math.max(CONSOLIDATED_RELIEF_ALLOWANCE_FLOOR, CONSOLIDATED_RELIEF_ALLOWANCE_MIN_RATE * grossAnnual) +
    CONSOLIDATED_RELIEF_ALLOWANCE_FLAT_RATE * grossAnnual;

  const taxableAnnual = Math.max(0, grossAnnual - consolidatedReliefAllowance - pensionAnnual);

  const payeAnnual = bands.reduce((sum, band) => {
    if (taxableAnnual <= band.thresholdMin) return sum;
    const upperBound = band.thresholdMax ?? Infinity;
    const amountInBand = Math.min(taxableAnnual, upperBound) - band.thresholdMin;
    return sum + amountInBand * band.rate;
  }, 0);

  const payeAmount = round2(payeAnnual / 12);
  const pensionAmount = round2(grossMonthly * pensionEmployeeRate);

  return {
    payeAmount,
    pensionAmount,
    totalDeductions: round2(payeAmount + pensionAmount),
  };
}

function round2(amount: number): number {
  return Math.round(amount * 100) / 100;
}
