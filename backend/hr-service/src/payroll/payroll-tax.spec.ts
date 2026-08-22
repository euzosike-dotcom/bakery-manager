import { computeStatutoryDeductions, TaxBand } from './payroll-tax';

// The real 2020 Finance Act bands (annual), same values
// hr_payroll_seed.sql seeds for the dev tenant.
const NIGERIAN_BANDS: TaxBand[] = [
  { thresholdMin: 0, thresholdMax: 300_000, rate: 0.07 },
  { thresholdMin: 300_000, thresholdMax: 600_000, rate: 0.11 },
  { thresholdMin: 600_000, thresholdMax: 1_100_000, rate: 0.15 },
  { thresholdMin: 1_100_000, thresholdMax: 1_600_000, rate: 0.19 },
  { thresholdMin: 1_600_000, thresholdMax: 3_200_000, rate: 0.21 },
  { thresholdMin: 3_200_000, thresholdMax: null, rate: 0.24 },
];

describe('computeStatutoryDeductions', () => {
  it('deducts nothing at zero gross pay', () => {
    const result = computeStatutoryDeductions(0, 0.08, NIGERIAN_BANDS);
    expect(result).toEqual({ payeAmount: 0, pensionAmount: 0, totalDeductions: 0 });
  });

  it('computes pension as a flat percentage of gross pay regardless of PAYE', () => {
    const result = computeStatutoryDeductions(30_000, 0.08, NIGERIAN_BANDS);
    expect(result.pensionAmount).toBe(2400); // 30,000 x 0.08
  });

  it('a low earner still owes some PAYE once pension and CRA reliefs are applied', () => {
    // Annual gross 360,000; CRA = max(200,000, 3,600) + 72,000 = 272,000;
    // pension = 28,800; taxable = 360,000 - 272,000 - 28,800 = 59,200,
    // entirely within the first 7% band -> 4,144/year -> 345.33/month.
    const result = computeStatutoryDeductions(30_000, 0.08, NIGERIAN_BANDS);
    expect(result.payeAmount).toBeCloseTo(345.33, 2);
    expect(result.totalDeductions).toBeCloseTo(2745.33, 2);
  });

  it('taxes a high earner across every band, not just the top one', () => {
    // Annual gross 6,000,000; CRA = max(200,000, 60,000) + 1,200,000 =
    // 1,400,000; pension = 480,000; taxable = 4,120,000, which spans all
    // six bands.
    const result = computeStatutoryDeductions(500_000, 0.08, NIGERIAN_BANDS);
    // 21,000 + 33,000 + 75,000 + 95,000 + 336,000 + 220,800 = 780,800/yr
    expect(result.payeAmount).toBeCloseTo(65_066.67, 1);
    expect(result.pensionAmount).toBe(40_000);
  });

  it('never lets the Consolidated Relief Allowance push taxable income negative', () => {
    // A very low gross pay where CRA (dominated by its 200,000 floor)
    // plus pension would otherwise exceed annualized gross.
    const result = computeStatutoryDeductions(5_000, 0.08, NIGERIAN_BANDS);
    expect(result.payeAmount).toBe(0);
  });

  it('treats a null threshold_max as the unbounded top band', () => {
    const topBandOnly: TaxBand[] = [{ thresholdMin: 0, thresholdMax: null, rate: 0.1 }];
    // Annual gross 12,000,000; CRA = max(200,000, 120,000) + 2,400,000 =
    // 2,600,000; pension = 960,000; taxable = 8,440,000 -> all at 10%.
    const result = computeStatutoryDeductions(1_000_000, 0.08, topBandOnly);
    expect(result.payeAmount).toBeCloseTo((8_440_000 * 0.1) / 12, 1);
  });

  it('is a pure function of its inputs — no shared or mutated state across calls', () => {
    const bandsCopy = NIGERIAN_BANDS.map((b) => ({ ...b }));
    computeStatutoryDeductions(30_000, 0.08, NIGERIAN_BANDS);
    expect(NIGERIAN_BANDS).toEqual(bandsCopy);
  });
});
