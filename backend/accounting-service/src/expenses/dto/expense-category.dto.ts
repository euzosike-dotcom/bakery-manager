import { IsString } from 'class-validator';

export class CreateExpenseCategoryDto {
  @IsString()
  categoryName!: string;

  @IsString()
  glAccountCode!: string;
}
