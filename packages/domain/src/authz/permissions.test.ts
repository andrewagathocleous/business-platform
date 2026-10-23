import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASE_TEMPLATE, ROLE_TEMPLATES } from './role-templates';
import { PERMISSIONS, ROLE_KEYS, type GrantLevel, type RoleKey } from './permissions';

type MatrixRow = {
  key: string;
  meaning: string;
  phase: string;
  automationOnly: boolean;
  grants: Partial<Record<RoleKey, GrantLevel>>;
};

describe('permission matrix', () => {
  const rows = parseMatrix(readFileSync(resolve(__dirname, '../../../../docs/security/permission-matrix.md'), 'utf8'));

  it('matches the markdown tables, including phase and role cells', () => {
    expect(rows.map((row) => row.key)).toEqual(PERMISSIONS.map((permission) => permission.key));
    for (const permission of PERMISSIONS) {
      const row = rows.find((item) => item.key === permission.key);
      expect(row, permission.key).toBeDefined();
      if (!row) {
        continue;
      }
      expect(row.meaning, permission.key).toBe(permission.meaning);
      expect(row.phase, permission.key).toBe(String(permission.phase));
      expect(row.automationOnly, permission.key).toBe(permission.automationOnly);
      expect(row.grants, permission.key).toEqual(permission.grants);
    }
  });

  it('declares the scope types from the matrix', () => {
    expect(PERMISSIONS.find((permission) => permission.key === 'order.view')?.scopableBy).toEqual([
      'store',
      'location',
    ]);
    expect(PERMISSIONS.find((permission) => permission.key === 'mailbox.read')?.scopableBy).toEqual([
      'mailbox',
    ]);
    expect(PERMISSIONS.find((permission) => permission.key === 'store.view')?.scopableBy).toEqual(['store']);
    expect(PERMISSIONS.find((permission) => permission.key === 'company.view')?.scopableBy).toEqual([]);
  });

  it('keeps automation-only permissions out of human role templates', () => {
    const automationKeys = new Set(
      PERMISSIONS.filter((permission) => permission.automationOnly).map((permission) => permission.key),
    );
    expect(automationKeys).toEqual(new Set(['store.events.ingest', 'store.sync.trigger']));
    for (const template of ROLE_TEMPLATES) {
      for (const key of template.permissions) {
        expect(automationKeys.has(key), `${template.key} ${key}`).toBe(false);
      }
      const expected = PERMISSIONS.filter((permission) => permission.grants[template.key] !== undefined).map(
        (permission) => permission.key,
      );
      expect(template.permissions, template.key).toEqual(expected);
    }
    expect(BASE_TEMPLATE.permissions).toEqual(['company.view', 'catalog.view']);
    for (const key of BASE_TEMPLATE.permissions) {
      expect(automationKeys.has(key)).toBe(false);
    }
  });
});

function parseMatrix(markdown: string): MatrixRow[] {
  const rows: MatrixRow[] = [];
  let automation = false;
  let inTable = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## Automation-only')) {
      automation = true;
      inTable = false;
      continue;
    }
    if (line.startsWith('| Permission |')) {
      inTable = true;
      continue;
    }
    if (!inTable || line.startsWith('|---')) {
      if (inTable && !line.startsWith('|')) {
        inTable = false;
      }
      continue;
    }
    if (!line.startsWith('|')) {
      inTable = false;
      continue;
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const key = cells[0];
    const meaning = cells[1];
    const phase = cells[2];
    if (!key || !meaning || !phase) {
      throw new Error(`incomplete permission row: ${line}`);
    }
    if (automation) {
      rows.push({ key, meaning, phase, automationOnly: true, grants: {} });
      continue;
    }
    const grants: Partial<Record<RoleKey, GrantLevel>> = {};
    ROLE_KEYS.forEach((role, index) => {
      const cell = cells[index + 3] ?? '';
      if (cell === '') {
        return;
      }
      if (cell === '✓') {
        grants[role] = 'company';
        return;
      }
      if (cell === 's') {
        grants[role] = 'scoped';
        return;
      }
      throw new Error(`unexpected cell "${cell}" for ${key} ${role}`);
    });
    rows.push({ key, meaning, phase, automationOnly: false, grants });
  }
  return rows;
}
