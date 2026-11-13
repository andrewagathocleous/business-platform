import { Readable } from 'node:stream';
import { crc32, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { compressZipEntry, writeZip, ZipLimitError, type ZipEntry } from './zip';

describe('ZIP writer', () => {
  it('round-trips binary, Unicode names and empty files via the central directory', () => {
    const entries = [
      { name: 'Ελληνικά.csv', bytes: Buffer.from('\uFEFFπεριγραφή\r\n') },
      { name: 'pdfs/INV-1.pdf', bytes: Buffer.from([0, 255, 1, 128, 10, 13]) },
      { name: 'empty', bytes: Buffer.alloc(0) },
    ];
    const archive = archiveBytes(entries);
    expect(readZip(archive)).toEqual(new Map(entries.map((entry) => [entry.name, entry.bytes])));
    expect(archiveBytes(entries)).toEqual(archive);
  });

  it('streams prepared chunks that a reader reassembles into a valid archive', async () => {
    const original = Buffer.from('Verified PDF bytes, Ελληνικά');
    const entry = compressZipEntry({ name: 'pdfs/INV-1.pdf', bytes: original });
    original.fill(0); // Prepared entries retain no reference to the uncompressed buffer.
    const chunks = writeZip([entry]);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks).toContain(entry.compressed);
    const received: Buffer[] = [];
    for await (const chunk of Readable.from(chunks, { objectMode: false }))
      received.push(chunk as Buffer);
    expect(readZip(Buffer.concat(received))).toEqual(
      new Map([['pdfs/INV-1.pdf', Buffer.from('Verified PDF bytes, Ελληνικά')]]),
    );
  });

  it('writes an empty archive', () => {
    expect(readZip(archiveBytes([])).size).toBe(0);
  });

  it('refuses more than 65,535 prepared entries before emitting any chunks', () => {
    const entry = compressZipEntry({ name: 'x', bytes: Buffer.alloc(0) });
    expect(() => writeZip(Array.from({ length: 65_536 }, () => entry))).toThrow(ZipLimitError);
  });

  it('refuses a 4 GiB entry before compressing or allocating', () => {
    // A length-only stand-in exercises the guard without allocating 4 GiB in a unit test.
    const bytes = { length: 0x1_0000_0000 } as Buffer;
    expect(() => compressZipEntry({ name: 'large', bytes })).toThrow(ZipLimitError);
  });

  it('refuses entry names too long for classic ZIP', () => {
    expect(() => archiveBytes([{ name: 'α'.repeat(32_768), bytes: Buffer.alloc(0) }])).toThrow(
      ZipLimitError,
    );
  });

  it.each(['/absolute', '../escape', 'pdfs/../escape', 'pdfs\\escape', 'nul\0name'])(
    'refuses unsafe name %j',
    (name) => {
      expect(() => archiveBytes([{ name, bytes: Buffer.alloc(0) }])).toThrow('relative name');
    },
  );
});

function archiveBytes(entries: readonly ZipEntry[]): Buffer {
  return Buffer.concat(writeZip(entries.map(compressZipEntry)));
}

/** Independent minimal reader: follow the central directory, then check each local header. */
function readZip(zip: Buffer): Map<string, Buffer> {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  expect(zip.readUInt16LE(end + 8)).toBe(count);
  let cursor = zip.readUInt32LE(end + 16);
  expect(cursor + zip.readUInt32LE(end + 12)).toBe(end);
  const result = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    expect(zip.readUInt16LE(cursor + 8)).toBe(0x0800);
    expect(zip.readUInt16LE(cursor + 10)).toBe(8);
    const checksum = zip.readUInt32LE(cursor + 16);
    const size = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const local = zip.readUInt32LE(cursor + 42);
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    expect(zip.readUInt16LE(local + 6)).toBe(0x0800);
    expect(zip.readUInt16LE(local + 8)).toBe(8);
    expect(zip.readUInt32LE(local + 14)).toBe(checksum);
    expect(zip.readUInt32LE(local + 18)).toBe(size);
    expect(zip.subarray(local + 30, local + 30 + nameLength).toString('utf8')).toBe(name);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const bytes = inflateRawSync(zip.subarray(start, start + size));
    expect(bytes.length).toBe(zip.readUInt32LE(cursor + 24));
    expect(bytes.length).toBe(zip.readUInt32LE(local + 22));
    expect(crc32(bytes)).toBe(checksum);
    result.set(name, bytes);
    cursor += 46 + nameLength + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
  }
  expect(cursor).toBe(end);
  return result;
}
