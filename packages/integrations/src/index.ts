/** Provider adapters. Shopify is a Phase 1 mock. PrestaShop is the R1 read-only client. PrintNode is the R1 print client. */
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
export type {
  MappedOrder,
  MappedOrderLine,
  MappedShopifyOrder,
  StoreOrderConfig,
} from './shopify/map-order';

export {
  PrestashopAuthFailed,
  PrestashopBadResponse,
  canonicalPrestashopBaseUrl,
  createPrestashopClient,
} from './prestashop/client';
export type {
  PrestashopAddress,
  PrestashopCarrier,
  PrestashopClient,
  PrestashopCountry,
  PrestashopCurrency,
  PrestashopCustomer,
  PrestashopOrder,
  PrestashopOrderRow,
  PrestashopOrderState,
} from './prestashop/client';
export { buildPrestashopOrderPayload, prestashopOrderPayloadSchema } from './prestashop/payload';
export type { PrestashopOrderLookups, PrestashopOrderPayload } from './prestashop/payload';
export {
  PrestashopMapError,
  mapPrestashopOrder,
  prestashopFixturesDirectory,
  readPrestashopEventIdentity,
} from './prestashop/map-order';
export type { PrestashopConnectionConfig } from './prestashop/map-order';

export { MockPrintProvider, MOCK_PRINTERS, behaviourOf } from './printing/mock';
export { PrintNodeHttpError, PrintNodeProvider, printNodeWhoami } from './printing/printnode';
export type { SafeFetch } from './printing/printnode';
export {
  PrinterOffline,
  ProviderRejected,
  ProviderTimeout,
  ProviderUncertain,
  SIMULATED_PRINTING_LABEL,
} from './printing/provider';
export type {
  ListedPrinter,
  PrintAccount,
  PrintProvider,
  PrintProviderName,
  PrintSubmitInput,
  ProviderJobState,
  ProviderJobStatus,
} from './printing/provider';

export { GIFT_MESSAGE_MAX_CODE_POINTS, giftMessageTooLong } from './gift-message-length';

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
