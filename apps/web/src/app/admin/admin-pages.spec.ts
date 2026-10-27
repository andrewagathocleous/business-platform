import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection, type Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanyContextStore } from '../core/company-context.store';
import type { Grant } from '../core/models';
import { SessionStore } from '../core/session.store';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { AuditPage } from './audit-page';
import { AutomationPage } from './automation-page';
import { absoluteInviteLink, MembersPage } from './members-page';
import { PrintersPage } from './printers-page';

const LINK = '/api/auth/oidc/start?redirect=/&invitation=once-token-d3';

describe('MembersPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows an invitation link once and does not store it', async () => {
    const local = vi.spyOn(Storage.prototype, 'setItem');
    const { fixture, http } = await setup(MembersPage, ['member.invite']);
    flushMembers(http);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    component.inviteEmail.set('new.person@example.test');
    component.inviteRole.set('BASE');
    component.invite();
    const post = http.expectOne('/api/c/company-1/invitations');
    expect(post.request.body).toEqual({
      email: 'new.person@example.test',
      assignments: [{ roleKey: 'BASE', scopeType: 'company', scopeId: null }],
    });
    post.flush({ invitation: { link: LINK } });
    fixture.detectChanges();
    const text = textOf(fixture);
    expect(text).toContain('This link is shown only once. No email was sent.');
    expect(text).toContain(LINK);
    expect(stored(local)).not.toContain('once-token-d3');
    button(fixture, 'Close').click();
    fixture.detectChanges();
    expect(textOf(fixture)).not.toContain('once-token-d3');
    expect(component.inviteLink()).toBeNull();
    expect(stored(local)).not.toContain('once-token-d3');
    http.verify();
  });

  it('shows an absolute invite link and reports copy success or a missing clipboard', async () => {
    expect(absoluteInviteLink(LINK, 'http://127.0.0.1:4300')).toBe(`http://127.0.0.1:4300${LINK}`);
    expect(
      absoluteInviteLink('https://id.example.test/start?invitation=once', 'http://127.0.0.1:4300'),
    ).toBe('https://id.example.test/start?invitation=once');
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { fixture, http } = await setup(MembersPage, ['member.invite']);
    flushMembers(http);
    fixture.detectChanges();
    fixture.componentInstance.inviteEmail.set('new.person@example.test');
    fixture.componentInstance.inviteRole.set('BASE');
    fixture.componentInstance.invite();
    const post = http.expectOne('/api/c/company-1/invitations');
    post.flush({ invitation: { link: LINK } });
    fixture.detectChanges();
    expect(textOf(fixture)).toContain(`${location.origin}${LINK}`);
    button(fixture, 'Copy link').click();
    await Promise.resolve();
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('Copied');
    expect(writeText).toHaveBeenCalledWith(`${location.origin}${LINK}`);

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    button(fixture, 'Copy link').click();
    fixture.detectChanges();
    expect(textOf(fixture)).toContain(
      'The clipboard is not available. Select the link and copy it yourself.',
    );
    http.verify();
  });

  it('keeps member action labels short and the name in the accessible name', async () => {
    const { fixture, http } = await setup(MembersPage, ['member.manage', 'member.sessions.revoke']);
    http.expectOne('/api/c/company-1/members').flush({
      members: [
        {
          membershipId: 'member-1',
          email: 'admin.a@example.test',
          displayName: 'Admin A (fictional)',
          status: 'active',
          assignments: [
            { roleKey: 'OWNER', roleName: 'Owner', scopeType: 'company', scopeId: null },
          ],
        },
      ],
    });
    http.expectOne('/api/c/company-1/roles').flush({ roles: [] });
    http.expectOne('/api/c/company-1/locations').flush({ locations: [] });
    http.expectOne('/api/c/company-1/order-filters').flush({ stores: [] });
    fixture.detectChanges();
    const roles = namedButton(fixture, 'Change roles for Admin A (fictional)');
    const suspend = namedButton(fixture, 'Suspend Admin A (fictional)');
    const revoke = namedButton(fixture, 'Revoke sessions for Admin A (fictional)');
    expect(roles.textContent.trim()).toBe('Roles');
    expect(suspend.textContent.trim()).toBe('Suspend');
    expect(revoke.textContent.trim()).toBe('Revoke sessions');
    http.verify();
  });

  it('clears a shown invitation when the company changes and ignores a late response', async () => {
    const { fixture, http } = await setup(MembersPage, ['member.invite']);
    flushMembers(http);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    component.inviteEmail.set('new.person@example.test');
    component.inviteRole.set('BASE');
    component.invite();
    const post = http.expectOne('/api/c/company-1/invitations');
    post.flush({ invitation: { link: LINK } });
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('once-token-d3');
    component.open('company-2');
    http.expectOne('/api/c/company-2/members').flush({ members: [] });
    http.expectOne('/api/c/company-2/roles').flush({ roles: [] });
    http.expectOne('/api/c/company-2/locations').flush({ locations: [] });
    http.expectOne('/api/c/company-2/order-filters').flush({ stores: [] });
    fixture.detectChanges();
    expect(component.inviteLink()).toBeNull();
    expect(textOf(fixture)).not.toContain('once-token-d3');

    component.companyId.set('company-1');
    component.inviteEmail.set('late.person@example.test');
    component.inviteRole.set('BASE');
    component.invite();
    const late = http.expectOne('/api/c/company-1/invitations');
    component.open('company-2');
    http.match('/api/c/company-2/members').forEach((request) => {
      request.flush({ members: [] });
    });
    http.match('/api/c/company-2/roles').forEach((request) => {
      request.flush({ roles: [] });
    });
    http.match('/api/c/company-2/locations').forEach((request) => {
      request.flush({ locations: [] });
    });
    http.match('/api/c/company-2/order-filters').forEach((request) => {
      request.flush({ stores: [] });
    });
    if (!late.cancelled) {
      late.flush({ invitation: { link: LINK } });
    }
    fixture.detectChanges();
    expect(component.inviteLink()).toBeNull();
    expect(textOf(fixture)).not.toContain('once-token-d3');
    http.verify();
  });

  it('releases member actions when a company change cancels an invitation', async () => {
    const { fixture, http } = await setup(MembersPage, ['member.invite', 'member.manage']);
    http.expectOne('/api/c/company-1/members').flush({
      members: [memberRow('user-1', false, 'Ada Admin', 'active')],
    });
    http
      .expectOne('/api/c/company-1/roles')
      .flush({ roles: [{ key: 'BASE', name: 'Staff baseline' }] });
    http.expectOne('/api/c/company-1/locations').flush({ locations: [] });
    http.expectOne('/api/c/company-1/order-filters').flush({ stores: [] });
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const member = component.members()[0];
    if (!member) {
      throw new Error('missing member');
    }
    component.setStatus(member);
    const patch = http.expectOne('/api/c/company-1/members/user-1');
    expect(component.busy()).toBe(true);
    component.open('company-2');
    http.expectOne('/api/c/company-2/members').flush({ members: [] });
    http
      .expectOne('/api/c/company-2/roles')
      .flush({ roles: [{ key: 'BASE', name: 'Staff baseline' }] });
    http.expectOne('/api/c/company-2/locations').flush({ locations: [] });
    http.expectOne('/api/c/company-2/order-filters').flush({ stores: [] });
    expect(component.busy()).toBe(false);
    component.inviteEmail.set('new.person@example.test');
    component.inviteRole.set('BASE');
    component.invite();
    const post = http.expectOne('/api/c/company-2/invitations');
    expect(component.busy()).toBe(true);
    patch.flush({ member: memberRow('user-1', false, 'Ada Admin', 'suspended') });
    expect(component.busy()).toBe(true);
    expect(component.inviteLink()).toBeNull();
    post.flush({ invitation: { link: LINK } });
    expect(component.busy()).toBe(false);
    expect(component.inviteLink()).toBe(LINK);
    http.verify();
  });

  it('does not show an invitation that arrives after the page is destroyed', async () => {
    const { fixture, http } = await setup(MembersPage, ['member.invite']);
    flushMembers(http);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    component.inviteEmail.set('new.person@example.test');
    component.inviteRole.set('BASE');
    component.invite();
    const post = http.expectOne('/api/c/company-1/invitations');
    fixture.destroy();
    if (!post.cancelled) {
      post.flush({ invitation: { link: LINK } });
    }
    expect(component.inviteLink()).toBeNull();
  });

  it('hides role, status and session actions the API would reject for that member', async () => {
    const { fixture, http } = await setup(MembersPage, ['member.manage', 'member.sessions.revoke']);
    TestBed.inject(SessionStore).user.set({
      id: 'user-self',
      email: 'admin.a@example.test',
      displayName: 'Admin A (fictional)',
      locale: 'en',
      isPlatformOwner: false,
    });
    http.expectOne('/api/c/company-1/members').flush({
      members: [
        memberRow('user-self', false, 'Admin A (fictional)', 'active'),
        memberRow('user-other', false, 'Other Person', 'active'),
        memberRow('user-owner', true, 'Platform Owner', 'active'),
      ],
    });
    http.expectOne('/api/c/company-1/roles').flush({ roles: [] });
    http.expectOne('/api/c/company-1/locations').flush({ locations: [] });
    http.expectOne('/api/c/company-1/order-filters').flush({ stores: [] });
    fixture.detectChanges();
    const root = element(fixture);
    expect(root.querySelector('[aria-label="Suspend Admin A (fictional)"]')).toBeNull();
    expect(root.querySelector('[aria-label="Change roles for Admin A (fictional)"]')).toBeNull();
    expect(root.querySelector('[aria-label="Revoke sessions for Admin A (fictional)"]')).toBeNull();
    expect(root.querySelector('[aria-label="Suspend Platform Owner"]')).toBeNull();
    expect(namedButton(fixture, 'Suspend Other Person')).toBeInstanceOf(HTMLButtonElement);
    http.verify();
  });

  it('uses outlined danger for suspend and revoke, and secondary for reactivate', async () => {
    const { fixture, http } = await setup(MembersPage, ['member.manage', 'member.sessions.revoke']);
    http.expectOne('/api/c/company-1/members').flush({
      members: [
        memberRow('user-1', false, 'Ada Admin', 'active'),
        memberRow('user-2', false, 'Nia Admin', 'suspended'),
      ],
    });
    http.expectOne('/api/c/company-1/roles').flush({ roles: [] });
    http.expectOne('/api/c/company-1/locations').flush({ locations: [] });
    http.expectOne('/api/c/company-1/order-filters').flush({ stores: [] });
    fixture.detectChanges();
    const suspend = namedButton(fixture, 'Suspend Ada Admin');
    const revoke = namedButton(fixture, 'Revoke sessions for Ada Admin');
    const reactivate = namedButton(fixture, 'Reactivate Nia Admin');
    expect(suspend.classList.contains('p-button-outlined')).toBe(true);
    expect(suspend.classList.contains('p-button-danger')).toBe(true);
    expect(revoke.classList.contains('p-button-outlined')).toBe(true);
    expect(reactivate.classList.contains('p-button-secondary')).toBe(true);
    expect(reactivate.classList.contains('p-button-danger')).toBe(false);
    http.verify();
  });

  it('does not wrap role lines in paragraphs', async () => {
    const { fixture, http } = await setup(MembersPage, ['member.view']);
    http.expectOne('/api/c/company-1/members').flush({
      members: [memberRow('user-1', false, 'Ada Admin', 'active')],
    });
    http.expectOne('/api/c/company-1/roles').flush({ roles: [] });
    http.expectOne('/api/c/company-1/locations').flush({ locations: [] });
    http.expectOne('/api/c/company-1/order-filters').flush({ stores: [] });
    fixture.detectChanges();
    const row = element(fixture).querySelector('tbody tr');
    if (!(row instanceof HTMLTableRowElement)) {
      throw new Error('missing member row');
    }
    expect(row.cells[2]?.querySelector('p')).toBeNull();
    expect(row.cells[2]?.textContent).toContain('Owner (Company)');
    http.verify();
  });
});

