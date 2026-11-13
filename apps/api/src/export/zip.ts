import { crc32, deflateRawSync } from 'node:zlib';

export type ZipEntry = { name: string; bytes: Buffer };
export type CompressedZipEntry = {
  name: string;
  compressed: Buffer;
  size: number;
  crc: number;
};
const MAX_UINT32 = 0xffff_ffff;
const UTF8_FLAG = 0x0800;

export class ZipLimitError extends Error {
  override readonly name = 'ZipLimitError';
}

/** Compress immediately so callers need not retain the original file bytes. */
export function compressZipEntry(entry: ZipEntry): CompressedZipEntry {
  checkSize(entry.bytes.length);
  const compressed = deflateRawSync(entry.bytes);
  checkSize(compressed.length);
  return { name: entry.name, compressed, size: entry.bytes.length, crc: crc32(entry.bytes) };
}

/** Validate and prepare every chunk before streaming; never concatenate the archive. */
export function writeZip(entries: readonly CompressedZipEntry[]): Buffer[] {
  if (entries.length > 65_535) throw new ZipLimitError('ZIP has more than 65,535 entries');
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  const names = new Set<string>();
  let offset = 0;
  let centralSize = 0;
  let uncompressedSize = 0;
  for (const entry of entries) {
    if (
      !entry.name ||
      entry.name.includes('\\') ||
      entry.name.includes('\0') ||
      entry.name.startsWith('/') ||
      entry.name.split('/').some((part) => part === '..' || part === '.') ||
      names.has(entry.name)
    ) {
      throw new Error('ZIP entry must have a unique relative name');
    }
    names.add(entry.name);
    const name = Buffer.from(entry.name, 'utf8');
    if (name.length > 65_535) throw new ZipLimitError('ZIP entry name is too long');
    uncompressedSize += entry.size;
    checkSize(uncompressedSize);
    const { compressed, crc } = entry;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(UTF8_FLAG, 6);
    header.writeUInt16LE(8, 8); // DEFLATE
    header.writeUInt16LE(0x0021, 12); // deterministic DOS date: 1980-01-01
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(entry.size, 22);
    header.writeUInt16LE(name.length, 26);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(UTF8_FLAG, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt16LE(0x0021, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(entry.size, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    offset += header.length + name.length + compressed.length;
    centralSize += directory.length + name.length;
    checkSize(offset + centralSize + 22);
    local.push(header, name, compressed);
    central.push(directory, name);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return [...local, ...central, end];
}

function checkSize(value: number): void {
  // 0xffffffff is reserved for ZIP64, which this writer deliberately does not produce.
  if (value >= MAX_UINT32) throw new ZipLimitError('ZIP reaches the 4 GiB limit');
}
