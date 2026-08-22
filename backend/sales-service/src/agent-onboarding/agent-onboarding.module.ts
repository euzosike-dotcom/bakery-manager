import { Module } from '@nestjs/common';
import { AgentOnboardingController } from './agent-onboarding.controller';
import { AgentOnboardingService } from './agent-onboarding.service';

@Module({
  controllers: [AgentOnboardingController],
  providers: [AgentOnboardingService],
})
export class AgentOnboardingModule {}
