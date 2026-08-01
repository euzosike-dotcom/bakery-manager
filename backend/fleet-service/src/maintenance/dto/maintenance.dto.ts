import { IsNumber, Min } from 'class-validator';

export class CompleteMaintenanceRequestDto {
  @IsNumber()
  @Min(0)
  partsCost!: number;

  @IsNumber()
  @Min(0)
  labourCost!: number;
}