describe('AutomationPage', () => {
  it('requires a reason before a switch changes', async () => {
    const { fixture, http } = await setup(AutomationPage, ['automation.view', 'automation.manage']);
    flushAutomation(http, []);
    fixture.detectChanges();
    button(fixture, 'Turn off printing').click();
    fixture.detectChanges();
    const confirm = button(fixture, 'Confirm');
    expect(confirm.disabled).toBe(true);
    confirm.click();
    expect(http.match((request) => request.url.includes('/switches/'))).toHaveLength(0);
    const reason = textarea(fixture);
    reason.value = 'Printing paused for the demo';
    reason.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(button(fixture, 'Confirm').disabled).toBe(false);
    button(fixture, 'Confirm').click();
    const put = http.expectOne('/api/c/company-1/automation/switches/printing');
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({ enabled: false, reason: 'Printing paused for the demo' });
    put.flush({ key: 'printing', enabled: false, reason: 'Printing paused for the demo' });
    http.expectOne('/api/c/company-1/automation/switches').flush({ switches: [] });
    http.verify();
  });

  it('offers print release and cancel only for the statuses the backend allows', async () => {
    const { fixture, http } = await setup(AutomationPage, [
      'automation.view',
      'automation.replay',
      'print.submit',
    ]);
    flushAutomation(http, [
      job('queued', 'slip-queued'),
      job('held', 'slip-held'),
      job('uncertain', 'slip-uncertain'),
      job('submitted', 'slip-submitted'),
      job('cancelled', 'slip-cancelled'),
    ]);
    fixture.detectChanges();
    expect(namesIn(fixture, 'slip-queued')).toEqual(['Cancel']);
    expect(namesIn(fixture, 'slip-held').sort()).toEqual(['Cancel', 'Release']);
    expect(namesIn(fixture, 'slip-uncertain')).toEqual(['Cancel']);
    expect(namesIn(fixture, 'slip-submitted')).toEqual([]);
    expect(namesIn(fixture, 'slip-cancelled')).toEqual([]);
    expect(textOf(fixture)).toContain('Held — printing is switched off');
    expect(textOf(fixture)).toContain('Simulated printer');
    http.verify();
  });

  it('hides cancel when that print job is outside print.submit scope', async () => {
    const { fixture, http } = await setup(AutomationPage, ['automation.view', 'print.submit']);
    flushAutomation(http, [
      { ...job('queued', 'slip-a'), can: { cancel: true, release: false } },
      { ...job('queued', 'slip-b'), can: { cancel: false, release: false } },
    ]);
    fixture.detectChanges();
    expect(namesIn(fixture, 'slip-a')).toEqual(['Cancel']);
    expect(namesIn(fixture, 'slip-b')).toEqual([]);
    http.verify();
  });

  it('shows the switch reason, actor and time on separate lines', async () => {
    const { fixture, http } = await setup(AutomationPage, ['automation.view']);
    http.expectOne('/api/c/company-1/automation/switches').flush({
      switches: [
        {
          key: 'printing',
          enabled: true,
          reason: 'd3 switch on',
          actorLabel: 'Ada Admin',
          updatedAt: '2026-03-01T10:00:00.000Z',
        },
      ],
    });
    http
      .expectOne((request) => request.url === '/api/c/company-1/automation/jobs')
      .flush({
        jobs: [],
        page: 1,
        pageSize: 20,
        total: 0,
      });
    http
      .expectOne((request) => request.url === '/api/c/company-1/print-jobs')
      .flush({
        printJobs: [],
        page: 1,
        pageSize: 20,
        total: 0,
      });
    fixture.detectChanges();
    const change = element(fixture).querySelector('.last-change');
    if (!(change instanceof HTMLElement)) {
      throw new Error('missing last change');
    }
    const lines = [...change.querySelectorAll(':scope > span')].map((item) =>
      item.textContent.trim(),
    );
    expect(lines[0]).toBe('d3 switch on');
    expect(lines[1]).toBe('Ada Admin');
    expect(lines[2]).toContain('01/03/2026');
    expect(lines[2]?.startsWith('d3')).toBe(false);
    http.verify();
  });
});

