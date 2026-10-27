import { asRecord, field, nested } from './http';

/** The create response must be a new queued job for this order, not an older job. */
export function acceptedNewPrintJob(
  body: unknown,
  orderId: string,
  documentType: string,
): { id: string; queueJobId: string } {
  const job = nested(body, 'printJob');
  const status = field(job, 'status');
  if (status !== 'queued') {
    throw new Error(`print job status ${status}`);
  }
  const sourceId = field(job, 'sourceId');
  if (sourceId !== orderId) {
    throw new Error('print job is for a different order');
  }
  const actualType = field(job, 'documentType');
  if (actualType !== documentType) {
    throw new Error(`print job document ${actualType}`);
  }
  return { id: field(job, 'id'), queueJobId: field(job, 'queueJobId') };
}

/**
 * `print_job.requested` must name this print job and this order (`sourceId`).
 * Later print-job events must name this print job. The create response already
 * bound that id to this order.
 */
export function printAuditCovers(
  events: readonly Record<string, unknown>[],
  action: string,
  printJobId: string,
  orderId: string,
): boolean {
  return events.some((event) => {
    if (event.action !== action || event.objectId !== printJobId) {
      return false;
    }
    if (action !== 'print_job.requested') {
      return true;
    }
    return asRecord(event.details)?.sourceId === orderId;
  });
}
