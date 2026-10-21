import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthorizationModule } from '../authz/authorization.module';
import { AutomationController } from './automation.controller';
import { CompanyAutomationController } from './company-automation.controller';
import { CompanyAutomationService } from './company-automation.service';
import { PrintingModule } from '../printing/printing.module';
import { PrintProcessor } from '../printing/print.processor';
import { InboxProcessor } from './inbox.processor';
import { InboxService } from './inbox.service';
import { JobRunner } from './jobs/job-runner';

@Injectable()
class JobRegistration implements OnModuleInit {
  constructor(
    @Inject(JobRunner) private readonly jobs: JobRunner,
    @Inject(InboxProcessor) private readonly inbox: InboxProcessor,
    @Inject(PrintProcessor) private readonly printing: PrintProcessor,
  ) {}

  onModuleInit(): void {
    this.jobs.register({
      type: 'inbox.process',
      concurrency: 4,
      retryable: true,
      run: (job, tx, signal) => this.inbox.run(job, tx, signal),
    });
    this.jobs.register({
      type: 'print.submit',
      concurrency: 2,
      retryable: false,
      mode: 'external',
      run: (job, external) => this.printing.runSubmit(job, external),
    });
    this.jobs.register({
      type: 'print.refresh_status',
      concurrency: 2,
      retryable: true,
      mode: 'external',
      run: (job, external) => this.printing.runRefresh(job, external),
    });
  }
}

@Module({
  imports: [AuditModule, AuthorizationModule, PrintingModule],
  controllers: [AutomationController, CompanyAutomationController],
  providers: [JobRunner, InboxService, InboxProcessor, JobRegistration, CompanyAutomationService],
  exports: [JobRunner, InboxService, InboxProcessor, CompanyAutomationService],
})
export class AutomationModule {}