describe('AuditPage', () => {
  it('renders audit details as text', async () => {
    const { fixture, http } = await setup(AuditPage, ['audit.view']);
    const audit = http.expectOne((request) => request.url === '/api/c/company-1/audit-events');
    audit.flush({
      events: [
        {
          id: 'event-1',
          occurredAt: '2026-03-01T10:00:00.000Z',
          actorLabel: 'Ada Admin',
          action: 'automation_switch.updated',
          objectType: 'automation_switch',
          objectId: null,
          outcome: 'success',
          correlationId: 'corr-1',
          details: { note: '<b>secret</b>' },
        },
      ],
      limit: 50,
      offset: 0,
      hasMore: false,
    });
    fixture.detectChanges();
    button(fixture, 'Details').click();
    fixture.detectChanges();
    const root = element(fixture);
    const pre = root.querySelector('pre');
    expect(pre).toBeInstanceOf(HTMLElement);
    expect(pre?.textContent).toContain('<b>secret</b>');
    expect(pre?.querySelector('b')).toBeNull();
    expect(root.querySelector('b')).toBeNull();
    http.verify();
  });

  it('shows the outcome once and shortens object and correlation ids', async () => {
    const { fixture, http } = await setup(AuditPage, ['audit.view']);
    http
      .expectOne((request) => request.url === '/api/c/company-1/audit-events')
      .flush({
        events: [
          {
            id: 'event-1',
            occurredAt: '2026-03-01T10:00:00.000Z',
            actorLabel: 'Ada Admin',
            action: 'client.updated',
            objectType: 'client',
            objectId: 'abcdef12-rest-of-object',
            outcome: 'success',
            correlationId: 'fedcba98-rest-of-correlation',
            details: { note: 'kept' },
          },
        ],
        limit: 50,
        offset: 0,
        hasMore: false,
      });
    fixture.detectChanges();
    const row = element(fixture).querySelector('tbody tr');
    if (!(row instanceof HTMLTableRowElement)) {
      throw new Error('missing audit row');
    }
    const outcome = row.cells[4];
    expect(outcome?.textContent.match(/Success/g)).toHaveLength(1);
    expect(outcome?.querySelector('p-tag, .p-tag')).toBeInstanceOf(Element);
    const objectId = row.querySelector('.id-text');
    expect(objectId?.textContent).toBe('…f-object');
    expect(objectId?.getAttribute('title')).toBe('abcdef12-rest-of-object');
    const correlation = row.querySelectorAll('.id-text')[1];
    expect(correlation?.textContent).toBe('…relation');
    expect(correlation?.getAttribute('title')).toBe('fedcba98-rest-of-correlation');
    expect(namedButton(fixture, 'Copy object id').textContent.trim()).toBe('Copy');
    expect(namedButton(fixture, 'Copy correlation id').textContent.trim()).toBe('Copy');
    expect(textOf(fixture)).not.toContain('abcdef12-rest-of-object');
    http.verify();
  });

  it('shows the last 8 characters of uuid v7 values created in the same second', async () => {
    const { fixture, http } = await setup(AuditPage, ['audit.view']);
    http
      .expectOne((request) => request.url === '/api/c/company-1/audit-events')
      .flush({
        events: [],
        limit: 50,
        offset: 0,
        hasMore: false,
      });
    const component = fixture.componentInstance;
    const ms = Date.UTC(2026, 9, 21, 10, 0, 0);
    const first = uuidV7(ms, '11116ae84300');
    const second = uuidV7(ms + 400, '22227f10abcd');
    expect(first.slice(0, 8)).toBe(second.slice(0, 8));
    expect(first.slice(-8)).not.toBe(second.slice(-8));
    expect(component.shortId(first)).toBe('…6ae84300');
    expect(component.shortId(second)).toBe('…7f10abcd');
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    component.copyValue(first);
    expect(writeText).toHaveBeenCalledWith(first);
    http.verify();
  });

  it('sends company-timezone day bounds and an exclusive next-day end', async () => {
    const { http } = await setup(AuditPage, ['audit.view'], {
      from: '2026-10-21',
      to: '2026-10-21',
    });
    const audit = http.expectOne((request) => request.url === '/api/c/company-1/audit-events');
    expect(audit.request.params.get('to')).toBe('2026-10-21T21:00:00.000Z');
    expect(audit.request.params.get('from')).toBe('2026-10-20T21:00:00.000Z');
    audit.flush({ events: [], limit: 50, offset: 0, hasMore: false });
    http.verify();
  });

  it('does not clear valid filters when the audit request is rejected', async () => {
    const { http, navigate } = await setup(AuditPage, ['audit.view'], { action: 'client.updated' });
    const audit = http.expectOne((request) => request.url === '/api/c/company-1/audit-events');
    expect(audit.request.params.get('action')).toBe('client.updated');
    audit.flush({ message: 'bad' }, { status: 400, statusText: 'Bad Request' });
    expect(navigate).not.toHaveBeenCalledWith([], expect.objectContaining({ queryParams: {} }));
    http.verify();
  });
});

