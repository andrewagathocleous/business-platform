import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { Tag } from 'primeng/tag';
import { translateCode } from './labels';

export type TagSeverity = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

export function paymentSeverity(status: string): TagSeverity {
  if (status === 'paid') {
    return 'success';
  }
  if (status === 'pending' || status === 'authorized' || status === 'partially_paid') {
    return 'warn';
  }
  if (status === 'voided') {
    return 'danger';
  }
  if (status === 'refunded' || status === 'partially_refunded') {
    return 'secondary';
  }
  return 'secondary';
}

export function fulfilmentSeverity(status: string): TagSeverity {
  if (status === 'review_required') {
    return 'warn';
  }
  if (status === 'cancelled') {
    return 'danger';
  }
  if (status === 'completed') {
    return 'success';
  }
  return 'info';
}

export function integrationSeverity(status: string): TagSeverity {
  if (status === 'error') {
    return 'danger';
  }
  if (status === 'stale') {
    return 'warn';
  }
  if (status === 'synced') {
    return 'success';
  }
  return 'secondary';
}

@Component({
  selector: 'bp-status-tags',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Tag],
  template: `
    <p-tag
      data-testid="payment-status"
      [value]="payment()"
      [severity]="paymentSeverity()"
    />
    <p-tag
      data-testid="fulfilment-status"
      [value]="fulfilment()"
      [severity]="fulfilmentSeverity()"
    />
    <p-tag
      data-testid="integration-status"
      [value]="integration()"
      [severity]="integrationSeverity()"
    />
  `,
})
export class StatusTagsComponent {
  private readonly transloco = inject(TranslocoService);
  readonly paymentStatus = input.required<string>();
  readonly fulfilmentStatus = input.required<string>();
  readonly integrationStatus = input.required<string>();
  readonly paymentSeverity = computed(() => paymentSeverity(this.paymentStatus()));
  readonly fulfilmentSeverity = computed(() => fulfilmentSeverity(this.fulfilmentStatus()));
  readonly integrationSeverity = computed(() => integrationSeverity(this.integrationStatus()));

  payment(): string {
    return translateCode(this.transloco, 'orders.payment', this.paymentStatus());
  }

  fulfilment(): string {
    return translateCode(this.transloco, 'orders.fulfilment', this.fulfilmentStatus());
  }

  integration(): string {
    return translateCode(this.transloco, 'orders.integration', this.integrationStatus());
  }
}
