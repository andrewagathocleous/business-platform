import { describe, expect, it } from 'vitest';
import { acceptedNewPrintJob, printAuditCovers } from './print-request';

const ORDER = '018f6c2e-7b1a-7c3d-8e4f-9a0b1c2d3e53';
const OTHER = '018f6c2e-7b1a-7c3d-8e4f-9a0b1c2d3e99';
const JOB = '018f6c2e-7b1a-7c3d-8e4f-9a0b1c2d3e54';
const QUEUE = '018f6c2e-7b1a-7c3d-8e4f-9a0b1c2d3e55';

describe('acceptedNewPrintJob', () => {
  it('rejects a completed job returned for an earlier order', () => {
    const stale = {
      printJob: {
        id: JOB,
        status: 'done_reported',
        sourceId: OTHER,
        documentType: 'packing_slip',
        queueJobId: QUEUE,
      },
    };
    expect(() => acceptedNewPrintJob(stale, ORDER, 'packing_slip')).toThrow(
      'print job status done_reported',
    );
  });

  it('rejects a queued job for a different order or document', () => {
    const otherOrder = {
      printJob: {
        id: JOB,
        status: 'queued',
        sourceId: OTHER,
        documentType: 'packing_slip',
        queueJobId: QUEUE,
      },
    };
    expect(() => acceptedNewPrintJob(otherOrder, ORDER, 'packing_slip')).toThrow('different order');
    const otherDocument = {
      printJob: {
        id: JOB,
        status: 'queued',
        sourceId: ORDER,
        documentType: 'gift_message',
        queueJobId: QUEUE,
      },
    };
    expect(() => acceptedNewPrintJob(otherDocument, ORDER, 'packing_slip')).toThrow('gift_message');
  });

  it('accepts a queued packing slip for this order', () => {
    expect(
      acceptedNewPrintJob(
        {
          printJob: {
            id: JOB,
            status: 'queued',
            sourceId: ORDER,
            documentType: 'packing_slip',
            queueJobId: QUEUE,
          },
        },
        ORDER,
        'packing_slip',
      ),
    ).toEqual({ id: JOB, queueJobId: QUEUE });
  });
});

describe('printAuditCovers', () => {
  const events = [
    {
      action: 'print_job.requested',
      objectId: JOB,
      details: { sourceId: OTHER },
    },
    {
      action: 'print_job.done_reported',
      objectId: JOB,
      details: { provider: 'mock' },
    },
  ];

  it('rejects an older job and a requested event for a different order', () => {
    expect(printAuditCovers(events, 'print_job.requested', 'new-job', ORDER)).toBe(false);
    expect(printAuditCovers(events, 'print_job.requested', JOB, ORDER)).toBe(false);
    expect(printAuditCovers(events, 'print_job.done_reported', 'new-job', ORDER)).toBe(false);
    expect(printAuditCovers(events, 'print_job.requested', JOB, OTHER)).toBe(true);
    expect(printAuditCovers(events, 'print_job.done_reported', JOB, ORDER)).toBe(true);
  });
});
