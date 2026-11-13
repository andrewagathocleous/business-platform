import { UnprocessableEntityException } from '@nestjs/common';
import { TenantDb, type TenantTransaction } from '@bp/db';
import type { StorageAdapter } from '@bp/integrations';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../authz/request-context';
import type { PrismaService } from '../database/prisma.service';
import { AccountantExportService } from './accountant-export.service';

const MIB = 1024 * 1024;
const ctx: RequestContext = {
  companyId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  serviceIdentityId: null,
  grants: [],
  isPlatformOwner: false,
  correlationId: 'size-refusal-test',
  mfaStepUpRequired: false,
  withheldPermissions: [],
  actorLabel: 'Fictional export test',
  mfaSatisfied: true,
};

afterEach(() => vi.restoreAllMocks());

describe('accountant export PDF memory limit (mocked database/storage)', () => {
  it.each([
    { name: '150 MiB plus one byte', sizes: [...Array.from({ length: 15 }, () => 10 * MIB), 1] },
    { name: '1,000 one-MiB PDFs', sizes: Array.from({ length: 1000 }, () => MIB) },
  ])('refuses $name before any storage read and audits the total', async ({ sizes }) => {
    const tx = {
      invoice: {
        findMany: vi
          .fn()
          .mockResolvedValue(
            sizes.map((sizeBytes) => ({ pdfFile: { sizeBytes }, lines: [], taxSummary: [] })),
          ),
      },
      payment: { findMany: vi.fn().mockResolvedValue([]) },
      allocation: { findMany: vi.fn().mockResolvedValue([]) },
      refund: { findMany: vi.fn().mockResolvedValue([]) },
    };
    vi.spyOn(TenantDb.prototype, 'run').mockImplementation(async (_ctx, fn) =>
      fn(tx as unknown as TenantTransaction),
    );
    const record = vi.fn().mockResolvedValue('audit-id');
    const get = vi.fn();
    const service = new AccountantExportService(
      {} as PrismaService,
      { record } as unknown as AuditService,
      { get } as unknown as StorageAdapter,
    );
    const failure: unknown = await service
      .export(ctx, '2026-10-01', '2026-10-29', 'true', { ip: null, userAgent: null })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UnprocessableEntityException);
    expect((failure as UnprocessableEntityException).getResponse()).toEqual({
      code: 'export_too_large',
      message: expect.stringMatching(/shorter period or export without PDFs/) as unknown,
    });
    expect(get).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledExactlyOnceWith(
      tx,
      expect.objectContaining({
        action: 'invoice.exported',
        outcome: 'failure',
        details: expect.objectContaining({
          reason: 'export_too_large',
          pdfSizeBytes: sizes.reduce((sum, size) => sum + size, 0),
          fileCounts: { csv: 0, pdfs: 0, total: 0 },
        }) as unknown,
      }),
    );
  });
});
