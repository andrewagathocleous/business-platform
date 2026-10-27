import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';

@Component({
  selector: 'bp-placeholder',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    <section class="page">
      <h1>{{ title() | transloco }}</h1>
      <p>{{ coming() | transloco }}</p>
    </section>
  `,
})
export class PlaceholderPage {
  private readonly route = inject(ActivatedRoute);
  private readonly data = toSignal(this.route.data, { initialValue: this.route.snapshot.data });
  readonly title = computed(() => routeText(this.data(), 'titleKey'));
  readonly coming = computed(() => routeText(this.data(), 'comingKey'));
}

function routeText(data: object, key: 'titleKey' | 'comingKey'): string {
  if (key === 'titleKey' && 'titleKey' in data && typeof data.titleKey === 'string') {
    return data.titleKey;
  }
  if (key === 'comingKey' && 'comingKey' in data && typeof data.comingKey === 'string') {
    return data.comingKey;
  }
  return '';
}
