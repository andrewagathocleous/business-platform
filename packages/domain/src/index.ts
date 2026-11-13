import './money/decimal';

export {
  AmountError,
  calculateCreditTotals,
  calculateDocumentTotals,
  currencyMinorDigits,
  isKnownCurrency,
  DocumentValidationError,
  money,
  parseAmount,
  round2,
} from './money';
export type {
  AmountRejection,
  CreditLineRequest,
  CreditSourceLine,
  CreditTotalsInput,
  DocumentLineInput,
  DocumentLineTotals,
  DocumentTotals,
  DocumentTotalsInput,
  TaxGroupTotals,
} from './money';

export {
  allowedTransitions,
  DELIVERY_METHODS,
  evaluateTransition,
  FULFILMENT_STATUSES,
  PAYMENT_STATUSES,
} from './orders/state-machine';
export type {
  DeliveryMethod,
  FulfilmentStatus,
  OrderTransitionState,
  PaymentStatus,
  TransitionDecision,
  TransitionErrorCode,
} from './orders/state-machine';
export { GIFT_MESSAGE_MAX_CODE_POINTS, giftMessageTooLong } from './orders/gift-message-length';

export { isAutomationOnly, PERMISSIONS, permissionByKey, ROLE_KEYS } from './authz/permissions';
export type {
  GrantLevel,
  PermissionDefinition,
  PermissionPhase,
  RoleKey,
  ScopableScope,
} from './authz/permissions';
export {
  ALL_ROLE_TEMPLATES,
  BASE_TEMPLATE,
  ROLE_TEMPLATES,
  roleTemplate,
} from './authz/role-templates';
export type { RoleTemplate, TemplateKey } from './authz/role-templates';
export {
  can,
  canGrant,
  decideAccess,
  grantsForAssignment,
  membershipEscalationDenial,
  permittedScopeFilter,
  SCOPE_TYPES,
} from './authz/evaluate';
export type {
  AccessDecision,
  EscalationDenial,
  Grant,
  MembershipEscalation,
  ResourceScope,
  ScopeFilter,
  ScopeType,
} from './authz/evaluate';

export { decimalString, documentLineSchema, documentTotalsSchema } from './contracts/document';
export type { DocumentLineDto, DocumentTotalsDto } from './contracts/document';

export { connectionHealth } from './integrations/connection-health';
export type {
  ConnectionHealth,
  ConnectionHealthInput,
  ConnectionHealthLevel,
  ConnectionHealthReason,
} from './integrations/connection-health';

export { isValidBic, isValidIban, normalizeBic, normalizeIban } from './banking/iban';
export {
  deliveryDeadline,
  printedUnitAmount,
  vatExclusiveUnitPrice,
} from './invoicing/issue-rules';
export type { DeliveryDeadlineRule } from './invoicing/issue-rules';
export { foldForComparison, normalizeForDuplicateCheck } from './text/normalize';
export { addDaysToBusinessDate, businessDateInZone } from './time/business-date';
export { isIanaTimeZone } from './time/iana-zone';
export { instantToWallTimeInZone, wallTimeInZoneToInstant } from './time/wall-time';

export {
  allocationEffectiveOn,
  countedOn,
  currentTotal,
  openBalance,
  paymentState,
  refundAllowed,
  sourceRemaining,
} from './payments/settlement';
export type {
  AllocationEffectiveOnInput,
  DatedAmount,
  DatedSettlementSource,
  InvoicePaymentState,
  InvoiceSettlement,
  RefundAllowedInput,
  SettlementSource,
} from './payments/settlement';

export { ageingBucket, ageingReport, collectedReport, invoicedReport } from './reports/finance';
export type {
  AgeingBucket,
  AgeingInvoice,
  AgeingSource,
  CollectedMovement,
  InvoicedDocument,
  ReportFigure,
} from './reports/finance';
