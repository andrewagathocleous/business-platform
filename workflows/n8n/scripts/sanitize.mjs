/**
 * Safety net against secrets committed by accident in exported workflow JSON.
 * The sanitiser blocks literal secrets in workflow parameters, including inside
 * n8n and JavaScript expressions, and fails closed on expressions it can't parse.
 * Deliberately obfuscated secrets (for example, computing a key or value through
 * function calls) are out of scope. Credentials must live in n8n's credential
 * store; reviewers check exported workflow diffs.
 */
import { parse, parseExpressionAt } from 'acorn';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT_METADATA = new Set([
  'pinData',
  'staticData',
  'versionId',
  'meta',
  'shared',
  'activeVersion',
  'activeVersionId',
  'triggerCount',
  'createdAt',
  'updatedAt',
]);

const SECRET_KEY =
  /(password|secret|api[_-]?key|access[_-]?token|encryption[_-]?key|client_secret)/i;
const SECRET_VALUE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|postgres(?:ql)?:\/\/[^:\s/"]+:[^@\s/"]+@|sk_live_[0-9A-Za-z]+|bps_[0-9a-f-]{8,}/i;
const BEARER_OR_BASIC = /\b(?:bearer|basic)\s+[A-Za-z0-9\-._~+/]{8,}/i;
const HIGH_ENTROPY_TOKEN = /[A-Za-z0-9+/=_~.-]{24,}/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_SECRET_PROPERTY =
  /"(?:authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|x-shopify-access-token|cookie|password|secret|client_secret|token)"\s*:\s*"(?!=\{\{)(?!\{\{)[^"]*"/i;

const SENSITIVE_PARAMETER_NAMES = new Set([
  'authorization',
  'proxyauthorization',
  'authentication',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'secret',
  'clientsecret',
  'apikey',
  'xapikey',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'xshopifyaccesstoken',
  'xauthtoken',
  'xaccesstoken',
  'xcsrftoken',
  'privatekey',
]);

export function sanitizeWorkflow(value) {
  return walk(value, []);
}

function walk(value, path) {
  if (Array.isArray(value)) {
    return value.map((item, index) => walk(item, path.concat(String(index))));
  }
  if (value && typeof value === 'object') {
    assertSensitiveParameter(value, path);
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      if (path.length === 0 && ROOT_METADATA.has(key)) {
        continue;
      }
      if (key === 'pinData' || key === 'staticData') {
        continue;
      }
      if (key === 'credentials' && child && typeof child === 'object') {
        output[key] = stripCredentialIds(child, path.concat(key));
        continue;
      }
      if (
        SECRET_KEY.test(key) &&
        typeof child === 'string' &&
        child.length > 0 &&
        !isExactSecretReference(child)
      ) {
        throw new Error(`Possible secret at ${path.concat(key).join('.')}`);
      }
      output[key] = walk(child, path.concat(key));
    }
    return output;
  }
  if (typeof value === 'string') {
    assertLiteralSecret(value, path);
  }
  return value;
}

function assertSensitiveParameter(value, path) {
  if (!path.includes('parameters')) {
    return;
  }
  if (typeof value.name !== 'string' || !Object.prototype.hasOwnProperty.call(value, 'value')) {
    return;
  }
  if (!isSensitiveParameterName(value.name)) {
    return;
  }
  if (typeof value.value === 'string' && isExactSecretReference(value.value)) {
    return;
  }
  throw new Error(`Possible secret at ${path.concat('value').join('.')}`);
}

function isSensitiveParameterName(name) {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SENSITIVE_PARAMETER_NAMES.has(normalized)) {
    return true;
  }
  return (
    normalized.length > 0 &&
    normalized.length <= 80 &&
    /(authorization|apikey|accesstoken|clientsecret|password|secret|token)$/.test(normalized)
  );
}

const EXACT_SECRET_REFERENCE =
  /^=\{\{\s*\$(env|credentials)(\.[A-Za-z_][A-Za-z0-9_]*|\[['"][^'"]+['"]\])+\s*\}\}$/;
const SECRET_REFERENCE = /\$(?:env|credentials)(?:\.[A-Za-z_][A-Za-z0-9_]*|\[['"][^'"]+['"]\])+/g;
const URL_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^/\s?#@]*@/i;
const SECRET_REFERENCE_VALUE =
  /^\$(?:env|credentials)(?:\.[A-Za-z_][A-Za-z0-9_]*|\[['"][^'"]+['"]\])+$/;
const ACORN_OPTIONS = { ecmaVersion: 'latest', sourceType: 'script' };

