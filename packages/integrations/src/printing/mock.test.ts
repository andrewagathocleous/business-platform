import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockPrintProvider } from './mock';
import { PrinterOffline, ProviderTimeout, SIMULATED_PRINTING_LABEL } from './provider';

const COMPANY = '01932a1e-7b4c-7c2a-8e10-111111111111';
const JOB = '01932a1e-7b4c-7c2a-8e10-222222222222';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('MockPrintProvider', () => {
  it('labels itself as simulated and writes the online printer PDF', async () => {
    const provider = await make();
    expect(provider.provider).toBe('mock');
    expect(provider.label).toBe(SIMULATED_PRINTING_LABEL);
    expect(SIMULATED_PRINTING_LABEL).toBe('Simulated — no physical printing');
    const pdf = Buffer.from('%PDF-1.4 mock');
    const submitted = await provider.submit(input(pdf, 'mock-laserjet-online'));
    expect(submitted.providerJobId).toBe(`mock:${COMPANY}:${JOB}`);
    const written = await readFile(join(roots[0] ?? '', COMPANY, `${JOB}.pdf`));
    expect(written.equals(pdf)).toBe(true);
    expect(
      await provider.getJobState({ companyId: COMPANY, providerJobId: submitted.providerJobId }),
    ).toEqual({ state: 'done' });
    expect(
      await provider.getJobState({ companyId: COMPANY, providerJobId: submitted.providerJobId }),
    ).toEqual({ state: 'done' });
    const again = await provider.submit(input(pdf, 'mock-laserjet-online'));
    expect(again.providerJobId).toBe(submitted.providerJobId);
  });

  it('fails offline and times out the flaky printer without writing a PDF', async () => {
    const provider = await make();
    await expect(
      provider.submit(input(Buffer.from('%PDF'), 'mock-offline')),
    ).rejects.toBeInstanceOf(PrinterOffline);
    await expect(provider.submit(input(Buffer.from('%PDF'), 'mock-flaky'))).rejects.toBeInstanceOf(
      ProviderTimeout,
    );
    await expect(readFile(join(roots[0] ?? '', COMPANY, `${JOB}.pdf`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const listed = await provider.listPrinters({ companyId: COMPANY });
    expect(listed.map((printer) => printer.externalPrinterId)).toEqual([
      'mock-laserjet-online',
      'mock-offline',
      'mock-flaky',
    ]);
  });
});

async function make(): Promise<MockPrintProvider> {
  const root = await mkdtemp(join(tmpdir(), 'bp-mock-print-'));
  roots.push(root);
  return new MockPrintProvider(root);
}

function input(pdf: Buffer, printerExternalId: string) {
  return {
    companyId: COMPANY,
    printJobId: JOB,
    printerExternalId,
    pdf,
    copies: 1,
    paperSize: 'A4',
    title: 'packing slip',
    idempotencyKey: `pj_${JOB}`,
  };
}
