import { describe, expect, it } from 'vitest';
import {
  can,
  canGrant,
  decideAccess,
  grantsForAssignment,
  membershipEscalationDenial,
  permittedScopeFilter,
  type Grant,
  type MembershipEscalation,
} from './evaluate';
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

  it('refuses self-modification, platform-owner targets and the last member.manage holder', () => {
    const actor = companyGrants(administrator.permissions);
    const otherAdmin: MembershipEscalation = {
      actorUserId: 'actor',
      actorIsPlatformOwner: false,
      targetUserId: 'target',
      targetIsPlatformOwner: false,
      otherActiveMemberManageCount: 1,
      withdrawsMemberManage: true,
    };
    expect(canGrant(actor, fulfilment, { type: 'company', id: null }, otherAdmin)).toBe(true);
    expect(membershipEscalationDenial(otherAdmin)).toBeNull();

    const self: MembershipEscalation = { ...otherAdmin, targetUserId: 'actor', otherActiveMemberManageCount: 0 };
    expect(membershipEscalationDenial(self)).toBe('self_modification');
    expect(canGrant(actor, fulfilment, { type: 'company', id: null }, self)).toBe(false);
    expect(membershipEscalationDenial({ ...self, actorIsPlatformOwner: true })).toBeNull();

    const ownerTarget: MembershipEscalation = { ...otherAdmin, targetIsPlatformOwner: true, withdrawsMemberManage: false };
    expect(membershipEscalationDenial(ownerTarget)).toBe('platform_owner_target');
    expect(canGrant(actor, fulfilment, { type: 'company', id: null }, ownerTarget)).toBe(false);
    expect(membershipEscalationDenial({ ...ownerTarget, actorIsPlatformOwner: true })).toBeNull();

    const lastAdmin: MembershipEscalation = { ...otherAdmin, otherActiveMemberManageCount: 0 };
    expect(membershipEscalationDenial(lastAdmin)).toBe('last_member_manage');
    expect(canGrant(actor, fulfilment, { type: 'company', id: null }, lastAdmin)).toBe(false);
    expect(membershipEscalationDenial({ ...lastAdmin, actorIsPlatformOwner: true })).toBeNull();
    expect(membershipEscalationDenial({ ...lastAdmin, withdrawsMemberManage: false })).toBeNull();
  });

  it('still applies rule 1 when escalation would allow the change', () => {
    const escalation: MembershipEscalation = {
      actorUserId: 'actor',
      actorIsPlatformOwner: true,
      targetUserId: 'actor',
      targetIsPlatformOwner: false,
      otherActiveMemberManageCount: 0,
      withdrawsMemberManage: true,
    };
    expect(canGrant([grant('order.view', 'company')], administrator, { type: 'company', id: null }, escalation)).toBe(false);
  });
});

describe('decideAccess', () => {
  it('forbids a company-level miss and hides an out-of-scope store', () => {
    const grants = [grant('order.view', 'store', STORE_A), grant('company.view', 'company')];
    expect(decideAccess(grants, 'company.view')).toBe('allow');
    expect(decideAccess(grants, 'member.view')).toBe('forbidden');
    expect(decideAccess(grants, 'order.view', null)).toBe('not_found');
    expect(decideAccess(grants, 'order.view', [{ type: 'store', id: STORE_A }])).toBe('allow');
    expect(decideAccess(grants, 'order.view', [{ type: 'store', id: STORE_B }])).toBe('not_found');
    expect(decideAccess(grants, 'invoice.view', [{ type: 'store', id: STORE_A }])).toBe('forbidden');
    expect(decideAccess([grant('order.view', 'company')], 'order.view', [{ type: 'store', id: STORE_B }])).toBe('allow');
  });
});

describe('permittedScopeFilter', () => {
  it('returns every id for a company grant and only the granted stores otherwise', () => {
    expect(permittedScopeFilter([grant('order.view', 'company')], 'order.view', 'store')).toEqual({ kind: 'all' });
    expect(permittedScopeFilter([grant('order.view', 'store', STORE_A)], 'order.view', 'store')).toEqual({
      kind: 'ids',
      ids: [STORE_A],
    });
    expect(permittedScopeFilter([grant('catalog.view', 'company')], 'order.view', 'store')).toEqual({ kind: 'none' });
  });
});