function isExactSecretReference(value) {
  return EXACT_SECRET_REFERENCE.test(value.trim());
}

function tryParseJsonContainer(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isN8nNodeType(value, path) {
  // Only the node metadata field nodes.<index>.type. Every other type is checked.
  if (path.length !== 3 || path[0] !== 'nodes' || path[2] !== 'type') {
    return false;
  }
  const index = path[1];
  if (typeof index !== 'string' || !/^(0|[1-9][0-9]*)$/.test(index)) {
    return false;
  }
  return /^n8n-nodes-base\.[A-Za-z0-9]+$/.test(value);
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function assertLiteralSecret(value, path) {
  const at = path.join('.') || '<root>';
  // nodes.<index>.type, such as n8n-nodes-base.scheduleTrigger, is one mixed
  // token of more than 24 characters. It is not a credential.
  if (isN8nNodeType(value, path)) {
    return;
  }
  const masked = maskExpressionSpans(value);
  if (URL_USERINFO.test(masked) || SECRET_VALUE.test(value)) {
    throw new Error(`Possible secret at ${at}`);
  }
  if (containsN8nExpression(value)) {
    assertN8nExpressions(value, at);
  }
  if (isExactSecretReference(value)) {
    return;
  }
  const mixed = mixesLiteralAndExpression(value);
  const surface = mixed
    ? stripExpressionPrefix(literalWithPlaceholders(value))
    : containsN8nExpression(value)
      ? masked
      : value;
  SECRET_REFERENCE.lastIndex = 0;
  // "/" is part of the entropy token, so a normal https URL is split first.
  const literal = surface.replace(SECRET_REFERENCE, '').replace(/[:/]/g, ' ');
  if (BEARER_OR_BASIC.test(literal) || hasHighEntropyLiteral(literal)) {
    throw new Error(`Possible secret at ${at}`);
  }
  if (mixed || !containsN8nExpression(value)) {
    assertSensitiveAssignments(surface, at);
  }
  if (!path.includes('parameters') || (containsN8nExpression(value) && !mixed)) {
    return;
  }
  assertParameterLiteral(surface, at);
}

function assertParameterLiteral(value, at) {
  if (isHttpUrl(value)) {
    assertUrlSecrets(value, at);
    return;
  }
  const json = tryParseJsonContainer(value);
  if (json !== undefined) {
    assertJsonSecrets(json, at, false);
  }
  if (JSON_SECRET_PROPERTY.test(value)) {
    throw new Error(`Possible secret at ${at}`);
  }
}

/** True when literal text remains after every `{{ … }}` span is removed. */
function mixesLiteralAndExpression(value) {
  if (!value.includes('{{')) {
    return false;
  }
  let literal = '';
  let index = 0;
  while (index < value.length) {
    const open = value.indexOf('{{', index);
    if (open === -1) {
      literal += value.slice(index);
      break;
    }
    literal += value.slice(index, open);
    const close = findSpanEnd(value, open + 2);
    if (close === -1) {
      return literal.replace(/^=/, '').trim().length > 0 || value.slice(open + 2).trim().length > 0;
    }
    index = close + 2;
  }
  return literal.replace(/^=/, '').trim().length > 0;
}

function stripExpressionPrefix(value) {
  const trimmed = value.trim();
  return trimmed.startsWith('=') ? trimmed.slice(1).trim() : trimmed;
}

/**
 * Replaces each `{{ … }}` span so the surrounding literal can be checked.
 * Inside a JSON string the placeholder stays a string; elsewhere it is `x`.
 */
function literalWithPlaceholders(value) {
  let output = '';
  let index = 0;
  let inString = false;
  while (index < value.length) {
    if (value[index] === '"' && !isEscaped(value, index)) {
      inString = !inString;
      output += value[index];
      index += 1;
      continue;
    }
    if (value.startsWith('{{', index)) {
      const close = findSpanEnd(value, index + 2);
      output += inString ? '__n8n_expr__' : 'x';
      if (close === -1) {
        break;
      }
      index = close + 2;
      continue;
    }
    output += value[index];
    index += 1;
  }
  return output;
}

function isEscaped(value, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function containsN8nExpression(value) {
  return value.includes('{{') || value.trimStart().startsWith('=');
}

function assertN8nExpressions(value, at) {
  for (const span of expressionSpans(value)) {
    assertJavaScript(span, at);
  }
  const whole = wholeExpressionCode(value);
  if (whole !== null) {
    assertJavaScript(whole, at);
  }
}

/**
 * n8n treats a whole `=` value with no `{{ }}` spans as code.
 * A value that mixes literal text and spans is a template: only the spans are code.
 */
function wholeExpressionCode(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('=')) {
    return null;
  }
  const body = trimmed.slice(1).trim();
  if (body.length === 0 || body.includes('{{')) {
    return null;
  }
  return body;
}

function expressionSpans(value) {
  const spans = [];
  let index = 0;
  while (index < value.length) {
    const open = value.indexOf('{{', index);
    if (open === -1) {
      break;
    }
    const close = findSpanEnd(value, open + 2);
    if (close === -1) {
      throw new Error('unparseable expression; cannot verify it is secret-free');
    }
    spans.push(value.slice(open + 2, close));
    index = close + 2;
  }
  return spans;
}

function maskExpressionSpans(value) {
  let output = '';
  let index = 0;
  while (index < value.length) {
    const open = value.indexOf('{{', index);
    if (open === -1) {
      output += value.slice(index);
      break;
    }
    output += value.slice(index, open);
    const close = findSpanEnd(value, open + 2);
    if (close === -1) {
      output += value.slice(open);
      break;
    }
    output += 'x';
    index = close + 2;
  }
  return output;
}

/**
 * The object's `}` can sit against the delimiter's first `}`, so the first
 * `}}` is not always the span end. Try candidates from the last backwards
 * and keep the first body that parses.
 */
function findSpanEnd(value, start) {
  const candidates = [];
  let index = start;
  while (index < value.length) {
    const char = value[index];
    if (char === '"' || char === "'" || char === '`') {
      index = skipString(value, index);
      continue;
    }
    if (char === '/' && value[index + 1] === '/') {
      const newline = value.indexOf('\n', index);
      index = newline === -1 ? value.length : newline + 1;
      continue;
    }
    if (value.startsWith('}}', index)) {
      candidates.push(index);
      index += 1;
      continue;
    }
    index += 1;
  }
  for (let cursor = candidates.length - 1; cursor >= 0; cursor -= 1) {
    const end = candidates[cursor];
    if (parseJavaScript(value.slice(start, end)).ok) {
      return end;
    }
  }
  return -1;
}

function skipString(value, start) {
  const quote = value[start];
  let index = start + 1;
  while (index < value.length) {
    if (value[index] === '\\') {
      index += 2;
      continue;
    }
    if (value[index] === quote) {
      return index + 1;
    }
    index += 1;
  }
  return value.length;
}

function assertJavaScript(code, at) {
  const parsed = parseJavaScript(code);
  if (!parsed.ok) {
    throw new Error('unparseable expression; cannot verify it is secret-free');
  }
  if (parsed.ast) {
    walkAst(parsed.ast, (node) => {
      inspectNode(node, at);
    });
  }
}

function parseJavaScript(code) {
  const trimmed = code.trim();
  if (trimmed.length === 0) {
    return { ok: true, ast: null };
  }
  try {
    const expression = parseExpressionAt(trimmed, 0, ACORN_OPTIONS);
    if (trimmed.slice(expression.end).trim().length === 0) {
      return { ok: true, ast: expression };
    }
  } catch {
    // The span may be a statement rather than one expression.
  }
  try {
    return { ok: true, ast: parse(trimmed, ACORN_OPTIONS) };
  } catch {
    return { ok: false, ast: null };
  }
}

function walkAst(node, visit) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') {
    return;
  }
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') {
      continue;
    }
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        walkAst(item, visit);
      }
    } else {
      walkAst(child, visit);
    }
  }
}

