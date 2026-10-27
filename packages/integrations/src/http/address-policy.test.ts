import { describe, expect, it } from 'vitest';
import { isBlockedAddress } from './address-policy';

const ipv4Ranges: readonly (readonly [string, string])[] = [
  ['0.0.0.0', '0.255.255.255'],
  ['10.0.0.0', '10.255.255.255'],
  ['100.64.0.0', '100.127.255.255'],
  ['127.0.0.0', '127.255.255.255'],
  ['169.254.0.0', '169.254.255.255'],
  ['172.16.0.0', '172.31.255.255'],
  ['192.0.0.0', '192.0.0.255'],
  ['192.0.2.0', '192.0.2.255'],
  ['192.88.99.0', '192.88.99.255'],
  ['192.168.0.0', '192.168.255.255'],
  ['198.18.0.0', '198.19.255.255'],
  ['198.51.100.0', '198.51.100.255'],
  ['203.0.113.0', '203.0.113.255'],
  ['224.0.0.0', '239.255.255.255'],
  ['240.0.0.0', '255.255.255.255'],
];

const ipv6Ranges: readonly (readonly [string, string])[] = [
  ['::', '::'],
  ['::1', '::1'],
  ['100::', '100::ffff:ffff:ffff:ffff'],
  ['2001::', '2001:0:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['2001:db8::', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['fc00::', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['fe80::', 'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['ff00::', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
];

const allowedNeighbors = [
  '1.0.0.0',
  '100.63.255.255',
  '100.128.0.0',
  '172.15.255.255',
  '172.32.0.0',
  '192.0.1.0',
  '192.0.3.0',
  '198.17.255.255',
  '198.20.0.0',
  '169.253.255.255',
  '169.255.0.0',
  '223.255.255.255',
  '2001:1::',
  '2001:db7:ffff:ffff:ffff:ffff:ffff:ffff',
  '2001:db9::',
  '100:0:0:1::',
  'fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  'fe00::',
  'fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  'fec0::',
];

describe('isBlockedAddress', () => {
  it('blocks every listed range at its first and last address', () => {
    for (const [first, last] of [...ipv4Ranges, ...ipv6Ranges]) {
      expect(isBlockedAddress(first), first).toBe(true);
      expect(isBlockedAddress(last), last).toBe(true);
    }
  });

  it('allows one public address of each family', () => {
    expect(isBlockedAddress('93.184.216.34')).toBe(false);
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
    for (const address of allowedNeighbors) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it('blocks mapped, NAT64 and 6to4 forms of private and loopback addresses', () => {
    const blocked = [
      '::ffff:10.0.0.1',
      '::ffff:a00:1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '64:ff9b::10.0.0.1',
      '64:ff9b::a00:1',
      '64:ff9b::127.0.0.1',
      '64:ff9b::7f00:1',
      '2002:a00:1::',
      '2002:a00:1::1',
      '2002:7f00:1::',
    ];
    for (const address of blocked) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
    const allowed = ['::ffff:93.184.216.34', '64:ff9b::93.184.216.34', '2002:5db8:d822::'];
    for (const address of allowed) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it('allows loopback only when the test flag is set', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('127.0.0.0')).toBe(true);
    expect(isBlockedAddress('127.255.255.255')).toBe(true);
    expect(isBlockedAddress('::1')).toBe(true);
    expect(isBlockedAddress('0:0:0:0:0:0:0:1')).toBe(true);

    expect(isBlockedAddress('127.0.0.1', true)).toBe(false);
    expect(isBlockedAddress('127.0.0.0', true)).toBe(false);
    expect(isBlockedAddress('127.255.255.255', true)).toBe(false);
    expect(isBlockedAddress('::1', true)).toBe(false);
    expect(isBlockedAddress('0:0:0:0:0:0:0:1', true)).toBe(false);

    expect(isBlockedAddress('10.0.0.1', true)).toBe(true);
    expect(isBlockedAddress('::', true)).toBe(true);
    expect(isBlockedAddress('::ffff:127.0.0.1', true)).toBe(true);
    expect(isBlockedAddress('64:ff9b::127.0.0.1', true)).toBe(true);
    expect(isBlockedAddress('2002:7f00:1::', true)).toBe(true);
    expect(isBlockedAddress('93.184.216.34', true)).toBe(false);
    expect(isBlockedAddress('2606:4700:4700::1111', true)).toBe(false);
  });
});
