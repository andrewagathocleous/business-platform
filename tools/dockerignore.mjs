/**
 * Docker context matching, following moby patternmatcher.
 * Patterns are relative to the context root. For each path, every pattern is
 * tried in order. A pattern matches the path or any parent directory.
 * The last matching pattern decides. A leading `!` includes the path.
 * A later exception can re-include a file under an excluded directory.
 * Character classes follow Go filepath.Match. `?` and `*` match whole Unicode
 * code points. POSIX bracket classes such as `[[:alpha:]]` are not supported.
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
  const chars = Array.from(pattern);
  let source = '^';
  let index = 0;
  let kind = 'exact';
  while (index < chars.length) {
    if (chars[index] === '*' && chars[index + 1] === '*') {
      const at = index;
      index += 2;
      if (chars[index] === '/') {
        index += 1;
      }
      if (index >= chars.length) {
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
    const char = chars[index];
    if (char === '[') {
      const compiled = compileClass(pattern, chars, index);
      source += compiled.source;
      index = compiled.next;
      kind = 'regexp';
      continue;
    }
    index += 1;
    if (char === '*') {
      source += '[^/]*';
      kind = 'regexp';
    } else if (char === '?') {
      source += '[^/]';
      kind = 'regexp';
    } else if ('.+()|{}$^]'.includes(char)) {
      source += `\\${char}`;
    } else if (char === '\\') {
      if (index >= chars.length) {
        throw invalidPattern(pattern);
      }
      source += escapeLiteral(chars[index]);
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
  const expression = new RegExp(`${source}$`, 'u');
  return (path) => expression.test(path);
}

function invalidPattern(pattern) {
  return new Error(`invalid .dockerignore pattern: ${pattern}`);
}

/**
 * `'[' [ '^' ] { character-range } ']'`, where a range is one code point, an
 * escaped code point, or `lo-hi`. At least one range is required.
 * @param {string} pattern
 * @param {string[]} chars
 * @param {number} start
 * @returns {{ source: string, next: number }}
 */
function compileClass(pattern, chars, start) {
  let index = start + 1;
  let negated = false;
  if (index < chars.length && chars[index] === '^') {
    negated = true;
    index += 1;
  }
  let body = '';
  let ranges = 0;
  while (index < chars.length && chars[index] !== ']') {
    const lo = classChar(pattern, chars, index);
    index = lo.next;
    if (index < chars.length && chars[index] === '-') {
      index += 1;
      const hi = classChar(pattern, chars, index);
      index = hi.next;
      if (lo.char.codePointAt(0) > hi.char.codePointAt(0)) {
        throw invalidPattern(pattern);
      }
      body += `${escapeClassChar(lo.char)}-${escapeClassChar(hi.char)}`;
    } else {
      body += escapeClassChar(lo.char);
    }
    ranges += 1;
  }
  if (ranges === 0 || index >= chars.length || chars[index] !== ']') {
    throw invalidPattern(pattern);
  }
  return { source: `[${negated ? '^' : ''}${body}]`, next: index + 1 };
}

/**
 * @param {string} pattern
 * @param {string[]} chars
 * @param {number} index
 */
function classChar(pattern, chars, index) {
  if (index >= chars.length) {
    throw invalidPattern(pattern);
  }
  if (chars[index] === '\\') {
    if (index + 1 >= chars.length) {
      throw invalidPattern(pattern);
    }
    return { char: chars[index + 1], next: index + 2 };
  }
  if (chars[index] === '-' || chars[index] === ']') {
    throw invalidPattern(pattern);
  }
  return { char: chars[index], next: index + 1 };
}

function escapeClassChar(char) {
  if (char === '\\' || char === ']' || char === '[' || char === '^' || char === '-') {
    return `\\${char}`;
  }
  return char;
}

function escapeLiteral(char) {
  if ('\\^$.*+?()[]{}|'.includes(char)) {
    return `\\${char}`;
  }
  return char;
}
