import { IsString } from 'class-validator';

export class RejectPurchaseOrderDto {
  @IsString()
  reasonCode!: string;
}
