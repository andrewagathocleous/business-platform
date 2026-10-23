import { describe, expect, it } from 'vitest';
import {
  ProviderRejected,
  SIMULATED_PRINTING_LABEL,
  type PrintProvider,
  type PrintProviderName,
} from '@bp/integrations';
import { createPrintProviderRegistry } from './print-providers';

describe('PrintProviderRegistry', () => {
  it('registers the mock in development and test, and refuses it in production and uat', () => {
    const development = createPrintProviderRegistry({
      appEnv: 'development',
      mock: stub('mock'),
      printnode: stub('printnode'),
    });
    expect(development.available()).toEqual(['mock', 'printnode']);
    expect(development.get('mock').provider).toBe('mock');
    expect(development.get('mock').label).toBe(SIMULATED_PRINTING_LABEL);
    expect(development.get('printnode').label).toBe('PrintNode');

    const test = createPrintProviderRegistry({
      appEnv: 'test',
      mock: stub('mock'),
      printnode: stub('printnode'),
    });
    expect(test.available()).toContain('mock');

    for (const appEnv of ['production', 'uat']) {
      const registry = createPrintProviderRegistry({
        appEnv,
        mock: stub('mock'),
        printnode: stub('printnode'),
      });
      expect(registry.available()).toEqual(['printnode']);
      expect(() => registry.get('mock')).toThrow(ProviderRejected);
      expect(() => registry.get('mock')).toThrow(/provider_unavailable/);
    }
  });
});

function stub(provider: PrintProviderName): PrintProvider {
  return {
    provider,
    label: provider === 'mock' ? SIMULATED_PRINTING_LABEL : 'PrintNode',
    listPrinters: () => Promise.resolve([]),
    submit: () => Promise.resolve({ providerJobId: '1' }),
    getJobState: () => Promise.resolve({ state: 'pending' }),
  };
}
