export type ListedCarrier = {
  id: string;
  id_reference: string;
  name: string;
};

export type CarrierReferenceRow = {
  idReference: string;
  name: string;
};

/** One row per `id_reference`, named from the carrier with the highest numeric id. */
export function groupCarriers(rows: readonly ListedCarrier[]): CarrierReferenceRow[] {
  const best = new Map<string, { id: string; name: string }>();
  for (const row of rows) {
    const current = best.get(row.id_reference);
    if (!current || higherId(row.id, current.id)) {
      best.set(row.id_reference, { id: row.id, name: row.name });
    }
  }
  return [...best.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([idReference, row]) => ({ idReference, name: row.name }));
}

function higherId(left: string, right: string): boolean {
  const leftDigits = /^[0-9]+$/.test(left);
  const rightDigits = /^[0-9]+$/.test(right);
  if (leftDigits && rightDigits) {
    return BigInt(left) > BigInt(right);
  }
  return left > right;
}
