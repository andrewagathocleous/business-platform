import { isIP } from 'node:net';

type Octets = readonly [number, number, number, number];
type Hextets = readonly [number, number, number, number, number, number, number, number];

const IPV4_PREFIXES: readonly { base: bigint; bits: number }[] = [
  prefix4('0.0.0.0', 8),
  prefix4('10.0.0.0', 8),
  prefix4('100.64.0.0', 10),
  prefix4('127.0.0.0', 8),
  prefix4('169.254.0.0', 16),
  prefix4('172.16.0.0', 12),
  prefix4('192.0.0.0', 24),
  prefix4('192.0.2.0', 24),
  prefix4('192.88.99.0', 24),
  prefix4('192.168.0.0', 16),
  prefix4('198.18.0.0', 15),
  prefix4('198.51.100.0', 24),
  prefix4('203.0.113.0', 24),
  prefix4('224.0.0.0', 4),
  prefix4('240.0.0.0', 4),
];

const IPV6_PREFIXES: readonly { base: bigint; bits: number }[] = [
  prefix6('::', 128),
  prefix6('::1', 128),
  prefix6('100::', 64),
  prefix6('2001::', 32),
  prefix6('2001:db8::', 32),
  prefix6('fc00::', 7),
  prefix6('fe80::', 10),
  prefix6('ff00::', 8),
];

const MAPPED_PREFIX = mustV6('::ffff:0:0');
const NAT64_PREFIX = mustV6('64:ff9b::');

function prefix4(address: string, bits: number): { base: bigint; bits: number } {
  const octets = parseIPv4(address);
  if (!octets) {
    throw new Error('invalid IPv4 prefix');
  }
  return { base: ipv4ToBigInt(octets), bits };
}

function prefix6(address: string, bits: number): { base: bigint; bits: number } {
  return { base: mustV6(address), bits };
}

function mustV6(address: string): bigint {
  const hextets = parseIPv6(address);
  if (!hextets) {
    throw new Error('invalid IPv6 prefix');
  }
  return ipv6ToBigInt(hextets);
}

/**
 * True when the address must not be connected to.
 * `allowLoopback` permits only native `127.0.0.0/8` and `::1`.
 * IPv4 embedded in IPv6 is judged as that IPv4, without the loopback exception.
 * An address that cannot be parsed is blocked.
 */
export function isBlockedAddress(address: string, allowLoopback = false): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = parseIPv4(address);
    if (!octets) return true;
    if (allowLoopback && octets[0] === 127) return false;
    return ipv4Blocked(ipv4ToBigInt(octets));
  }
  if (family === 6) {
    const hextets = parseIPv6(address);
    if (!hextets) return true;
    if (allowLoopback && isV6Loopback(hextets)) return false;
    if (ipv6Blocked(ipv6ToBigInt(hextets))) return true;
    const embedded = embeddedIpv4(hextets);
    return embedded !== null && ipv4Blocked(embedded);
  }
  return true;
}

/** Loopback literal (`127.0.0.0/8` or `::1`) or the exact name `localhost`. */
export function isLoopbackHostname(hostname: string): boolean {
  const bare = stripBrackets(hostname);
  if (bare.toLowerCase() === 'localhost') return true;
  if (isIP(bare) === 4) {
    const octets = parseIPv4(bare);
    return octets !== null && octets[0] === 127;
  }
  if (isIP(bare) === 6) {
    const hextets = parseIPv6(bare);
    return hextets !== null && isV6Loopback(hextets);
  }
  return false;
}

export function stripBrackets(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']') && hostname.length > 2) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function ipv4Blocked(value: bigint): boolean {
  return IPV4_PREFIXES.some((prefix) => inPrefix(value, prefix.base, prefix.bits, 32));
}

function ipv6Blocked(value: bigint): boolean {
  return IPV6_PREFIXES.some((prefix) => inPrefix(value, prefix.base, prefix.bits, 128));
}

function inPrefix(value: bigint, base: bigint, bits: number, width: number): boolean {
  const shift = BigInt(width - bits);
  return value >> shift === base >> shift;
}

function ipv4ToBigInt(octets: Octets): bigint {
  return (
    (BigInt(octets[0]) << 24n) +
    (BigInt(octets[1]) << 16n) +
    (BigInt(octets[2]) << 8n) +
    BigInt(octets[3])
  );
}

function ipv6ToBigInt(hextets: Hextets): bigint {
  let value = 0n;
  for (const part of hextets) {
    value = (value << 16n) + BigInt(part);
  }
  return value;
}

function isV6Loopback(hextets: Hextets): boolean {
  return (
    hextets[0] === 0 &&
    hextets[1] === 0 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0 &&
    hextets[6] === 0 &&
    hextets[7] === 1
  );
}

/**
 * IPv4 carried inside a mapped (`::ffff:0:0/96`), NAT64 (`64:ff9b::/96`) or 6to4 (`2002::/16`) address.
 * 6to4 stores the IPv4 in bits 16–47.
 */
function embeddedIpv4(hextets: Hextets): bigint | null {
  if (hextets[0] === 0x2002) {
    const hi = hextets[1];
    const lo = hextets[2];
    const octets: Octets = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
    return ipv4ToBigInt(octets);
  }
  const value = ipv6ToBigInt(hextets);
  const shift = 32n;
  if (value >> shift === MAPPED_PREFIX >> shift || value >> shift === NAT64_PREFIX >> shift) {
    return value & 0xffffffffn;
  }
  return null;
}

function parseIPv4(address: string): Octets | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  const a = octets[0];
  const b = octets[1];
  const c = octets[2];
  const d = octets[3];
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return [a, b, c, d];
}

function parseIPv6(address: string): Hextets | null {
  const zone = address.indexOf('%');
  const value = zone === -1 ? address : address.slice(0, zone);
  const halves = value.split('::');
  if (halves.length > 2) return null;

  const leftSide = halves[0] ?? '';
  const parsedLeft = parseIPv6Side(leftSide);
  if (!parsedLeft) return null;

  if (halves.length === 1) {
    return asHextets(parsedLeft);
  }

  const parsedRight = parseIPv6Side(halves[1] ?? '');
  if (!parsedRight) return null;
  if (parsedLeft.length + parsedRight.length > 7) return null;
  const missing = 8 - parsedLeft.length - parsedRight.length;
  return asHextets([...parsedLeft, ...new Array<number>(missing).fill(0), ...parsedRight]);
}

function parseIPv6Side(side: string): number[] | null {
  if (side.length === 0) return [];
  const parts = side.split(':');
  const hextets: number[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined || part.length === 0) return null;
    if (part.includes('.')) {
      if (index !== parts.length - 1) return null;
      const octets = parseIPv4(part);
      if (!octets) return null;
      hextets.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    hextets.push(Number.parseInt(part, 16));
  }
  return hextets;
}

function asHextets(parts: number[]): Hextets | null {
  if (parts.length !== 8) return null;
  const h0 = parts[0];
  const h1 = parts[1];
  const h2 = parts[2];
  const h3 = parts[3];
  const h4 = parts[4];
  const h5 = parts[5];
  const h6 = parts[6];
  const h7 = parts[7];
  if (
    h0 === undefined ||
    h1 === undefined ||
    h2 === undefined ||
    h3 === undefined ||
    h4 === undefined ||
    h5 === undefined ||
    h6 === undefined ||
    h7 === undefined
  ) {
    return null;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7];
}
