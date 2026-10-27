/**
 * Simulated — no physical printing.
 * The mock provider's `provider` is `mock`. PrintNode's label is `PrintNode`.
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

/** The request may have taken effect. Callers record `uncertain` and do not send again. */
export class ProviderUncertain extends Error {
  override readonly name = 'ProviderUncertain';
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
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

/** Stored mock states. `getJobState` maps these onto `ProviderJobStatus`. */
export type ProviderJobState = 'submitted' | 'done';

export type ProviderJobStatus =
  | { state: 'pending'; raw?: string }
  | { state: 'delivered'; raw?: string }
  | { state: 'done'; raw?: string }
  | {
      state: 'failed';
      reason: 'printer_error' | 'expired' | 'deleted';
      message?: string;
      raw?: string;
    };

export type PrintProviderName = 'mock' | 'printnode';

export type PrintProvider = {
  readonly provider: PrintProviderName;
  readonly label: string;
  listPrinters(account: PrintAccount): Promise<readonly ListedPrinter[]>;
  submit(input: PrintSubmitInput, signal?: AbortSignal): Promise<{ providerJobId: string }>;
  getJobState(
    input: { companyId: string; providerJobId: string },
    signal?: AbortSignal,
  ): Promise<ProviderJobStatus>;
};
