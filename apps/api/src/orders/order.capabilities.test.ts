import type { Grant, ScopeType } from '@bp/domain';
import { describe, expect, it } from 'vitest';
import { assigneeCandidate, assigneeGrantsAllow, orderCapabilities } from './order.service';

const STORE = 'store-a';
const OTHER = 'store-b';
const LOCATION = 'location-a';

describe('order action scope', () => {
  it('lets claim and print follow the order store, not a company-wide view', () => {
    const grants = [
      grant('order.view', 'company'),
      grant('order.claim', 'store', STORE),
      grant('print.submit', 'store', STORE),
    ];
    const own = orderCapabilities(grants, STORE, LOCATION);
    const other = orderCapabilities(grants, OTHER, LOCATION);
    expect(own.claim).toBe(true);
    expect(own.printSubmit).toBe(true);
    expect(own.assign).toBe(false);
    expect(own.edit).toBe(false);
    expect(other.claim).toBe(false);
    expect(other.printSubmit).toBe(false);
  });

  it('treats order.assign as enough to claim', () => {
    const grants = [grant('order.assign', 'store', STORE)];
    expect(orderCapabilities(grants, STORE, LOCATION).claim).toBe(true);
    expect(orderCapabilities(grants, STORE, LOCATION).assign).toBe(true);
  });
});

describe('assignee candidates', () => {
  it('lists only members assertAssignee would accept who can also claim or move the order', () => {
    const transitionOnly = [grant('order.transition', 'store', STORE)];
    const viewOnly = [grant('order.view', 'store', STORE)];
    const viewAndTransition = [grant('order.view', 'store', STORE), grant('order.transition', 'store', STORE)];
    const companyViewStoreClaim = [grant('order.view', 'company'), grant('order.claim', 'store', STORE)];
    const claimOnAnotherStore = [grant('order.view', 'company'), grant('order.claim', 'store', OTHER)];

    expect(assigneeGrantsAllow(transitionOnly, STORE, LOCATION)).toBe(false);
    expect(assigneeCandidate(transitionOnly, STORE, LOCATION)).toBe(false);
    expect(assigneeGrantsAllow(viewOnly, STORE, LOCATION)).toBe(true);
    expect(assigneeCandidate(viewOnly, STORE, LOCATION)).toBe(false);
    expect(assigneeCandidate(viewAndTransition, STORE, LOCATION)).toBe(true);
    expect(assigneeCandidate(companyViewStoreClaim, STORE, LOCATION)).toBe(true);
    expect(assigneeCandidate(claimOnAnotherStore, STORE, LOCATION)).toBe(false);
  });
});

function grant(permission: string, scopeType: ScopeType, scopeId: string | null = null): Grant {
  return { permission, scopeType, scopeId: scopeType === 'company' ? null : scopeId };
}
