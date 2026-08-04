import { Module } from '@nestjs/common';
import { ApprovalMatrixController } from './approval-matrix.controller';
import { ApprovalMatrixService } from './approval-matrix.service';

@Module({
  controllers: [ApprovalMatrixController],
  providers: [ApprovalMatrixService],
})
export class ApprovalMatrixModule {}