function inspectNode(node, at) {
  if (node.type === 'Property') {
    assertKeyedValue(namedKey(node.key, node.computed === true), node.value, at);
  }
  if (node.type === 'AssignmentExpression' || node.type === 'AssignmentPattern') {
    assertKeyedValue(assignmentKey(node.left), node.right, at);
  }
  if (node.type === 'VariableDeclarator') {
    assertDeclarator(node, at);
  }
  if (node.type === 'Literal' && typeof node.value === 'string') {
    assertDecodedString(node.value, at);
  }
  if (node.type === 'TemplateLiteral') {
    assertTemplate(node, at);
  }
}

function assertDeclarator(node, at) {
  const names = bindingNames(node.id);
  if (!names.some((name) => isSensitiveKey(name))) {
    return;
  }
  if (!isCredentialReference(node.init)) {
    throw new Error(`Possible secret at ${at}`);
  }
}

/** Identifier names and destructured keys. A sensitive one must be a credential reference. */
function bindingNames(pattern) {
  if (!pattern || typeof pattern !== 'object') {
    return [];
  }
  if (pattern.type === 'Identifier' && typeof pattern.name === 'string') {
    return [pattern.name];
  }
  if (pattern.type === 'AssignmentPattern' || pattern.type === 'RestElement') {
    return bindingNames(pattern.left ?? pattern.argument);
  }
  if (pattern.type === 'ObjectPattern') {
    const names = [];
    for (const property of pattern.properties ?? []) {
      if (property.type === 'RestElement') {
        names.push(...bindingNames(property.argument));
        continue;
      }
      const key = namedKey(property.key, property.computed === true);
      if (typeof key === 'string') {
        names.push(key);
      }
      names.push(...bindingNames(property.value));
    }
    return names;
  }
  if (pattern.type === 'ArrayPattern') {
    const names = [];
    for (const element of pattern.elements ?? []) {
      names.push(...bindingNames(element));
    }
    return names;
  }
  return [];
}

