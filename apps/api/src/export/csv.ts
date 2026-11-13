export type CsvCell = { type: 'text' | 'decimal'; value: string };

export function textCell(value: string | null | undefined): CsvCell {
  return { type: 'text', value: value ?? '' };
}

/** The caller supplies an exact database/domain decimal, never a JS number. */
export function decimalCell(
  value: object & { toFixed(digits: number): string },
  digits: number,
): CsvCell {
  return { type: 'decimal', value: value.toFixed(digits) };
}

/** UTF-8 BOM, RFC 4180 escaping and spreadsheet-safe text. Customer text is not normalised. */
export function writeCsv(rows: Iterable<readonly CsvCell[]>): Buffer {
  const lines: string[] = ['\uFEFF'];
  for (const row of rows) lines.push(row.map(encodeCell).join(','), '\r\n');
  return Buffer.from(lines.join(''), 'utf8');
}

function encodeCell(cell: CsvCell): string {
  let value = cell.value;
  if (cell.type === 'decimal') {
    if (!/^-?\d+(?:\.\d+)?$/.test(value))
      throw new Error('CSV decimal must be a plain decimal string');
  } else if (/^[=+\-@\t\r]/.test(value)) {
    value = `'${value}`;
  }
  return /[,"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
