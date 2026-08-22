import { Module } from '@nestjs/common';
import { PostingsController } from './postings.controller';
import { PostingsService } from './postings.service';

@Module({
  controllers: [PostingsController],
  providers: [PostingsService],
})
export class PostingsModule {}
