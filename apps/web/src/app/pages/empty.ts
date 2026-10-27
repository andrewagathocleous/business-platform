import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

@Component({
  selector: 'bp-empty',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    <section class="page">
      <h1>{{ 'empty.title' | transloco }}</h1>
      <p>{{ 'empty.body' | transloco }}</p>
    </section>
  `,
})
export class EmptyPage {}
