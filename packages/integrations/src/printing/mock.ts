import { constants } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PrinterOffline,
  ProviderRejected,
  ProviderTimeout,
  SIMULATED_PRINTING_LABEL,
  type ListedPrinter,
  type PrintAccount,
  type PrintProvider,
  type PrintSubmitInput,
  type ProviderJobState,
  type ProviderJobStatus,
} from './provider';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Behaviour = 'online' | 'offline' | 'timeout';

type CatalogueEntry = ListedPrinter & { behaviour: Behaviour };

/**
 * Simulated — no physical printing.
 * Online printers write the PDF and move to `done` on the next status read.
 * Offline printers throw PrinterOffline. The flaky printer throws ProviderTimeout.
 */
export const MOCK_PRINTERS: readonly CatalogueEntry[] = [
  {
    externalPrinterId: 'mock-laserjet-online',
    name: 'Mock LaserJet (online)',
    description: `${SIMULATED_PRINTING_LABEL}. Submits succeed.`,
    paperSizes: ['A4', 'A6'],
    status: 'online',
    behaviour: 'online',
  },
  {
    externalPrinterId: 'mock-offline',
    name: 'Mock Offline Printer',
    description: `${SIMULATED_PRINTING_LABEL}. Submits fail with printer_offline.`,
    paperSizes: ['A4'],
    status: 'offline',
    behaviour: 'offline',
  },
  {
    externalPrinterId: 'mock-flaky',
    name: 'Mock Flaky Printer',
    description: `${SIMULATED_PRINTING_LABEL}. Submits time out and yield uncertain.`,
    paperSizes: ['A4'],
    status: 'unknown',
    behaviour: 'timeout',
  },
];

type StoredState = {
  providerJobId: string;
  state: ProviderJobState;
  idempotencyKey: string;
  copies: number;
  paperSize: string;
  title: string;
};

/**
 * Simulated — no physical printing. `provider` is `mock`.
 * Output is ` <root>/<companyId>/<printJobId>.pdf `. The state file next to it
 * is how a later status refresh in this process, or the next one, sees the job.
 */
export class MockPrintProvider implements PrintProvider {
  readonly provider = 'mock' as const;
  readonly label = SIMULATED_PRINTING_LABEL;
  /** Counts every submit entry, including offline and timeout. Tests use it as the spy. */
  submitCount = 0;
  readonly submittedIds: string[] = [];
  /** Runs after the call is counted and before the printer behaviour. Tests block here. */
  beforeSubmit: (() => Promise<void>) | null = null;

  constructor(private readonly root: string) {}

  listPrinters(account: PrintAccount): Promise<readonly ListedPrinter[]> {
    if (!UUID.test(account.companyId)) {
      return Promise.reject(new ProviderRejected('unknown_printer'));
    }
    return Promise.resolve(
      MOCK_PRINTERS.map((printer) => ({
        externalPrinterId: printer.externalPrinterId,
        name: printer.name,
        description: printer.description,
        paperSizes: printer.paperSizes,
        status: printer.status,
      })),
    );
  }

  async submit(input: PrintSubmitInput, signal?: AbortSignal): Promise<{ providerJobId: string }> {
    if (signal?.aborted) {
      throw new ProviderTimeout();
    }
    this.submitCount += 1;
    this.submittedIds.push(input.printJobId);
    await this.beforeSubmit?.();
    // An in-flight submit finishes after beforeSubmit so a late result can be recorded.
    // The runner does not start a second submit.
    const behaviour = behaviourOf(input.printerExternalId);
    if (behaviour === 'offline') {
      throw new PrinterOffline();
    }
    if (behaviour === 'timeout') {
      throw new ProviderTimeout();
    }
    if (behaviour !== 'online') {
      throw new ProviderRejected('unknown_printer');
    }
    const paths = outputPaths(this.root, input.companyId, input.printJobId);
    const providerJobId = providerJobIdFor(input.companyId, input.printJobId);
    const existing = await readState(paths.statePath);
    if (existing) {
      if (existing.idempotencyKey !== input.idempotencyKey) {
        throw new ProviderRejected('idempotency_key_mismatch');
      }
      return { providerJobId: existing.providerJobId };
    }
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    try {
      await writeExclusive(paths.pdfPath, input.pdf);
    } catch (error) {
      if (!isCode(error, 'EEXIST')) {
        throw error;
      }
    }
    const state: StoredState = {
      providerJobId,
      state: 'submitted',
      idempotencyKey: input.idempotencyKey,
      copies: input.copies,
      paperSize: input.paperSize,
      title: input.title,
    };
    try {
      await writeExclusive(paths.statePath, Buffer.from(JSON.stringify(state)));
    } catch (error) {
      if (!isCode(error, 'EEXIST')) {
        throw error;
      }
      const raced = await readState(paths.statePath);
      if (!raced || raced.idempotencyKey !== input.idempotencyKey) {
        throw new ProviderRejected('idempotency_key_mismatch');
      }
      return { providerJobId: raced.providerJobId };
    }
    return { providerJobId };
  }

