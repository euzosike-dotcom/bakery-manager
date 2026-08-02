import { IsUUID, Matches } from 'class-validator';

export class CalculatePayrollRunDto {
  @IsUUID()
  plantId!: string;

  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'payrollPeriod must be in YYYY-MM format' })
  payrollPeriod!: string;
}
