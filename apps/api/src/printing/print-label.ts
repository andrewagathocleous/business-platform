/** `done_reported` is the provider's report. It is not a confirmation that paper came out. */
export function printJobLabel(status: string): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'held':
      return 'Held — printing is switched off';
    case 'submitting':
      return 'Submitting';
    case 'submitted':
      return 'Sent to printer';
    case 'delivered_to_printer':
      return 'Delivered to printer (not confirmed)';
    case 'done_reported':
      return 'Sent to printer (provider reported done — not confirmed)';
    case 'confirmed_printed':
      return 'Confirmed printed';
    case 'not_printed':
      return 'Confirmed not printed';
    case 'failed':
      return 'Failed';
    case 'uncertain':
      return 'Uncertain — check the printer before reprinting';
    case 'cancelled':
      return 'Cancelled';
    default:
      return status;
  }
}

export type PrintSlot = {
  id: string;
  documentType: string;
  status: string;
  isReprint: boolean;
  createdAt: string;
  provider: 'mock' | 'printnode';
  label: string;
};