describe('PrintersPage', () => {
  it('shows the saved printer after the printer list arrives', async () => {
    const { fixture, http } = await setup(PrintersPage, ['automation.view']);
    const printers = http.expectOne('/api/c/company-1/printers');
    const locations = http.expectOne('/api/c/company-1/locations');
    const mappings = http.expectOne('/api/c/company-1/printer-mappings');
    locations.flush({ locations: [{ id: 'loc-1', name: 'Demo Shop – Nicosia' }] });
    mappings.flush({
      mappings: [
        {
          locationId: 'loc-1',
          documentType: 'packing_slip',
          printerId: 'printer-1',
          paperSize: 'A4',
          copies: 1,
        },
      ],
    });
    fixture.detectChanges();
    printers.flush({
      printers: [
        {
          id: 'printer-1',
          locationId: 'loc-1',
          provider: 'mock',
          name: 'Mock LaserJet (online)',
          paperSizes: ['A4', 'A6'],
          status: 'online',
          lastSeenAt: null,
          simulationLabel: 'Simulated — no physical printing',
        },
      ],
    });
    fixture.detectChanges();
    const table = element(fixture).querySelector('.mapping-table');
    if (!(table instanceof HTMLElement)) {
      throw new Error('missing mapping table');
    }
    const row = [...table.querySelectorAll('tr')].find((item) =>
      item.textContent.includes('Packing slip'),
    );
    const select = row?.querySelector('select');
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error('missing printer select');
    }
    expect(select.value).toBe('printer-1');
    expect(select.selectedOptions[0]?.textContent).toContain('Mock LaserJet (online)');
    expect(select.selectedOptions[0]?.textContent).not.toContain('Choose a printer');
    http.verify();
  });

  it('enables save mapping only when the row has a printer, a paper size and unsaved changes', async () => {
    const { fixture, http } = await setup(PrintersPage, ['printer.manage']);
    flushPrinters(http);
    fixture.detectChanges();
    const packingSave = mappingSave(fixture, 'Packing slip');
    const giftSave = mappingSave(fixture, 'Gift message');
    expect(packingSave.disabled).toBe(true);
    expect(giftSave.disabled).toBe(true);
    const packing = fixture.componentInstance
      .mappings()
      .find((row) => row.documentType === 'packing_slip');
    if (!packing) {
      throw new Error('missing packing row');
    }
    fixture.componentInstance.setPaper(packing, inputEvent('A6'));
    fixture.detectChanges();
    expect(mappingSave(fixture, 'Packing slip').disabled).toBe(false);
    expect(mappingSave(fixture, 'Gift message').disabled).toBe(true);
    http.verify();
  });

  it('keeps an unsaved mapping when another row is saved', async () => {
    const { fixture, http } = await setup(PrintersPage, ['printer.manage']);
    flushPrinters(http);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const gift = component.mappings().find((row) => row.documentType === 'gift_message');
    const packing = component.mappings().find((row) => row.documentType === 'packing_slip');
    if (!gift || !packing) {
      throw new Error('missing mapping rows');
    }
    component.setPrinter(gift, inputEvent('printer-1'));
    component.setPaper(gift, inputEvent('A6'));
    expect(component.mappings().find((row) => row.documentType === 'gift_message')?.paperSize).toBe(
      'A6',
    );
    component.saveMapping(packing);
    const put = http.expectOne('/api/c/company-1/printer-mappings');
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toMatchObject({
      documentType: 'packing_slip',
      printerId: 'printer-1',
      paperSize: 'A4',
    });
    put.flush({});
    flushPrinters(http);
    expect(component.mappings().find((row) => row.documentType === 'gift_message')?.paperSize).toBe(
      'A6',
    );
    expect(component.mappings().find((row) => row.documentType === 'gift_message')?.printerId).toBe(
      'printer-1',
    );
    http.verify();
  });
});

