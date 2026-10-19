import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');

for (const relative of ['packages/db/dist/index.js', 'packages/domain/dist/index.js']) {
  require(resolve(root, relative));
  console.log(`loaded ${relative}`);
}
