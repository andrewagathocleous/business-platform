import { HttpClient, HttpContext, HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { Subject, of, takeUntil } from 'rxjs';
import { readApiError } from '../core/api-error';
import { clipboardWrite } from '../core/clipboard';
import { CompanyContextStore } from '../core/company-context.store';
import { SessionStore } from '../core/session.store';
import { canAttempt } from '../core/nav';
import { NAVIGATE_ON_DENIED } from '../core/navigate-on-denied';
import { fieldValue } from '../orders/field-value';

type ScopeType = 'company' | 'location' | 'store';

type Assignment = {
  roleKey: string;
  roleName: string;
  scopeType: string;
  scopeId: string | null;
};

type Member = {
  membershipId: string;
  userId?: string;
  email: string;
  displayName: string;
  status: string;
  isPlatformOwner?: boolean;
  assignments: Assignment[];
};

type RoleOption = { key: string; name: string };
type Named = { id: string; name: string };

type AssignmentDraft = {
  roleKey: string;
  scopeType: ScopeType;
  scopeId: string;
};

export function absoluteInviteLink(link: string, origin: string): string {
  if (link.startsWith('https://') || link.startsWith('http://')) {
    return link;
  }
  const path = link.startsWith('/') ? link : `/${link}`;
  return `${origin}${path}`;
}

@Component({
  selector: 'bp-members-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, Button],
  template: `
    <section class="screen">
      <h1>{{ 'members.title' | transloco }}</h1>
      @if (actionError(); as message) {
        <p role="alert">{{ message }}</p>
      }
      @if (loading()) {
        <p role="status">{{ 'members.loading' | transloco }}</p>
      }
      @if (loadError()) {
        <p role="alert">{{ 'members.error' | transloco }}</p>
      }
      @if (canInvite()) {
        <form class="form-grid" (submit)="$event.preventDefault(); invite()">
          <label>
            {{ 'members.fields.email' | transloco }}
            <input [value]="inviteEmail()" (input)="inviteEmail.set(field($event))" />
          </label>
          <label>
            {{ 'members.fields.role' | transloco }}
            <select (change)="inviteRole.set(field($event))">
              <option value="" [selected]="inviteRole() === ''">
                {{ 'members.chooseRole' | transloco }}
              </option>
              @for (role of roles(); track role.key) {
                <option [value]="role.key" [selected]="role.key === inviteRole()">
                  {{ role.name }}
                </option>
              }
            </select>
          </label>
          <label>
            {{ 'members.fields.scope' | transloco }}
            <select (change)="setInviteScope($event)">
              <option value="company" [selected]="inviteScopeType() === 'company'">
                {{ 'members.scope.company' | transloco }}
              </option>
              <option value="location" [selected]="inviteScopeType() === 'location'">
                {{ 'members.scope.location' | transloco }}
              </option>
              <option value="store" [selected]="inviteScopeType() === 'store'">
                {{ 'members.scope.store' | transloco }}
              </option>
            </select>
          </label>
          @if (inviteScopeType() !== 'company') {
            <label>
              {{ 'members.fields.scopeName' | transloco }}
              <select (change)="inviteScopeId.set(field($event))">
                <option value="" [selected]="inviteScopeId() === ''">
                  {{ 'members.chooseScope' | transloco }}
                </option>
                @for (option of scopeOptions(inviteScopeType()); track option.id) {
                  <option [value]="option.id" [selected]="option.id === inviteScopeId()">
                    {{ option.name }}
                  </option>
                }
              </select>
            </label>
          }
          <div class="form-actions">
            <p-button
              type="submit"
              [label]="'members.invite' | transloco"
              [disabled]="busy()"
              (onClick)="invite()"
            />
          </div>
        </form>
      }
      <div class="table-scroll table-fit members-table">
        <table class="items">
          <thead>
            <tr>
              <th>{{ 'members.columns.name' | transloco }}</th>
              <th>{{ 'members.columns.email' | transloco }}</th>
              <th>{{ 'members.columns.roles' | transloco }}</th>
              <th>{{ 'members.columns.status' | transloco }}</th>
              @if (canManage() || canRevoke()) {
                <th>{{ 'members.columns.actions' | transloco }}</th>
              }
            </tr>
          </thead>
          <tbody>
            @for (member of members(); track member.membershipId) {
              <tr>
                <td>{{ member.displayName }}</td>
                <td>{{ member.email }}</td>
                <td>
                  @for (
                    assignment of member.assignments;
                    track assignment.roleKey + assignment.scopeType + (assignment.scopeId ?? '')
                  ) {
                    <div>{{ assignment.roleName }} ({{ scopeLabel(assignment) }})</div>
                  }
                </td>
                <td>{{ statusLabel(member.status) }}</td>
                @if (canManage() || canRevoke()) {
                  <td>
                    <div class="row-actions">
                      @if (canManage() && canActOn(member)) {
                        <p-button
                          type="button"
                          size="small"
                          severity="secondary"
                          [label]="'members.roles' | transloco"
                          [ariaLabel]="
                            'members.changeRoles' | transloco: { name: member.displayName }
                          "
                          (onClick)="startRoles(member)"
                        />
                        <p-button
                          type="button"
                          size="small"
                          [severity]="member.status === 'suspended' ? 'secondary' : 'danger'"
                          [outlined]="member.status !== 'suspended'"
                          [label]="
                            (member.status === 'suspended'
                              ? 'members.reactivateShort'
                              : 'members.suspendShort'
                            ) | transloco
                          "
                          [ariaLabel]="
                            (member.status === 'suspended'
                              ? 'members.reactivate'
                              : 'members.suspend'
                            ) | transloco: { name: member.displayName }
                          "
                          [disabled]="busy()"
                          (onClick)="setStatus(member)"
                        />
                      }
                      @if (canRevoke() && canActOn(member)) {
                        <p-button
                          type="button"
                          size="small"
                          severity="danger"
                          [outlined]="true"
                          [label]="'members.revokeShort' | transloco"
                          [ariaLabel]="'members.revoke' | transloco: { name: member.displayName }"
                          (onClick)="askRevoke(member)"
                        />
                      }
                    </div>
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>
      @if (inviteLink(); as link) {
        <div class="modal" role="presentation">
          <div
            class="dialog"
            role="dialog"
            aria-modal="true"
            data-testid="invite-dialog"
            aria-labelledby="invite-title"
          >
            <h2 id="invite-title">{{ 'members.inviteReady' | transloco }}</h2>
            <p>{{ 'members.linkOnce' | transloco }}</p>
            <p class="id-text" data-testid="accept-link">{{ absoluteLink(link) }}</p>
            @if (copyState() === 'copied') {
              <p role="status">{{ 'members.copied' | transloco }}</p>
            }
            @if (copyState() === 'unavailable') {
              <p role="status">{{ 'members.copyUnavailable' | transloco }}</p>
            }
            <div class="actions">
              <p-button
                type="button"
                severity="secondary"
                [label]="'members.copy' | transloco"
                (onClick)="copyLink()"
              />
              <p-button
                type="button"
                severity="secondary"
                [label]="'members.close' | transloco"
                (onClick)="closeInvite()"
              />
            </div>
          </div>
        </div>
      }
      @if (roleEdit(); as edit) {
        <div class="modal" role="presentation">
          <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="roles-title">
            <h2 id="roles-title">{{ 'members.changeRoles' | transloco: { name: edit.name } }}</h2>
            @for (assignment of edit.assignments; track $index) {
              <article class="repeat-item">
                <header class="repeat-head">
                  <h3>{{ 'members.fields.role' | transloco }} {{ $index + 1 }}</h3>
                  <p-button
                    type="button"
                    size="small"
                    severity="danger"
                    [label]="'members.removeRole' | transloco"
                    (onClick)="removeEdit($index)"
                  />
                </header>
                <div class="form-grid">
                  <label>
                    {{ 'members.fields.role' | transloco }}
                    <select (change)="setEditRole($index, $event)">
                      @for (role of roles(); track role.key) {
                        <option [value]="role.key" [selected]="role.key === assignment.roleKey">
                          {{ role.name }}
                        </option>
                      }
                    </select>
                  </label>
                  <label>
                    {{ 'members.fields.scope' | transloco }}
                    <select (change)="setEditScopeType($index, $event)">
                      <option value="company" [selected]="assignment.scopeType === 'company'">
                        {{ 'members.scope.company' | transloco }}
                      </option>
                      <option value="location" [selected]="assignment.scopeType === 'location'">
                        {{ 'members.scope.location' | transloco }}
                      </option>
                      <option value="store" [selected]="assignment.scopeType === 'store'">
                        {{ 'members.scope.store' | transloco }}
                      </option>
                    </select>
                  </label>
                  @if (assignment.scopeType !== 'company') {
                    <label class="span-all">
                      {{ 'members.fields.scopeName' | transloco }}
                      <select (change)="setEditScopeId($index, $event)">
                        @for (option of scopeOptions(assignment.scopeType); track option.id) {
                          <option [value]="option.id" [selected]="option.id === assignment.scopeId">
                            {{ option.name }}
                          </option>
                        }
                      </select>
                    </label>
                  }
                </div>
              </article>
            }
            <div class="actions">
              <p-button
                type="button"
                severity="secondary"
                icon="pi pi-plus"
                [label]="'members.addRole' | transloco"
                [ariaLabel]="'members.addRole' | transloco"
                (onClick)="addEdit()"
              />
              <p-button
                type="button"
                [label]="'members.saveRoles' | transloco"
                [disabled]="busy()"
                (onClick)="saveRoles()"
              />
              <p-button
                type="button"
                severity="secondary"
                [label]="'members.close' | transloco"
                (onClick)="roleEdit.set(null)"
              />
            </div>
          </div>
        </div>
      }
      @if (revokeTarget(); as member) {
        <div class="modal" role="presentation">
          <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="revoke-title">
            <h2 id="revoke-title">
              {{ 'members.revokeConfirm' | transloco: { name: member.displayName } }}
            </h2>
            <div class="actions">
              <p-button
                type="button"
                severity="danger"
                [label]="'members.revokeNow' | transloco"
                [disabled]="busy()"
                (onClick)="revoke()"
              />
              <p-button
                type="button"
                severity="secondary"
                [label]="'members.close' | transloco"
                (onClick)="revokeTarget.set(null)"
              />
            </div>
          </div>
        </div>
      }
    </section>
  `,
})
export class MembersPage {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly transloco = inject(TranslocoService);
  private readonly context = inject(CompanyContextStore);
  private readonly session = inject(SessionStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly inviteStop = new Subject<void>();

  readonly field = fieldValue;
  readonly companyId = signal('');
  readonly members = signal<Member[]>([]);
  readonly roles = signal<RoleOption[]>([]);
  readonly locations = signal<Named[]>([]);
  readonly stores = signal<Named[]>([]);
  readonly loading = signal(false);
  readonly loadError = signal(false);
  readonly busy = signal(false);
  readonly actionError = signal<string | null>(null);
  readonly inviteEmail = signal('');
  readonly inviteRole = signal('');
  readonly inviteScopeType = signal<ScopeType>('company');
  readonly inviteScopeId = signal('');
  readonly inviteLink = signal<string | null>(null);
  readonly copyState = signal<'idle' | 'copied' | 'unavailable'>('idle');
  readonly roleEdit = signal<{
    membershipId: string;
    name: string;
    assignments: AssignmentDraft[];
  } | null>(null);
  readonly revokeTarget = signal<Member | null>(null);
  private generation = 0;
  private mutationGeneration = 0;

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.inviteStop.next();
      this.inviteLink.set(null);
      this.copyState.set('idle');
    });
    const companyId$ = this.route.parent?.paramMap ?? of(emptyParams());
    companyId$.pipe(takeUntilDestroyed()).subscribe((params) => {
      this.open(params.get('companyId') ?? '');
    });
  }

  open(companyId: string): void {
    if (companyId !== this.companyId()) {
      this.generation += 1;
      this.mutationGeneration += 1;
      this.inviteStop.next();
      this.inviteLink.set(null);
      this.copyState.set('idle');
      this.roleEdit.set(null);
      this.revokeTarget.set(null);
      this.busy.set(false);
      this.actionError.set(null);
    }
    this.companyId.set(companyId);
    if (companyId.length === 0) {
      this.loading.set(false);
      return;
    }
    this.load();
  }

  canActOn(member: Member): boolean {
    const actor = this.session.user();
    if (!actor || actor.isPlatformOwner) {
      return true;
    }
    if (member.userId !== undefined && member.userId === actor.id) {
      return false;
    }
    return member.isPlatformOwner !== true;
  }

  canInvite(): boolean {
    return this.attempt('member.invite');
  }

  canManage(): boolean {
    return this.attempt('member.manage');
  }

  canRevoke(): boolean {
    return this.attempt('member.sessions.revoke');
  }

  scopeOptions(scopeType: string): Named[] {
    return scopeType === 'location' ? this.locations() : this.stores();
  }

  scopeLabel(assignment: Assignment): string {
    if (assignment.scopeType === 'company') {
      return this.transloco.translate('members.scope.company');
    }
    const named =
      assignment.scopeType === 'location'
        ? this.locations().find((item) => item.id === assignment.scopeId)
        : assignment.scopeType === 'store'
          ? this.stores().find((item) => item.id === assignment.scopeId)
          : undefined;
    return named?.name ?? assignment.scopeType;
  }

  statusLabel(status: string): string {
    if (status === 'suspended') {
      return this.transloco.translate('members.status.suspended');
    }
    if (status === 'removed') {
      return this.transloco.translate('members.status.removed');
    }
    return this.transloco.translate('members.status.active');
  }

  setInviteScope(event: Event): void {
    this.inviteScopeType.set(scopeType(fieldValue(event)));
    this.inviteScopeId.set('');
  }

  invite(): void {
    if (!this.canInvite() || !this.begin()) {
      return;
    }
    const email = this.inviteEmail().trim();
    const roleKey = this.inviteRole();
    const scopeType = this.inviteScopeType();
    const scopeId = scopeType === 'company' ? null : this.inviteScopeId();
    if (
      email.length === 0 ||
      roleKey.length === 0 ||
      (scopeType !== 'company' && (scopeId === null || scopeId.length === 0))
    ) {
      this.busy.set(false);
      return;
    }
    const generation = this.generation;
    const mutation = this.mutationGeneration;
    this.http
      .post<{ invitation: { link: string } }>(`/api/c/${this.companyId()}/invitations`, {
        email,
        assignments: [{ roleKey, scopeType, scopeId }],
      })
      .pipe(takeUntil(this.inviteStop), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (body) => {
          if (!this.finish(mutation)) {
            return;
          }
          this.inviteEmail.set('');
          this.showLink(body.invitation.link, generation);
        },
        error: (error: unknown) => {
          this.fail(mutation, error);
        },
      });
  }

  absoluteLink(link: string): string {
    const origin = typeof location === 'undefined' ? '' : location.origin;
    return absoluteInviteLink(link, origin);
  }

  copyLink(): void {
    const link = this.inviteLink();
    if (!link) {
      return;
    }
    const value = this.absoluteLink(link);
    const write = clipboardWrite();
    if (!write) {
      this.copyState.set('unavailable');
      return;
    }
    void write(value).then(
      () => {
        this.copyState.set('copied');
      },
      () => {
        this.copyState.set('unavailable');
      },
    );
  }

  closeInvite(): void {
    this.inviteLink.set(null);
    this.copyState.set('idle');
  }

  startRoles(member: Member): void {
    this.inviteLink.set(null);
    this.revokeTarget.set(null);
    this.roleEdit.set({
      membershipId: member.membershipId,
      name: member.displayName,
      assignments: member.assignments.flatMap((assignment) => {
        if (
          assignment.scopeType !== 'company' &&
          assignment.scopeType !== 'location' &&
          assignment.scopeType !== 'store'
        ) {
          return [];
        }
        return [
          {
            roleKey: assignment.roleKey,
            scopeType: assignment.scopeType,
            scopeId: assignment.scopeId ?? '',
          },
        ];
      }),
    });
  }

  setEditRole(index: number, event: Event): void {
    this.patchEdit(index, { roleKey: fieldValue(event) });
  }

  setEditScopeType(index: number, event: Event): void {
    this.patchEdit(index, { scopeType: scopeType(fieldValue(event)), scopeId: '' });
  }

  setEditScopeId(index: number, event: Event): void {
    this.patchEdit(index, { scopeId: fieldValue(event) });
  }

  addEdit(): void {
    const roleKey = this.roles()[0]?.key ?? '';
    this.roleEdit.update((edit) =>
      edit
        ? {
            ...edit,
            assignments: [...edit.assignments, { roleKey, scopeType: 'company', scopeId: '' }],
          }
        : edit,
    );
  }

  removeEdit(index: number): void {
    this.roleEdit.update((edit) =>
      edit ? { ...edit, assignments: edit.assignments.filter((_, item) => item !== index) } : edit,
    );
  }

  saveRoles(): void {
    const edit = this.roleEdit();
    if (!edit || !this.canManage() || !this.begin()) {
      return;
    }
    if (
      edit.assignments.length === 0 ||
      edit.assignments.some((item) => item.roleKey.length === 0)
    ) {
      this.busy.set(false);
      return;
    }
    if (
      edit.assignments.some((item) => item.scopeType !== 'company' && item.scopeId.length === 0)
    ) {
      this.busy.set(false);
      return;
    }
    const mutation = this.mutationGeneration;
    this.http
      .patch<{ member: Member }>(`/api/c/${this.companyId()}/members/${edit.membershipId}`, {
        assignments: edit.assignments.map((item) => ({
          roleKey: item.roleKey,
          scopeType: item.scopeType,
          scopeId: item.scopeType === 'company' ? null : item.scopeId,
        })),
      })
      .subscribe({
        next: () => {
          if (!this.finish(mutation)) {
            return;
          }
          this.roleEdit.set(null);
          this.load();
        },
        error: (error: unknown) => {
          this.fail(mutation, error);
        },
      });
  }

  setStatus(member: Member): void {
    if (!this.canManage() || !this.begin()) {
      return;
    }
    const status = member.status === 'suspended' ? 'active' : 'suspended';
    const mutation = this.mutationGeneration;
    this.http
      .patch<{ member: Member }>(`/api/c/${this.companyId()}/members/${member.membershipId}`, {
        status,
      })
      .subscribe({
        next: () => {
          if (!this.finish(mutation)) {
            return;
          }
          this.load();
        },
        error: (error: unknown) => {
          this.fail(mutation, error);
        },
      });
  }

  askRevoke(member: Member): void {
    this.inviteLink.set(null);
    this.roleEdit.set(null);
    this.revokeTarget.set(member);
  }

  revoke(): void {
    const member = this.revokeTarget();
    if (!member || !this.canRevoke() || !this.begin()) {
      return;
    }
    const mutation = this.mutationGeneration;
    this.http
      .post(`/api/c/${this.companyId()}/members/${member.membershipId}/revoke-sessions`, {})
      .subscribe({
        next: () => {
          if (!this.finish(mutation)) {
            return;
          }
          this.revokeTarget.set(null);
        },
        error: (error: unknown) => {
          this.fail(mutation, error);
        },
      });
  }

  private load(): void {
    const companyId = this.companyId();
    const generation = ++this.generation;
    this.loading.set(true);
    this.loadError.set(false);
    this.http
      .get<{ members: Member[] }>(`/api/c/${companyId}/members`, {
        context: new HttpContext().set(NAVIGATE_ON_DENIED, true),
      })
      .subscribe({
        next: (body) => {
          if (generation !== this.generation) {
            return;
          }
          this.members.set(body.members);
          this.loading.set(false);
        },
        error: () => {
          if (generation !== this.generation) {
            return;
          }
          this.loading.set(false);
          this.loadError.set(true);
        },
      });
    this.http.get<{ roles: RoleOption[] }>(`/api/c/${companyId}/roles`).subscribe({
      next: (body) => {
        if (this.companyId() === companyId) {
          this.roles.set(body.roles);
        }
      },
      error: () => undefined,
    });
    this.http.get<{ locations: Named[] }>(`/api/c/${companyId}/locations`).subscribe({
      next: (body) => {
        if (this.companyId() === companyId) {
          this.locations.set(body.locations);
        }
      },
      error: () => undefined,
    });
    this.http.get<{ stores: Named[] }>(`/api/c/${companyId}/order-filters`).subscribe({
      next: (body) => {
        if (this.companyId() === companyId) {
          this.stores.set(body.stores);
        }
      },
      error: () => undefined,
    });
  }

  private showLink(link: string, generation: number): void {
    if (generation !== this.generation) {
      return;
    }
    this.roleEdit.set(null);
    this.revokeTarget.set(null);
    this.copyState.set('idle');
    this.inviteLink.set(link);
  }

  private patchEdit(index: number, patch: Partial<AssignmentDraft>): void {
    this.roleEdit.update((edit) => {
      if (!edit) {
        return edit;
      }
      return {
        ...edit,
        assignments: edit.assignments.map((item, itemIndex) =>
          itemIndex === index ? { ...item, ...patch } : item,
        ),
      };
    });
  }

  private attempt(permission: string): boolean {
    return canAttempt(
      this.context.grants(),
      this.context.withheldPermissions(),
      this.context.mfaStepUpRequired(),
      permission,
    );
  }

  private finish(mutation: number): boolean {
    if (mutation !== this.mutationGeneration) {
      return false;
    }
    this.busy.set(false);
    return true;
  }

  private fail(mutation: number, error: unknown): void {
    if (!this.finish(mutation)) {
      return;
    }
    if (error instanceof HttpErrorResponse && error.status === 403) {
      this.actionError.set(readApiError(error).message);
    }
  }

  private begin(): boolean {
    if (this.busy()) {
      return false;
    }
    this.busy.set(true);
    this.actionError.set(null);
    return true;
  }
}

function scopeType(value: string): ScopeType {
  if (value === 'location' || value === 'store') {
    return value;
  }
  return 'company';
}

function emptyParams(): { get: (name: string) => string | null } {
  return { get: () => null };
}
