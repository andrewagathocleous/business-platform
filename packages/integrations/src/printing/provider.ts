/**
 * Simulated — no physical printing.
 * The mock provider is the only Phase 1 implementation. Responses use `provider: 'mock'`.
 */
export const SIMULATED_PRINTING_LABEL = 'Simulated — no physical printing';

export class PrinterOffline extends Error {
  override readonly name = 'PrinterOffline';

  constructor() {
    super('printer_offline');
  }
}

export class ProviderRejected extends Error {
  override readonly name = 'ProviderRejected';

  constructor(message = 'provider_rejected') {
    super(message);
  }
}

export class ProviderTimeout extends Error {
  override readonly name = 'ProviderTimeout';

  constructor() {
    super('provider_timeout');
  }
}

export type PrintAccount = {
  companyId: string;
};

export type PrintSubmitInput = {
  companyId: string;
  printJobId: string;
  printerExternalId: string;
  pdf: Buffer;
  copies: number;
  paperSize: string;
  title: string;
  idempotencyKey: string;
};

export type ListedPrinter = {
  externalPrinterId: string;
  name: string;
  description: string;
  paperSizes: readonly string[];
  status: 'online' | 'offline' | 'unknown';
};

export type ProviderJobState = 'submitted' | 'done';

export type PrintProvider = {
  readonly provider: 'mock';
  readonly label: typeof SIMULATED_PRINTING_LABEL;
  listPrinters(account: PrintAccount): Promise<readonly ListedPrinter[]>;
  submit(input: PrintSubmitInput, signal?: AbortSignal): Promise<{ providerJobId: string }>;
  getJobState(providerJobId: string): Promise<ProviderJobState>;
};
