export type Row = {
  item: string;
  result: 'PASS' | 'FAIL';
  detail: string;
};

export function scrub(text: string): string {
  return text
    .replace(/bps_[A-Za-z0-9._-]+/g, 'bps_[redacted]')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://[redacted]');
}

export function formatTable(rows: readonly Row[]): string {
  const itemWidth = Math.max(4, ...rows.map((row) => row.item.length));
  const lines = [`${'item'.padEnd(itemWidth)}  result  detail`];
  for (const row of rows) {
    lines.push(`${row.item.padEnd(itemWidth)}  ${row.result.padEnd(6)}  ${scrub(row.detail)}`);
  }
  return lines.join('\n');
}

export function hasFailure(rows: readonly Row[]): boolean {
  return rows.some((row) => row.result === 'FAIL');
}
