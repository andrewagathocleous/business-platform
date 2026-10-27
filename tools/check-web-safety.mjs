import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const injectionNeedles = ['innerHTML', 'bypassSecurityTrust'];

export function injectionHits(text, file) {
  const hits = [];
  for (const needle of injectionNeedles) {
    if (text.includes(needle)) {
      hits.push(`${file} contains ${needle}`);
    }
  }
  return hits;
}

/** A `<select [value]>` binding is applied before `@for` options exist, so the browser keeps the first option. */
export function selectValueHits(text, file) {
  const hits = [];
  const tags = text.matchAll(/<select\b[^>]*>/g);
  for (const tag of tags) {
    if (tag[0].includes('[value]')) {
      hits.push(`${file} binds [value] on <select>`);
    }
  }
  return hits;
}

export async function scanWebSafety(root) {
  const hits = [];
  await walk(root, root, hits);
  return hits;
}

async function walk(directory, root, hits) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(full, root, hits);
      continue;
    }
    if (!/\.(?:ts|html|css)$/.test(entry.name)) {
      continue;
    }
    const text = await readFile(full, 'utf8');
    const display = relative(root, full);
    hits.push(...injectionHits(text, display));
    if (display.startsWith('app/') && /\.(?:ts|html)$/.test(entry.name)) {
      hits.push(...selectValueHits(text, display));
    }
  }
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
if (isDirect) {
  const root = resolve(import.meta.dirname, '..', 'apps', 'web', 'src');
  const hits = await scanWebSafety(root);
  if (hits.length > 0) {
    console.error(hits.join('\n'));
    process.exit(1);
  }
  console.log('web safety check passed');
}
