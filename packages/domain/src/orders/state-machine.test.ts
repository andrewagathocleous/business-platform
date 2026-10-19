import { describe, expect, it } from 'vitest';
import {
  allowedTransitions,
  DELIVERY_METHODS,
  evaluateTransition,
  FULFILMENT_STATUSES,
  PAYMENT_STATUSES,
  type DeliveryMethod,
  type FulfilmentStatus,
  type OrderTransitionState,
  type PaymentStatus,
} from './state-machine';

const EDGES = new Set([
  'new>review_required',
  'new>preparing',
  'new>cancelled',
  'review_required>new',
  'review_required>preparing',
  'review_required>cancelled',
  'preparing>ready',
  'preparing>review_required',
  'preparing>cancelled',
  'ready>handed_to_courier',
  'ready>completed',
  'ready>preparing',
  'ready>cancelled',
  'handed_to_courier>completed',
]);

function order(
  fulfilmentStatus: FulfilmentStatus,
  paymentStatus: PaymentStatus = 'paid',
  deliveryMethod: DeliveryMethod = 'courier_cy',
): OrderTransitionState {
  return { fulfilmentStatus, paymentStatus, deliveryMethod };
}

function edgeKey(from: FulfilmentStatus, to: FulfilmentStatus): string {
  return `${from}>${to}`;
}

describe('order transitions', () => {
  it('covers every status pair for a paid courier order', () => {
    for (const from of FULFILMENT_STATUSES) {
      for (const to of FULFILMENT_STATUSES) {
        const decision = evaluateTransition(order(from), to);
        const key = edgeKey(from, to);
        if (from === 'completed' || from === 'cancelled') {
          expect(decision.allowed, key).toBe(false);
          expect(decision.error, key).toBe('terminal_status');
          continue;
        }
        if (!EDGES.has(key)) {
          expect(decision.allowed, key).toBe(false);
          expect(decision.error, key).toBe('transition_not_allowed');
          continue;
        }
        if (key === 'ready>completed') {
          expect(decision.allowed, key).toBe(false);
          expect(decision.error, key).toBe('delivery_method_not_allowed');
          continue;
        }
        expect(decision.allowed, key).toBe(true);
        if (to === 'cancelled') {
          expect(decision.requiredPermission, key).toBe('order.cancel');
        }
      }
    }
  });

  it('allows ready → completed only for collection, and handover only for courier or post', () => {
    expect(evaluateTransition(order('ready', 'paid', 'collection'), 'completed').allowed).toBe(true);
    expect(evaluateTransition(order('ready', 'paid', 'collection'), 'handed_to_courier').allowed).toBe(
      false,
    );
    expect(
      evaluateTransition(order('ready', 'paid', 'post_international'), 'handed_to_courier').allowed,
    ).toBe(true);
    expect(evaluateTransition(order('ready', 'paid', 'unknown'), 'handed_to_courier').error).toBe(
      'delivery_method_not_allowed',
    );
    expect(evaluateTransition(order('ready', 'paid', 'courier_cy'), 'completed').error).toBe(
      'delivery_method_not_allowed',
    );
  });

  it('refuses ready unless payment is settled', () => {
    for (const paymentStatus of PAYMENT_STATUSES) {
      const decision = evaluateTransition(order('preparing', paymentStatus), 'ready');
      if (paymentStatus === 'paid') {
        expect(decision.allowed).toBe(true);
      } else {
        expect(decision.allowed).toBe(false);
        expect(decision.error).toBe('payment_not_settled');
      }
    }
  });

  it('lists the UI transitions for a new paid order, including cancel with its permission', () => {
    const transitions = allowedTransitions(order('new'));
    expect(transitions.map((item) => item.to)).toEqual(['review_required', 'preparing', 'cancelled']);
    expect(transitions.every((item) => item.allowed)).toBe(true);
    expect(transitions.find((item) => item.to === 'cancelled')?.requiredPermission).toBe('order.cancel');
    expect(allowedTransitions(order('completed'))).toEqual([]);
  });

  it('uses only the documented delivery methods', () => {
    expect(DELIVERY_METHODS).toEqual(['courier_cy', 'post_international', 'collection', 'unknown']);
  });
});
