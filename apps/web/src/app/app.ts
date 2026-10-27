import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Toast } from 'primeng/toast';

@Component({
  selector: 'bp-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, Toast],
  template: `<p-toast /><router-outlet />`,
})
export class App {}
