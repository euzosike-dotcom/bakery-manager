import { IsEmail, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateUserDto {
  @IsString()
  fullName!: string;

  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  employeeCode?: string;

  @IsOptional()
  @IsUUID()
  roleId?: string;

  @IsOptional()
  @IsUUID()
  plantId?: string;

  @IsOptional()
  @IsString()
  department?: string;
}
