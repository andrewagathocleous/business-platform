import { describe, expect, it } from 'vitest';
import { issueProblems, type IssueCheckInput } from './issue-validation';

const ADDRESS = { line1: '1 Demo Street', city: 'Nicosia', countryCode: 'CY' };

function input(overrides: Partial<IssueCheckInput> = {}): IssueCheckInput {
  return {
    seller: {
      legalName: 'Demo Company Ltd (fictional)',
      vatNumber: 'CY00000000X',
      address: ADDRESS,
    },
    buyer: { vatNumber: null, address: ADDRESS },
    lines: [
      {
        position: 1,
        description: 'Demo item',
        kind: 'standard',
        noteEn: null,
        noteEl: null,
        taxCodeActive: true,
      },
    ],
    total: '11.90',
    supplyDate: '2026-10-27',
    issueDate: '2026-10-28',
    seriesId: '019a0000-0000-7000-8000-000000000001',
    ...overrides,
  };
}

describe('issueProblems', () => {
  it('passes a complete domestic invoice', () => {
    expect(issueProblems(input())).toEqual([]);
  });

  it('names missing seller and buyer particulars', () => {
    expect(
      issueProblems(
        input({
          seller: { legalName: ' ', vatNumber: null, address: { ...ADDRESS, city: '' } },
          buyer: { vatNumber: null, address: null },
        }),
      ),
    ).toEqual(['seller.legalName', 'seller.address', 'seller.vatNumber', 'buyer.address']);
  });

  it('needs the buyer VAT number and both legal notes for reverse charge', () => {
    expect(
      issueProblems(
        input({
          lines: [
            {
              position: 1,
              description: 'Demo item',
              kind: 'reverse_charge',
              noteEn: 'Reverse charge',
              noteEl: null,
              taxCodeActive: true,
            },
            {
              position: 2,
              description: 'Demo item',
              kind: 'exempt',
              noteEn: null,
              noteEl: 'Απαλλάσσεται',
              taxCodeActive: true,
            },
            {
              position: 3,
              description: 'Demo item',
              kind: 'zero',
              noteEn: null,
              noteEl: null,
              taxCodeActive: false,
            },
          ],
        }),
      ),
    ).toEqual([
      'buyer.vatNumber',
      'lines.1.legalNote',
      'lines.2.legalNote',
      'lines.3.taxCodeInactive',
    ]);
  });

  it('checks the VAT number prefixes for a buyer in another member state', () => {
    const greek = { ...ADDRESS, city: 'Athens', countryCode: 'GR' };
    expect(
      issueProblems(
        input({
          seller: {
            legalName: 'Demo Company Ltd (fictional)',
            vatNumber: '00000000X',
            address: ADDRESS,
          },
          buyer: { vatNumber: 'GR000000000', address: greek },
        }),
      ),
    ).toEqual(['seller.vatNumber.prefix', 'buyer.vatNumber.prefix']);
    expect(
      issueProblems(input({ buyer: { vatNumber: 'EL 000.000.000', address: greek } })),
    ).toEqual([]);
    // An EU consumer without a VAT number is not refused, and a non-EU buyer is not checked.
    expect(issueProblems(input({ buyer: { vatNumber: null, address: greek } }))).toEqual([]);
    expect(
      issueProblems(
        input({ buyer: { vatNumber: 'GB000', address: { ...ADDRESS, countryCode: 'GB' } } }),
      ),
    ).toEqual([]);
  });

  it('refuses a line without a description', () => {
    expect(
      issueProblems(
        input({
          lines: [
            {
              position: 1,
              description: '  ',
              kind: 'standard',
              noteEn: null,
              noteEl: null,
              taxCodeActive: true,
            },
          ],
        }),
      ),
    ).toEqual(['lines.1.description']);
  });

  it('refuses no lines, a negative total, a supply after the issue date and no series', () => {
    expect(
      issueProblems(input({ lines: [], total: '-0.01', supplyDate: '2026-10-29', seriesId: null })),
    ).toEqual(['lines', 'total.negative', 'supplyDate.afterIssue', 'series.missing']);
    expect(issueProblems(input({ total: '-0.00' }))).toEqual([]);
    expect(issueProblems(input({ total: '0.00', supplyDate: '2026-10-28' }))).toEqual([]);
  });
});
