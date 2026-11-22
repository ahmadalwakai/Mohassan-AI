import { deflateRawSync } from 'node:zlib';
import { shouldDeflate } from './mime.ts';
import type { SiteFile } from './types.ts';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A fixed DOS date (2026-01-01 00:00) keeps the archive bytes identical for identical content. */
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

/**
 * Writes a ZIP archive without a dependency: deflate for text, store for images that are already
 * compressed. Names are UTF-8 (flag bit 11); entries are sorted by path so the output is deterministic.
 */
export function zipFiles(files: SiteFile[]): Buffer {
  const entries = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of entries) {
    const name = Buffer.from(file.path, 'utf8');
    const data = typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : Buffer.from(file.content);
    const deflate = shouldDeflate(file.path) && data.length > 0;
    const stored = deflate ? deflateRawSync(data, { level: 9 }) : data;
    const method = deflate ? 8 : 0;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, stored);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directory, end]);
}

/** Reads the central directory of an archive this module wrote; used by tests and the server's integrity check. */
export function listZip(archive: Buffer): { path: string; size: number; crc: number; method: number }[] {
  const endOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endOffset < 0) throw new Error('ZIP end record not found');
  const count = archive.readUInt16LE(endOffset + 10);
  let position = archive.readUInt32LE(endOffset + 16);
  const entries: { path: string; size: number; crc: number; method: number }[] = [];
  for (let index = 0; index < count; index++) {
    if (archive.readUInt32LE(position) !== 0x02014b50) throw new Error('ZIP central directory corrupt');
    const method = archive.readUInt16LE(position + 10), crc = archive.readUInt32LE(position + 16), size = archive.readUInt32LE(position + 24);
    const nameLength = archive.readUInt16LE(position + 28), extraLength = archive.readUInt16LE(position + 30), commentLength = archive.readUInt16LE(position + 32);
    entries.push({ path: archive.subarray(position + 46, position + 46 + nameLength).toString('utf8'), size, crc, method });
    position += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
