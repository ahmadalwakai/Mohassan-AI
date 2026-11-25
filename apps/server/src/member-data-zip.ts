import type { FileHandle } from 'node:fs/promises';
import { crc32 } from 'node:zlib';

// ZIP storage layout, little-endian fields and UTF-8 flag are from sections 4.3.7,
// 4.3.12, 4.3.16 and 4.4.4 of the PKWARE APPNOTE (retrieved 2026-11-25).
// https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
// Incremental CRC API: https://nodejs.org/docs/latest-v24.x/api/zlib.html#zlibcrc32data-value (2026-11-25).
const utf8 = 1 << 11;
const dosDate = (1 << 5) | 1; // 1980-01-01, the first DOS date.

export class MemberExportTooLarge extends Error {
  readonly statusCode = 413;
  readonly code = 'MEMBER_EXPORT_TOO_LARGE';

  constructor() {
    super('يتجاوز حجم بيانات الحساب الحد المتاح للتنزيل.');
  }
}

/** Writes stored ZIP entries incrementally into an already opened, private file. */
export function createMemberDataZip(file: FileHandle, maxBytes: number, signal?: AbortSignal) {
  const directory: Buffer[] = [];
  let offset = 0;

  async function write(bytes: Buffer, position: number): Promise<void> {
    let written = 0;
    while (written < bytes.length) {
      signal?.throwIfAborted();
      const { bytesWritten } = await file.write(bytes, written, bytes.length - written, position + written);
      if (!bytesWritten) throw new Error('Export archive write did not advance');
      written += bytesWritten;
    }
  }

  async function append(bytes: Buffer): Promise<void> {
    if (offset + bytes.length > maxBytes) throw new MemberExportTooLarge();
    await write(bytes, offset);
    offset += bytes.length;
  }

  async function entry(path: string, chunks: AsyncIterable<Buffer> | Iterable<Buffer>): Promise<void> {
    const name = Buffer.from(path);
    if (directory.length >= 0xffff - 1 || name.length > 0xffff) throw new MemberExportTooLarge();
    const entryOffset = offset;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(utf8, 6);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    await append(local);

    let checksum = 0;
    let size = 0;
    for await (const chunk of chunks) {
      await append(chunk);
      checksum = crc32(chunk, checksum);
      size += chunk.length;
    }

    // Fill in the sizes after writing the data so readers can also scan the local headers.
    const descriptor = Buffer.alloc(12);
    descriptor.writeUInt32LE(checksum, 0);
    descriptor.writeUInt32LE(size, 4);
    descriptor.writeUInt32LE(size, 8);
    await write(descriptor, entryOffset + 14);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(utf8, 8);
    central.writeUInt16LE(dosDate, 14);
    descriptor.copy(central, 16);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entryOffset, 42);
    name.copy(central, 46);
    directory.push(central);
  }

  async function finish(): Promise<number> {
    const directoryOffset = offset;
    for (const central of directory) await append(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(directory.length, 8);
    end.writeUInt16LE(directory.length, 10);
    end.writeUInt32LE(offset - directoryOffset, 12);
    end.writeUInt32LE(directoryOffset, 16);
    await append(end);
    return offset;
  }

  return { entry, finish };
}