async function setup<T>(
  component: Type<T>,
  permissions: string[],
  query: Record<string, string> = {},
): Promise<{
  fixture: ComponentFixture<T>;
  http: HttpTestingController;
  navigate: ReturnType<typeof vi.fn>;
}> {
  const navigate = vi.fn(() => Promise.resolve(true));
  const queryMap = convertToParamMap(query);
  await TestBed.configureTestingModule({
    imports: [component],
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTransloco({
        config: {
          availableLangs: ['en', 'el'],
          defaultLang: 'en',
          reRenderOnLangChange: true,
          prodMode: true,
        },
        loader: AppTranslocoLoader,
      }),
      {
        provide: ActivatedRoute,
        useValue: {
          parent: { paramMap: of(convertToParamMap({ companyId: 'company-1' })) },
          paramMap: of(convertToParamMap({})),
          queryParamMap: of(queryMap),
          snapshot: {
            paramMap: convertToParamMap({}),
            queryParamMap: queryMap,
          },
        },
      },
      { provide: Router, useValue: { navigate } },
    ],
  }).compileComponents();
  const transloco = TestBed.inject(TranslocoService);
  await firstValueFrom(transloco.load('en'));
  transloco.setActiveLang('en');
  TestBed.inject(CompanyContextStore).grants.set(permissions.map(grant));
  const fixture = TestBed.createComponent(component);
  fixture.detectChanges();
  return { fixture, http: TestBed.inject(HttpTestingController), navigate };
}

