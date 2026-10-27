import { decimalInput, isDecimalInput } from './decimal-input';

export type LineKind = 'item' | 'shipping';

export type LineDraft = {
  key: string;
  productId: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountPercent: string;
  taxCodeId: string;
  kind: LineKind;
};

export type LineRequest = {
  position: number;
  kind: LineKind;
  productId: string | null;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountPercent?: string;
  taxCodeId: string;
};

export function emptyLine(key: string): LineDraft {
  return {
    key,
    productId: '',
    description: '',
    quantity: '',
    unit: '',
    unitPrice: '',
    discountPercent: '',
    taxCodeId: '',
    kind: 'item',
  };
}

export function moveLine(lines: readonly LineDraft[], index: number, direction: -1 | 1): LineDraft[] {
  const next = index + direction;
  const current = lines[index];
  const other = lines[next];
  if (!current || !other) {
    return [...lines];
  }
  const copy = lines.map((line) => ({ ...line }));
  copy[index] = { ...other };
  copy[next] = { ...current };
  return copy;
}

/** Null when a line is not ready to price. Positions are 1..n in screen order. */
export function lineRequests(lines: readonly LineDraft[]): LineRequest[] | null {
  if (lines.length === 0) {
    return null;
  }
  const requests: LineRequest[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.description.length === 0 || line.unit.trim().length === 0 || line.taxCodeId.length === 0) {
      return null;
    }
    if (!isDecimalInput(line.quantity) || !isDecimalInput(line.unitPrice)) {
      return null;
    }
    const discount = line.discountPercent.trim();
    if (discount.length > 0 && !isDecimalInput(line.discountPercent)) {
      return null;
    }
    const request: LineRequest = {
      position: index + 1,
      kind: line.kind,
      productId: line.productId.length > 0 ? line.productId : null,
      description: line.description,
      quantity: decimalInput(line.quantity),
      unit: line.unit.trim(),
      unitPrice: decimalInput(line.unitPrice),
      taxCodeId: line.taxCodeId,
    };
    if (discount.length > 0) {
      request.discountPercent = decimalInput(line.discountPercent);
    }
    requests.push(request);
  }
  return requests;
}
