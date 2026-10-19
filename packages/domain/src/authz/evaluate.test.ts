import { describe, expect, it } from 'vitest';
import { can, canGrant, grantsForAssignment, type Grant } from './evaluate';
import { BASE_TEMPLATE, roleTemplate } from './role-templates';

const STORE_A = '11111111-1111-7111-8111-111111111111';
const STORE_B = '22222222-2222-7222-8222-222222222222';

function grant(permission: string, scopeType: Grant['scopeType'], scopeId: string | null = null): Grant {
  return { permission, scopeType, scopeId };
}

function companyGrants(permissions: readonly string[]): Grant[] {
  return permissions.map((permission) => grant(permission, 'company'));
}

describe('can', () => {
  it('lets a company grant cover a store resource and a bare permission check', () => {
    const grants = [grant('order.view', 'company')];
    expect(can(grants, 'order.view')).toBe(true);
    expect(can(grants, 'order.view', { type: 'store', id: STORE_A })).toBe(true);
    expect(can(grants, 'invoice.view')).toBe(false);
  });

  it('limits a store grant to that store and grants nothing at company level', () => {
    const grants = [grant('order.view', 'store', STORE_A)];
    expect(can(grants, 'order.view')).toBe(false);
    expect(can(grants, 'order.view', { type: 'company', id: null })).toBe(false);
    expect(can(grants, 'order.view', { type: 'store', id: STORE_A })).toBe(true);
    expect(can(grants, 'order.view', { type: 'store', id: STORE_B })).toBe(false);
    expect(can(grants, 'order.view', { type: 'location', id: STORE_A })).toBe(false);
    expect(can(grants, 'invoice.view', { type: 'store', id: STORE_A })).toBe(false);
  });

  it('matches when any of the resource scopes is granted', () => {
    const grants = [grant('printer.manage', 'location', STORE_A)];
    expect(
      can(grants, 'printer.manage', [
        { type: 'store', id: STORE_B },
        { type: 'location', id: STORE_A },
      ]),
    ).toBe(true);
  });
});

describe('assignment scope', () => {
  it('gives store-scoped fulfilment order.view for that store only', () => {
    const grants = grantsForAssignment(roleTemplate('FS').permissions, { type: 'store', id: STORE_A });
    expect(can(grants, 'order.view', { type: 'store', id: STORE_A })).toBe(true);
    expect(can(grants, 'order.view', { type: 'store', id: STORE_B })).toBe(false);
    expect(can(grants, 'order.view')).toBe(false);
    expect(can(grants, 'catalog.view')).toBe(false);
    expect(can(grants, 'catalog.view', { type: 'store', id: STORE_A })).toBe(false);
    expect(can(grants, 'company.view')).toBe(false);
  });

  it('gives a store-scoped administrator no member.manage', () => {
    const grants = grantsForAssignment(roleTemplate('CA').permissions, { type: 'store', id: STORE_A });
    expect(can(grants, 'member.manage')).toBe(false);
    expect(can(grants, 'member.manage', { type: 'store', id: STORE_A })).toBe(false);
    expect(can(grants, 'order.view', { type: 'store', id: STORE_A })).toBe(true);
  });

  it('gives company-wide BASE catalog.view and company.view', () => {
    const grants = grantsForAssignment(BASE_TEMPLATE.permissions, { type: 'company', id: null });
    expect(can(grants, 'catalog.view')).toBe(true);
    expect(can(grants, 'company.view')).toBe(true);
    expect(can(grants, 'order.view')).toBe(false);
  });
});

describe('canGrant', () => {
  const administrator = roleTemplate('CA');
  const fulfilment = roleTemplate('FS');

  it('allows a company-wide actor to grant a role at company or narrower scope', () => {
    const actor = companyGrants(administrator.permissions);
    expect(canGrant(actor, administrator, { type: 'company', id: null })).toBe(true);
    expect(canGrant(actor, fulfilment, { type: 'store', id: STORE_A })).toBe(true);
  });

  it('refuses a grant when the actor is missing a permission or only holds a narrower scope', () => {
    const almostAdmin = companyGrants(administrator.permissions.filter((key) => key !== 'company.bank.manage'));
    expect(canGrant(almostAdmin, administrator, { type: 'company', id: null })).toBe(false);

    const storeActor = administrator.permissions.map((permission) => grant(permission, 'store', STORE_A));
    expect(canGrant(storeActor, administrator, { type: 'company', id: null })).toBe(false);
    expect(canGrant(storeActor, fulfilment, { type: 'store', id: STORE_A })).toBe(true);
    expect(canGrant(storeActor, fulfilment, { type: 'store', id: STORE_B })).toBe(false);
    expect(canGrant(storeActor, fulfilment, { type: 'location', id: STORE_A })).toBe(false);
  });

  it('treats company scope as broader than a store-scoped order.view', () => {
    const actor = [grant('order.view', 'company')];
    expect(canGrant(actor, { permissions: ['order.view'] }, { type: 'store', id: STORE_A })).toBe(true);
    expect(canGrant([grant('order.view', 'store', STORE_A)], { permissions: ['order.view'] }, { type: 'company', id: null })).toBe(
      false,
    );
  });
});