function flushMembers(http: HttpTestingController): void {
  http.expectOne('/api/c/company-1/members').flush({ members: [] });
  http
    .expectOne('/api/c/company-1/roles')
    .flush({ roles: [{ key: 'BASE', name: 'Staff baseline' }] });
  http.expectOne('/api/c/company-1/locations').flush({ locations: [] });
  http.expectOne('/api/c/company-1/order-filters').flush({ stores: [] });
}

function flushAutomation(
  http: HttpTestingController,
  printJobs: {
    id: string;
    documentType: string;
    status: string;
    simulationLabel: string | null;
    can?: { cancel: boolean; release: boolean };
  }[],
): void {
  http.expectOne('/api/c/company-1/automation/switches').flush({
    switches: [
      { key: 'printing', enabled: true, reason: 'Seed', updatedAt: '2026-03-01T10:00:00.000Z' },
    ],
  });
  http
    .expectOne((request) => request.url === '/api/c/company-1/automation/jobs')
    .flush({
      jobs: [],
      page: 1,
      pageSize: 20,
      total: 0,
    });
  http
    .expectOne((request) => request.url === '/api/c/company-1/print-jobs')
    .flush({
      printJobs,
      page: 1,
      pageSize: 20,
      total: printJobs.length,
    });
}

function job(
  status: string,
  documentType: string,
): {
  id: string;
  documentType: string;
  status: string;
  simulationLabel: string | null;
  can: { cancel: boolean; release: boolean };
} {
  return {
    id: documentType,
    documentType,
    status,
    simulationLabel: status === 'held' ? 'Simulated — no physical printing' : null,
    can: { cancel: true, release: true },
  };
}