  async getJobState(input: {
    companyId: string;
    providerJobId: string;
  }): Promise<ProviderJobStatus> {
    const parsed = parseProviderJobId(input.providerJobId);
    if (!parsed) {
      throw new ProviderRejected('unknown_provider_job');
    }
    const paths = outputPaths(this.root, parsed.companyId, parsed.printJobId);
    const state = await readState(paths.statePath);
    if (!state || state.providerJobId !== input.providerJobId) {
      throw new ProviderRejected('unknown_provider_job');
    }
    if (state.state === 'submitted') {
      state.state = 'done';
      await writeExclusive(paths.statePath, Buffer.from(JSON.stringify(state)), true);
    }
    return reportedStatus(state.state);
  }
}

/** `submitted` was the pre-completion mock state. Callers see it as delivered to the printer. */
function reportedStatus(state: ProviderJobState): ProviderJobStatus {
  return state === 'submitted' ? { state: 'delivered' } : { state: 'done' };
}

export function behaviourOf(externalPrinterId: string): Behaviour | null {
  return (
    MOCK_PRINTERS.find((printer) => printer.externalPrinterId === externalPrinterId)?.behaviour ??
    null
  );
}

function providerJobIdFor(companyId: string, printJobId: string): string {
  return `mock:${companyId.toLowerCase()}:${printJobId.toLowerCase()}`;
}

function parseProviderJobId(
  providerJobId: string,
): { companyId: string; printJobId: string } | null {
  const match = /^mock:([0-9a-f-]{36}):([0-9a-f-]{36})$/i.exec(providerJobId);
  if (!match?.[1] || !match[2] || !UUID.test(match[1]) || !UUID.test(match[2])) {
    return null;
  }
  return { companyId: match[1].toLowerCase(), printJobId: match[2].toLowerCase() };
}

function outputPaths(
  root: string,
  companyId: string,
  printJobId: string,
): {
  directory: string;
  pdfPath: string;
  statePath: string;
} {
  if (!UUID.test(companyId) || !UUID.test(printJobId)) {
    throw new ProviderRejected('print_output_path');
  }
  const directory = join(root, companyId.toLowerCase());
  const id = printJobId.toLowerCase();
  return {
    directory,
    pdfPath: join(directory, `${id}.pdf`),
    statePath: join(directory, `${id}.json`),
  };
}

async function readState(path: string): Promise<StoredState | null> {
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (error) {
    if (isCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(raw.toString('utf8'));
  if (!isState(parsed)) {
    throw new ProviderRejected('print_state_unreadable');
  }
  return parsed;
}

async function writeExclusive(path: string, body: Buffer, replace = false): Promise<void> {
  const flags = replace
    ? constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
  const handle = await open(path, flags | noFollow(), 0o600);
  try {
    await handle.writeFile(body);
  } finally {
    await handle.close();
  }
}

function noFollow(): number {
  const flag = constants.O_NOFOLLOW;
  return typeof flag === 'number' ? flag : 0;
}

function isState(value: unknown): value is StoredState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.providerJobId === 'string' &&
    (record.state === 'submitted' || record.state === 'done') &&
    typeof record.idempotencyKey === 'string' &&
    typeof record.copies === 'number' &&
    typeof record.paperSize === 'string' &&
    typeof record.title === 'string'
  );
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
