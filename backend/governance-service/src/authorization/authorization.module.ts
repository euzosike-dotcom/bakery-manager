import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthorizationController } from './authorization.controller';
import { ApprovalAuthorityController } from './approval-authority.controller';
import { AuthorizationService } from './authorization.service';

@Module({
  imports: [AuditModule],
  controllers: [AuthorizationController, ApprovalAuthorityController],
  providers: [AuthorizationService],
})
export class AuthorizationModule {}