function memberRow(
  userId: string,
  isPlatformOwner: boolean,
  displayName: string,
  status: string,
): Record<string, unknown> {
  return {
    membershipId: userId,
    userId,
    email: `${userId}@example.test`,
    displayName,
    status,
    isPlatformOwner,
    assignments: [{ roleKey: 'OWNER', roleName: 'Owner', scopeType: 'company', scopeId: null }],
  };
}

function uuidV7(unixMs: number, tail: string): string {
  const time = unixMs.toString(16).padStart(12, '0');
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7000-8000-${tail.padStart(12, '0')}`;
}

function flushPrinters(http: HttpTestingController): void {
  http
    .expectOne('/api/c/company-1/locations')
    .flush({ locations: [{ id: 'loc-1', name: 'Demo Shop – Nicosia' }] });
  http.expectOne('/api/c/company-1/printer-mappings').flush({
    mappings: [
      {
        locationId: 'loc-1',
        documentType: 'packing_slip',
        printerId: 'printer-1',
        paperSize: 'A4',
        copies: 1,
      },
    ],
  });
  http.expectOne('/api/c/company-1/printers').flush({
    printers: [
      {
        id: 'printer-1',
        locationId: 'loc-1',
        provider: 'mock',
        name: 'Mock LaserJet (online)',
        paperSizes: ['A4', 'A6'],
        status: 'online',
        lastSeenAt: null,
        simulationLabel: 'Simulated — no physical printing',
      },
    ],
  });
}

function mappingSave(fixture: ComponentFixture<PrintersPage>, title: string): HTMLButtonElement {
  const table = element(fixture).querySelector('.mapping-table');
  const row = [...(table?.querySelectorAll('tr') ?? [])].find((item) =>
    item.textContent.includes(title),
  );
  const button = [...(row?.querySelectorAll('button') ?? [])].find((item) =>
    item.textContent.includes('Save mapping'),
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`missing save for ${title}`);
  }
  return button;
}

function inputEvent(value: string): Event {
  const input = document.createElement('input');
  input.value = value;
  const event = new Event('input');
  Object.defineProperty(event, 'target', { value: input });
  return event;
}

function grant(permission: string): Grant {
  return { permission, scopeType: 'company', scopeId: null };
}

function stored(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls
    .map((call) => call.map((part) => (typeof part === 'string' ? part : '')).join(' '))
    .join(' ');
}

function textOf(fixture: ComponentFixture<unknown>): string {
  return element(fixture).textContent;
}

function element(fixture: ComponentFixture<unknown>): HTMLElement {
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) {
    throw new Error('missing root');
  }
  return root;
}

function button(fixture: ComponentFixture<unknown>, name: string): HTMLButtonElement {
  const found = [...element(fixture).querySelectorAll('button')].find((item) =>
    item.textContent.includes(name),
  );
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`missing button ${name}`);
  }
  return found;
}

function namedButton(fixture: ComponentFixture<unknown>, name: string): HTMLButtonElement {
  const found = [...element(fixture).querySelectorAll('button')].find(
    (item) => item.getAttribute('aria-label') === name,
  );
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`missing button ${name}`);
  }
  return found;
}

function namesIn(fixture: ComponentFixture<unknown>, documentType: string): string[] {
  const row = [...element(fixture).querySelectorAll('tr')].find((item) =>
    item.textContent.includes(documentType),
  );
  if (!row) {
    throw new Error(`missing row ${documentType}`);
  }
  return [...row.querySelectorAll('button')].map((item) => item.textContent.trim());
}

function textarea(fixture: ComponentFixture<unknown>): HTMLTextAreaElement {
  const found = element(fixture).querySelector('textarea');
  if (!(found instanceof HTMLTextAreaElement)) {
    throw new Error('missing reason');
  }
  return found;
}