function assertKeyedValue(key, valueNode, at) {
  if (key === null) {
    if (containsStringLiteral(valueNode)) {
      throw new Error(`Possible secret at ${at}`);
    }
    return;
  }
  if (!isSensitiveKey(key)) {
    return;
  }
  if (!isCredentialReference(valueNode)) {
    throw new Error(`Possible secret at ${at}`);
  }
}

function staticKey(node) {
  if (!node || typeof node !== 'object') {
    return null;
  }
  if (node.type === 'Identifier' && typeof node.name === 'string') {
    return node.name;
  }
  if (
    node.type === 'Literal' &&
    (typeof node.value === 'string' || typeof node.value === 'number')
  ) {
    return String(node.value);
  }
  if (
    node.type === 'TemplateLiteral' &&
    Array.isArray(node.expressions) &&
    node.expressions.length === 0
  ) {
    return (node.quasis ?? []).map((quasi) => quasi.value?.cooked ?? '').join('');
  }
  return null;
}

function namedKey(node, computed) {
  if (computed) {
    return literalKey(node);
  }
  return staticKey(node);
}

/** A computed key is static only when it is a string, a number, or a template with no interpolation. */
function literalKey(node) {
  if (!node || typeof node !== 'object') {
    return null;
  }
  if (
    node.type === 'Literal' &&
    (typeof node.value === 'string' || typeof node.value === 'number')
  ) {
    return String(node.value);
  }
  if (
    node.type === 'TemplateLiteral' &&
    Array.isArray(node.expressions) &&
    node.expressions.length === 0
  ) {
    return (node.quasis ?? []).map((quasi) => quasi.value?.cooked ?? '').join('');
  }
  return null;
}

function assignmentKey(left) {
  if (!left || typeof left !== 'object') {
    return null;
  }
  if (left.type === 'Identifier') {
    return typeof left.name === 'string' ? left.name : null;
  }
  if (left.type === 'MemberExpression') {
    return namedKey(left.property, left.computed === true);
  }
  return null;
}

function assertDecodedString(text, at) {
  scanLiteral(text, at);
  assertParameterLiteral(text, at);
}

function assertTemplate(node, at) {
  for (const quasi of node.quasis ?? []) {
    const cooked = quasi.value?.cooked ?? quasi.value?.raw;
    if (typeof cooked === 'string') {
      scanLiteral(cooked, at);
    }
  }
  const rebuilt = rebuildTemplate(node);
  if (URL_USERINFO.test(rebuilt)) {
    throw new Error(`Possible secret at ${at}`);
  }
  if (isHttpUrl(rebuilt)) {
    assertUrlSecrets(rebuilt, at);
  }
}

function rebuildTemplate(node) {
  const quasis = node.quasis ?? [];
  const expressions = node.expressions ?? [];
  let output = '';
  for (let index = 0; index < quasis.length; index += 1) {
    const quasi = quasis[index];
    output += quasi?.value?.cooked ?? quasi?.value?.raw ?? '';
    if (index < expressions.length) {
      output += 'x';
    }
  }
  return output;
}

function isCredentialReference(node) {
  let current = node;
  if (current?.type === 'ChainExpression') {
    current = current.expression;
  }
  while (current?.type === 'MemberExpression') {
    current = current.object;
    if (current?.type === 'ChainExpression') {
      current = current.expression;
    }
  }
  return (
    current?.type === 'Identifier' && (current.name === '$env' || current.name === '$credentials')
  );
}

function containsStringLiteral(node) {
  let found = false;
  walkAst(node, (current) => {
    if (current.type === 'Literal' && typeof current.value === 'string') {
      found = true;
    }
    if (current.type === 'TemplateLiteral') {
      found = true;
    }
  });
  return found;
}

