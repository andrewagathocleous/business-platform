/**
 * Docker context matching, following moby patternmatcher.
 * Patterns are relative to the context root. For each path, every pattern is
 * tried in order. A pattern matches the path or any parent directory.
 * The last matching pattern decides. A leading `!` includes the path.
 * A later exception can re-include a file under an excluded directory.
 */

export function parseDockerignore(text) {
  const patterns = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) {
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const exception = trimmed.startsWith('!');
    const body = normalizePattern(exception ? trimmed.slice(1) : trimmed);
    if (body.length === 0) {
      continue;
    }
    patterns.push({ exception, body, matcher: compilePattern(body) });
  }
  return patterns;
}

export function dockerignoreExcludes(text, filePath) {
  const file = cleanPath(filePath);
  if (file.length === 0) {
    return false;
  }
  const parents = parentPaths(file);
  let excluded = false;
  for (const pattern of parseDockerignore(text)) {
    if (pattern.matcher(file) || parents.some((parent) => pattern.matcher(parent))) {
      excluded = !pattern.exception;
    }
  }
  return excluded;
}

function normalizePattern(body) {
  return cleanPath(body.trim().replace(/^\/+/, '').replace(/\/+$/, ''));
}

function cleanPath(input) {
  const parts = [];
  for (const part of input.split('/')) {
    if (part.length === 0 || part === '.') {
      continue;
    }
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function parentPaths(file) {
  const parts = file.split('/');
  const parents = [];
  for (let index = 1; index < parts.length; index += 1) {
    parents.push(parts.slice(0, index).join('/'));
  }
  return parents;
}

/**
 * @param {string} pattern
 * @returns {(path: string) => boolean}
 */
function compilePattern(pattern) {
  let source = '^';
  let index = 0;
  let kind = 'exact';
  while (index < pattern.length) {
    if (pattern.startsWith('**', index)) {
      const at = index;
      index += 2;
      if (pattern[index] === '/') {
        index += 1;
      }
      if (index >= pattern.length) {
        kind = kind === 'exact' ? 'prefix' : 'regexp';
        if (kind === 'regexp') {
          source += '.*';
        }
      } else {
        source += '(?:.*/)?';
        kind = 'regexp';
      }
      if (at === 0) {
        kind = 'suffix';
      }
      continue;
    }
    const char = pattern[index];
    index += 1;
    if (char === '*') {
      source += '[^/]*';
      kind = 'regexp';
    } else if (char === '?') {
      source += '[^/]';
      kind = 'regexp';
    } else if ('.+()|{}$'.includes(char)) {
      source += `\\${char}`;
    } else if (char === '\\' && index < pattern.length) {
      source += `\\${pattern[index]}`;
      index += 1;
      kind = 'regexp';
    } else {
      source += char;
    }
  }
  if (kind === 'suffix') {
    const suffix = pattern.slice(2);
    return (path) => path.endsWith(suffix) || (suffix.startsWith('/') && path === suffix.slice(1));
  }
  if (kind === 'prefix') {
    const prefix = pattern.slice(0, -2);
    return (path) => path.startsWith(prefix);
  }
  if (kind === 'exact') {
    return (path) => path === pattern;
  }
  const expression = new RegExp(`${source}$`);
  return (path) => expression.test(path);
}
