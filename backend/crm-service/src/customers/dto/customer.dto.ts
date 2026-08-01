import { IsEmail, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateCustomerDto {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsString()
  customerCode!: string;

  @IsString()
  customerName!: string;

  @IsOptional()
  @IsIn(['RETAIL', 'WHOLESALE', 'INSTITUTIONAL'])
  customerType?: string;

  @IsOptional()
  @IsString()
  contactPerson?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsUUID()
  plantId?: string;
}

export class UpdateCustomerStatusDto {
  @IsIn(['PROSPECT', 'ACTIVE', 'INACTIVE'])
  customerStatus!: string;
}
