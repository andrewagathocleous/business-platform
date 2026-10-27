export const FULFILMENT_STATUSES = [
  'new',
  'review_required',
  'preparing',
  'ready',
  'handed_to_courier',
  'completed',
  'cancelled',
] as const;

export type FulfilmentStatus = (typeof FULFILMENT_STATUSES)[number];

export const PAYMENT_STATUSES = [
  'pending',
  'authorized',
  'paid',
  'partially_paid',
  'refunded',
  'partially_refunded',
  'voided',
  'unknown',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const DELIVERY_METHODS = [
  'courier_cy',
  'post_international',
  'collection',
  'unknown',
] as const;

export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

export type OrderTransitionState = {
  fulfilmentStatus: FulfilmentStatus;
  paymentStatus: PaymentStatus;
  deliveryMethod: DeliveryMethod;
};

export type TransitionErrorCode =
  | 'transition_not_allowed'
  | 'terminal_status'
  | 'payment_not_settled'
  | 'delivery_method_not_allowed';

export type TransitionDecision = {
  from: FulfilmentStatus;
  to: FulfilmentStatus;
  allowed: boolean;
  error?: TransitionErrorCode;
  /** Present when the API must also check order.cancel. The state machine does not see grants. */
  requiredPermission?: 'order.cancel';
};

const NEXT: Record<FulfilmentStatus, readonly FulfilmentStatus[]> = {
  new: ['review_required', 'preparing', 'cancelled'],
  review_required: ['new', 'preparing', 'cancelled'],
  preparing: ['ready', 'review_required', 'cancelled'],
  ready: ['handed_to_courier', 'completed', 'preparing', 'cancelled'],
  handed_to_courier: ['completed'],
  completed: [],
  cancelled: [],
};

const TERMINAL = new Set<FulfilmentStatus>(['completed', 'cancelled']);

export function evaluateTransition(
  order: OrderTransitionState,
  to: FulfilmentStatus,
): TransitionDecision {
  const from = order.fulfilmentStatus;
  const decision: TransitionDecision = { from, to, allowed: false };
  if (TERMINAL.has(from)) {
    return { ...decision, error: 'terminal_status' };
  }
  if (!NEXT[from].includes(to)) {
    return { ...decision, error: 'transition_not_allowed' };
  }
  if (to === 'ready' && order.paymentStatus !== 'paid') {
    return { ...decision, error: 'payment_not_settled' };
  }
  if (
    to === 'handed_to_courier' &&
    order.deliveryMethod !== 'courier_cy' &&
    order.deliveryMethod !== 'post_international'
  ) {
    return { ...decision, error: 'delivery_method_not_allowed' };
  }
  if (from === 'ready' && to === 'completed' && order.deliveryMethod !== 'collection') {
    return { ...decision, error: 'delivery_method_not_allowed' };
  }
  if (to === 'cancelled') {
    return { from, to, allowed: true, requiredPermission: 'order.cancel' };
  }
  return { from, to, allowed: true };
}

/** Transitions the UI can offer from the current state, including guarded ones that are not allowed. */
export function allowedTransitions(order: OrderTransitionState): TransitionDecision[] {
  return NEXT[order.fulfilmentStatus].map((to) => evaluateTransition(order, to));
}
