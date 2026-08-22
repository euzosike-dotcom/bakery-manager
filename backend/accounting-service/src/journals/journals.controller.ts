import { Controller, Get, Param, Post, Body } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { JournalsService } from './journals.service';
import { CreateJournalEntryDto } from './dto/journal-entry.dto';

@Controller('journal-entries')
export class JournalsController {
  constructor(private readonly journals: JournalsService) {}

  @Get()
  findAll(@CurrentTenant() tenant: TenantContext) {
    return this.journals.findAll(tenant.tenantId);
  }

  @Post()
  create(@CurrentTenant() tenant: TenantContext, @Body() dto: CreateJournalEntryDto) {
    return this.journals.createManualJournalEntry(tenant.tenantId, dto, tenant.userId);
  }

  @Post(':journalEntryId/approve')
  approve(@CurrentTenant() tenant: TenantContext, @Param('journalEntryId') journalEntryId: string) {
    return this.journals.approveJournalEntry(tenant.tenantId, journalEntryId, tenant.userId);
  }

  @Post(':journalEntryId/reject')
  reject(@CurrentTenant() tenant: TenantContext, @Param('journalEntryId') journalEntryId: string) {
    return this.journals.rejectJournalEntry(tenant.tenantId, journalEntryId, tenant.userId);
  }
}
