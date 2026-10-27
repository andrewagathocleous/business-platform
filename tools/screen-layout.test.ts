import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../apps/web/src/styles.css', import.meta.url), 'utf8');

describe('order detail address cards', () => {
  it('top-aligns the party grid and keeps the lines compact', () => {
    const start = css.indexOf('.party-grid {');
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf('}', start));
    expect(block).toContain('align-items: start');
    expect(css).toMatch(/\.party-grid \.card\s*\{[^}]*gap:\s*0\.15rem/);
    expect(css).toMatch(/\.party-grid \.card p\s*\{[^}]*margin:\s*0/);
  });
});
