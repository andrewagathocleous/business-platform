import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function repositoryRoot(start = process.cwd()): string {
  let current = resolve(start);
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    const parent = resolve(current, '..');
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error('repository root was not found');
}
