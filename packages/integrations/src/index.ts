/** Provider adapters. Shopify and printing are Phase 1 mock contracts. */
export const INTEGRATIONS_PACKAGE = '@bp/integrations' as const;

export { LocalFsStorage } from './storage/local-fs';
export { storageKey } from './storage/keys';
export { StoragePathError } from './storage/path';
export type { StorageAdapter } from './storage/adapter';

export {
  FINANCIAL_STATUS_MAP,
  SHOPIFY_ORDER_API_VERSION,
  ShopifyMapError,
  mapShopifyOrder,
  readShopifyEventIdentity,
  shopifyFixturesDirectory,
} from './shopify/map-order';
export type { MappedOrderLine, MappedShopifyOrder, StoreOrderConfig } from './shopify/map-order';

export { MockPrintProvider, MOCK_PRINTERS, behaviourOf } from './printing/mock';
export {
  PrinterOffline,
  ProviderRejected,
  ProviderTimeout,
  SIMULATED_PRINTING_LABEL,
} from './printing/provider';
export type {
  ListedPrinter,
  PrintAccount,
  PrintProvider,
  PrintSubmitInput,
  ProviderJobState,
} from './printing/provider';

export { isBlockedAddress } from './http/address-policy';
export {
  BlockedDestination,
  ConnectFailure,
  DnsFailure,
  RequestUncertain,
  ResponseTooLarge,
  SafeFetchError,
  TooManyRedirects,
  UnexpectedRedirect,
} from './http/errors';
export { createSafeFetch } from './http/safe-fetch';
export type {
  ResolvedAddress,
  SafeFetchConfig,
  SafeFetchRequest,
  SafeResponse,
} from './http/safe-fetch';
