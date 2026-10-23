import { ProviderRejected, type PrintProvider, type PrintProviderName } from '@bp/integrations';

/**
 * `mock` exists only in development and test. Production and UAT refuse it.
 * PrintNode is always registered.
 */
export class PrintProviderRegistry {
  constructor(
    private readonly mock: PrintProvider | null,
    private readonly printnode: PrintProvider,
  ) {}

  get(provider: PrintProviderName): PrintProvider {
    if (provider === 'mock') {
      if (!this.mock) {
        throw new ProviderRejected('provider_unavailable');
      }
      return this.mock;
    }
    return this.printnode;
  }

  available(): readonly PrintProviderName[] {
    return this.mock ? ['mock', 'printnode'] : ['printnode'];
  }
}

export function createPrintProviderRegistry(input: {
  appEnv: string;
  mock: PrintProvider | null;
  printnode: PrintProvider;
}): PrintProviderRegistry {
  const mock =
    input.mock !== null && (input.appEnv === 'development' || input.appEnv === 'test')
      ? input.mock
      : null;
  return new PrintProviderRegistry(mock, input.printnode);
}
