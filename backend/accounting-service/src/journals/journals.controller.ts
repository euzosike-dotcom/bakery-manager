import { Body, Controller, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { JournalsService } from './journals.service';
import { CreateJournalEntryDto } from './dto/journal-entry.dto';

@Controller('journal-entries')
export class JournalsController {
  constructor(private readonly journals: JournalsService) {}

  @Post()
  create(@CurrentTenant() tenant: TenantContext, @Body() dto: CreateJournalEntryDto) {
    return this.journals.createManualJournalEntry(tenant.tenantId, dto, tenant.userId);
  }
}
