import { describe, expect, it } from 'vitest';
import { resolveCorrelationId, uuidv7 } from './correlation';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('correlation ids', () => {
  it('keeps a valid header and replaces anything else with a uuid v7', () => {
    expect(resolveCorrelationId('abcd-1234')).toBe('abcd-1234');
    expect(resolveCorrelationId('no')).toMatch(UUID_V7);
    expect(resolveCorrelationId('bad id!!')).toMatch(UUID_V7);
    expect(resolveCorrelationId(undefined)).toMatch(UUID_V7);
    expect(uuidv7()).toMatch(UUID_V7);
  });
});