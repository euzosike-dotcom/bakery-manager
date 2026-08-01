import { IsIn, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class RecordInvoicePaymentDto {
  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsOptional()
  @IsIn(['BANK_TRANSFER', 'CASH', 'CHEQUE', 'CARD'])
  paymentMethod?: string;

  @IsOptional()
  @IsString()
  referenceNo?: string;
}
