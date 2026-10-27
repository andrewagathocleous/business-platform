import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

@Component({
  selector: 'bp-gift-message',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    @if (message() === null) {
      <p>{{ 'orders.gift.none' | transloco }}</p>
    } @else {
      <div
        class="gift-box"
        data-testid="gift-message"
        [style.white-space]="'pre-wrap'"
        [style.overflow-wrap]="'anywhere'"
      >{{ message() }}</div>
    }
  `,
})
export class GiftMessageComponent {
  readonly message = input.required<string | null>();
}
