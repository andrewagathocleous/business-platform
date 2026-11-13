/**
 * The Zebra 100 × 150 mm preset (R1-F). New companies get this template, and the
 * R1-I migration gives it to every existing company that has none.
 * The SQL in `20261113160000_r1i_default_gift_template` repeats these values.
 */
export const DEFAULT_GIFT_TEMPLATE = {
  name: 'Zebra 100 × 150 mm',
  pageWidthMm: '100.00',
  pageHeightMm: '150.00',
  marginTopMm: '5.00',
  marginRightMm: '5.00',
  marginBottomMm: '5.00',
  marginLeftMm: '5.00',
  fontSizePt: '16.00',
  minFontSizePt: '9.00',
  lineHeight: '1.250',
  align: 'center',
  verticalAlign: 'middle',
  isDefault: true,
} as const;
