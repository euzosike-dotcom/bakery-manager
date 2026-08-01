import { Module } from '@nestjs/common';
import { NcrController } from './ncr.controller';
import { NcrService } from './ncr.service';

@Module({
  controllers: [NcrController],
  providers: [NcrService],
  exports: [NcrService],
})
export class NcrModule {}
