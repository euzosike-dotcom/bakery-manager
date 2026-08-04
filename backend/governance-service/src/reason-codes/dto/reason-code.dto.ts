import { IsOptional, IsString } from 'class-validator';

export class CreateReasonCodeDto {
  @IsString()
  reasonCode!: string;

  @IsString()
  reasonGroup!: string;

  @IsOptional()
  @IsString()
  description?: string;
}