function isSensitiveKey(name) {
  return isSensitiveParameterName(name) || SECRET_KEY.test(name);
}

function scanLiteral(text, at) {
  if (text.length === 0) {
    return;
  }
  if (
    SECRET_VALUE.test(text) ||
    URL_USERINFO.test(maskExpressionSpans(text)) ||
    BEARER_OR_BASIC.test(text)
  ) {
    throw new Error(`Possible secret at ${at}`);
  }
  // The entropy token includes "/", so split URL separators before measuring.
  if (hasHighEntropyLiteral(text.replace(/[:/]/g, ' '))) {
    throw new Error(`Possible secret at ${at}`);
  }
}

function assertSensitiveAssignments(value, at) {
  const pattern =
    /(?:(['"`])([^'"`\r\n]{1,80})\1|(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_-]{0,79}))\s*[:=]\s*(\$(?:env|credentials)(?:\.[A-Za-z_][A-Za-z0-9_]*|\[['"][^'"]+['"]\])+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z0-9_./+:~-]{1,200})/g;
  for (const match of value.matchAll(pattern)) {
    const key = match[2] ?? match[3] ?? '';
    const rawValue = match[4] ?? '';
    if (!isSensitiveParameterName(key) && !SECRET_KEY.test(key)) {
      continue;
    }
    if (SECRET_REFERENCE_VALUE.test(rawValue)) {
      continue;
    }
    throw new Error(`Possible secret at ${at}`);
  }
}

function assertJsonSecrets(value, at, sensitive) {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertJsonSecrets(item, at, sensitive);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const childSensitive = sensitive || isSensitiveParameterName(key) || SECRET_KEY.test(key);
      assertJsonSecrets(child, at, childSensitive);
    }
    return;
  }
  if (
    !sensitive ||
    typeof value !== 'string' ||
    value.length === 0 ||
    isExactSecretReference(value)
  ) {
    return;
  }
  throw new Error(`Possible secret at ${at}`);
}

function assertUrlSecrets(value, at) {
  const url = new URL(value);
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error(`Possible secret at ${at}`);
  }
  for (const [name, queryValue] of url.searchParams) {
    if (
      isSensitiveParameterName(name) &&
      queryValue.length > 0 &&
      !isExactSecretReference(queryValue)
    ) {
      throw new Error(`Possible secret at ${at}`);
    }
    if (BEARER_OR_BASIC.test(queryValue) || hasHighEntropyLiteral(queryValue)) {
      throw new Error(`Possible secret at ${at}`);
    }
  }
  for (const segment of url.pathname.split('/')) {
    if (segment.length <= 32 || UUID.test(segment)) {
      continue;
    }
    if (BEARER_OR_BASIC.test(segment) || hasHighEntropyLiteral(segment)) {
      throw new Error(`Possible secret at ${at}`);
    }
  }
}

function hasHighEntropyLiteral(value) {
  const matches = value.match(HIGH_ENTROPY_TOKEN) ?? [];
  return matches.some((token) => {
    if (UUID.test(token)) {
      return false;
    }
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((pattern) => pattern.test(token)).length;
    return classes >= 2 && shannonEntropy(token) >= 3.8;
  });
}

function shannonEntropy(value) {
  const counts = new Map();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function stripCredentialIds(credentials, path) {
  const output = {};
  for (const [typeName, credential] of Object.entries(credentials)) {
    if (!credential || typeof credential !== 'object' || Array.isArray(credential)) {
      throw new Error(`Unexpected credential shape at ${path.concat(typeName).join('.')}`);
    }
    const next = { ...credential };
    delete next.id;
    if (typeof next.name !== 'string' || next.name.length === 0) {
      throw new Error(`Credential name missing at ${path.concat(typeName).join('.')}`);
    }
    output[typeName] = walk(next, path.concat(typeName));
  }
  return output;
}

async function filesIn(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesIn(path)));
    } else if (extname(entry.name) === '.json') {
      files.push(path);
    }
  }
  return files;
}

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: node workflows/n8n/scripts/sanitize.mjs <export-dir>');
    process.exit(1);
  }
  const files = await filesIn(dir);
  if (files.length === 0) {
    console.error(`No workflow JSON files in ${dir}`);
    process.exit(1);
  }
  for (const file of files) {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    const sanitised = sanitizeWorkflow(parsed);
    await writeFile(file, `${JSON.stringify(sanitised, null, 2)}\n`);
  }
  console.log(`Sanitised ${files.length} workflow file(s)`);
}

if (process.argv[1] && process.argv[1].endsWith('sanitize.mjs')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
