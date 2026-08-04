import { Module } from '@nestjs/common';
import { ReasonCodesController } from './reason-codes.controller';
import { ReasonCodesService } from './reason-codes.service';

@Module({
  controllers: [ReasonCodesController],
  providers: [ReasonCodesService],
})
export class ReasonCodesModule {}
