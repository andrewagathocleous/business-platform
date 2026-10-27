import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterOutlet } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { Drawer } from 'primeng/drawer';
import { Select } from 'primeng/select';
import { map } from 'rxjs';
import { CompanyContextStore } from '../core/company-context.store';
import type { Locale } from '../core/models';
import { SessionStore } from '../core/session.store';
import { SideNavComponent } from './side-nav';

@Component({
  selector: 'bp-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, TranslocoPipe, FormsModule, Select, Drawer, SideNavComponent],
  template: `
    <a class="skip" href="#main">{{ 'a11y.skip' | transloco }}</a>
    <div class="shell">
      <header class="topbar">
        <button
          type="button"
          class="menu-button"
          [attr.aria-label]="'nav.open' | transloco"
          (click)="drawerOpen.set(true)"
        >
          <span class="pi pi-bars" aria-hidden="true"></span>
          <span class="menu-label">{{ 'nav.menu' | transloco }}</span>
        </button>
        <div class="company-switch" data-testid="company-switcher">
          <label class="company-label" for="company-switcher">{{ 'company.switcher' | transloco }}</label>
          <p-select
            inputId="company-switcher"
            [options]="companies()"
            optionLabel="tradingName"
            optionValue="id"
            [ngModel]="currentId()"
            (ngModelChange)="switchCompany($event)"
            [ariaLabel]="'company.switcher' | transloco"
            appendTo="body"
          />
          <p class="current-company">
            <span class="current-flag">{{ 'company.current' | transloco }}:</span>
            {{ currentCompany()?.tradingName }}
          </p>
        </div>
        <div class="user-menu" #userMenu (click)="$event.stopPropagation()">
          <button
            #userButton
            type="button"
            class="user-button"
            [attr.aria-expanded]="menuOpen()"
            [attr.aria-controls]="menuOpen() ? 'user-panel' : null"
            [attr.aria-label]="userLabel()"
            (click)="menuOpen.set(!menuOpen())"
          >
            <span class="user-name">{{ session.user()?.displayName }}</span>
            <span class="user-initials" aria-hidden="true">{{ initials() }}</span>
          </button>
          @if (menuOpen()) {
            <div
              id="user-panel"
              class="user-panel"
              role="group"
              [attr.aria-label]="'user.menu' | transloco"
            >
              <p id="language-label">{{ 'user.language' | transloco }}</p>
              <button
                type="button"
                [attr.aria-pressed]="locale() === 'en'"
                aria-describedby="language-label"
                [disabled]="session.localeSaving()"
                (click)="chooseLocale('en')"
              >
                {{ 'user.english' | transloco }}
              </button>
              <button
                type="button"
                [attr.aria-pressed]="locale() === 'el'"
                aria-describedby="language-label"
                [disabled]="session.localeSaving()"
                (click)="chooseLocale('el')"
              >
                {{ 'user.greek' | transloco }}
              </button>
              <button type="button" (click)="logout()">{{ 'user.logout' | transloco }}</button>
            </div>
          }
        </div>
      </header>
      <aside class="sidenav">
        <bp-side-nav [companyId]="currentId()" [grants]="context.grants()" />
      </aside>
      <main id="main" class="main">
        <router-outlet />
      </main>
    </div>
    <p-drawer
      [header]="'nav.label' | transloco"
      [visible]="drawerOpen()"
      (visibleChange)="drawerOpen.set($event)"
      position="left"
      [ariaCloseLabel]="'nav.close' | transloco"
    >
      <bp-side-nav
        [companyId]="currentId()"
        [grants]="context.grants()"
        (navigated)="drawerOpen.set(false)"
      />
    </p-drawer>
  `,
})
export class ShellComponent {
  readonly session = inject(SessionStore);
  readonly context = inject(CompanyContextStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly transloco = inject(TranslocoService);
  private readonly userButton = viewChild<ElementRef<HTMLButtonElement>>('userButton');
  private readonly userMenu = viewChild<ElementRef<HTMLElement>>('userMenu');

  readonly drawerOpen = signal(false);
  readonly menuOpen = signal(false);
  readonly currentId = toSignal(
    this.route.paramMap.pipe(map((params) => (params.get('companyId') ?? '').toLowerCase())),
    { initialValue: (this.route.snapshot.paramMap.get('companyId') ?? '').toLowerCase() },
  );
  readonly companies = computed(() => this.session.companies());
  readonly currentCompany = computed(() => {
    const id = this.currentId().toLowerCase();
    return this.companies().find((company) => company.id.toLowerCase() === id) ?? null;
  });
  readonly locale = computed(() => this.session.user()?.locale ?? 'en');
  readonly initials = computed(() => initialsOf(this.session.user()?.displayName ?? ''));

  userLabel(): string {
    const name = this.session.user()?.displayName ?? '';
    return `${name}, ${this.transloco.translate('user.menu')}`;
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !this.menuOpen()) {
      return;
    }
    event.preventDefault();
    this.menuOpen.set(false);
    this.userButton()?.nativeElement.focus();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.menuOpen()) {
      return;
    }
    const root = this.userMenu()?.nativeElement;
    if (root && event.target instanceof Node && root.contains(event.target)) {
      return;
    }
    this.menuOpen.set(false);
  }

  switchCompany(value: unknown): void {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.toLowerCase() === this.currentId().toLowerCase()
    ) {
      return;
    }
    void this.router.navigate(['/c', value]);
  }

  chooseLocale(locale: Locale): void {
    if (this.session.localeSaving()) {
      return;
    }
    if (locale === this.locale()) {
      this.menuOpen.set(false);
      return;
    }
    void this.session.setLocale(locale).then(
      () => {
        this.menuOpen.set(false);
      },
      () => {
        this.menuOpen.set(false);
      },
    );
  }

  logout(): void {
    this.menuOpen.set(false);
    this.context.reset();
    void this.session.logout().then(
      () => this.router.navigateByUrl('/login'),
      () => this.router.navigateByUrl('/login'),
    );
  }
}

function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter((part) => part.length > 0 && !part.startsWith('('));
  const letters = [words[0], words[1]].flatMap((part) => {
    if (!part) {
      return [];
    }
    const char = Array.from(part)[0];
    return char ? [char] : [];
  });
  return letters.join('').toLocaleUpperCase('en-GB');
}
