import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { visibleNav, type NavItem } from '../core/nav';
import type { Grant } from '../core/models';

@Component({
  selector: 'bp-side-nav',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, TranslocoPipe],
  template: `
    <nav [attr.aria-label]="'nav.label' | transloco">
      <ul class="nav-list">
        @for (item of primary(); track item.path) {
          <li>
            <a
              [routerLink]="link(item)"
              routerLinkActive="is-active"
              ariaCurrentWhenActive="page"
              (click)="navigated.emit()"
            >
              {{ item.labelKey | transloco }}
            </a>
          </li>
        }
      </ul>
      @if (admin().length > 0) {
        <h2>{{ 'nav.admin' | transloco }}</h2>
        <ul class="admin-list">
          @for (item of admin(); track item.path) {
            <li>
              <a
                [routerLink]="link(item)"
                routerLinkActive="is-active"
                ariaCurrentWhenActive="page"
                (click)="navigated.emit()"
              >
                {{ item.labelKey | transloco }}
              </a>
            </li>
          }
        </ul>
      }
    </nav>
  `,
})
export class SideNavComponent {
  readonly companyId = input.required<string>();
  readonly grants = input.required<readonly Pick<Grant, 'permission'>[]>();
  readonly navigated = output();

  primary(): NavItem[] {
    return visibleNav(this.grants()).filter((item) => !item.admin);
  }

  admin(): NavItem[] {
    return visibleNav(this.grants()).filter((item) => item.admin);
  }

  link(item: NavItem): string[] {
    return ['/c', this.companyId(), ...item.path.split('/')];
  }
}
