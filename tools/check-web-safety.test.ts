import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { injectionHits, scanWebSafety, selectValueHits } from './check-web-safety.mjs';

describe('web safety', () => {
  it('rejects innerHTML and a select value binding, and allows selected options', async () => {
    expect(injectionHits('el.innerHTML = name', 'gift.ts')).toEqual(['gift.ts contains innerHTML']);
    expect(selectValueHits('<select [value]="storeId" (change)="set($event)">', 'orders.ts')).toEqual([
      'orders.ts binds [value] on <select>',
    ]);
    expect(
      selectValueHits(
        '<select\n  [disabled]="readOnly()"\n  [value]="line.taxCodeId"\n  (change)="set($event)">',
        'editor.ts',
      ),
    ).toEqual(['editor.ts binds [value] on <select>']);
    expect(
      selectValueHits(
        '<select (change)="set($event)">\n<option [value]="id" [selected]="id === current">Nuts</option>\n</select>',
        'editor.ts',
      ),
    ).toEqual([]);

    const root = await mkdtemp(join(tmpdir(), 'bp-web-safety-'));
    await mkdir(join(root, 'app'), { recursive: true });
    await writeFile(join(root, 'app', 'page.ts'), '<select [value]="id"></select>\n');
    await writeFile(join(root, 'styles.css'), 'button.innerHTML {}\n');
    const hits = await scanWebSafety(root);
    expect(hits).toContain('app/page.ts binds [value] on <select>');
    expect(hits).toContain('styles.css contains innerHTML');
  });
});
