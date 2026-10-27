import { describe, expect, it } from 'vitest';
import { groupCarriers } from './carrier-groups';

describe('groupCarriers', () => {
  it('keeps the name of the highest id for each reference', () => {
    expect(
      groupCarriers([
        { id: '9', id_reference: '2', name: 'Old courier' },
        { id: '10', id_reference: '2', name: 'Demo courier' },
        { id: '4', id_reference: '9', name: 'Collection point' },
        { id: '100', id_reference: '9', name: 'Newer collection' },
        { id: '99', id_reference: '9', name: 'Middle' },
      ]),
    ).toEqual([
      { idReference: '2', name: 'Demo courier' },
      { idReference: '9', name: 'Newer collection' },
    ]);
  });
});
