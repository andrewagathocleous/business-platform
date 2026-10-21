import './money/decimal';

export {
  AmountError,
  calculateDocumentTotals,
  currencyMinorDigits,
  DocumentValidationError,
  money,
  parseAmount,
  round2,
} from './money';
export type {
  AmountRejection,
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

export { isAutomationOnly, PERMISSIONS, permissionByKey, ROLE_KEYS } from './authz/permissions';
export type {
  GrantLevel,
  PermissionDefinition,
  PermissionPhase,
  RoleKey,
  ScopableScope,
} from './authz/permissions';
export { ALL_ROLE_TEMPLATES, BASE_TEMPLATE, ROLE_TEMPLATES, roleTemplate } from './authz/role-templates';
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

export { normalizeForDuplicateCheck } from './text/normalize';
export { addDaysToBusinessDate, businessDateInZone } from './time/business-date';
