import { IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreateExpenseRequestDto {
  @IsUUID()
  categoryId!: string;

  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsOptional()
  @IsString()
  description?: string;
}
