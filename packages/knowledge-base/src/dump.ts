import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { PassThrough, pipeline } from 'node:stream';
import { createGunzip } from 'node:zlib';

const MAX_LINE_CHARACTERS = 128 * 1024 * 1024;

export async function dumpFingerprint(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

export function readLocalDump(path: string, signal?: AbortSignal) {
  const file = createReadStream(path, { signal });
  return /\.gz$/i.test(path)
    // Pipeline propagates decompression errors to the output read by the iterator.
    ? pipeline(file, createGunzip(), new PassThrough(), () => {})
    : file;
}

async function* dumpLines(path: string, signal?: AbortSignal): AsyncGenerator<string> {
  const stream = readLocalDump(path, signal);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let parts: string[] = [];
  let pendingCharacters = 0;
  for await (const bytes of stream) {
    const chunk = decoder.decode(bytes, { stream: true });
    let start = 0;
    for (let end = chunk.indexOf('\n'); end !== -1; end = chunk.indexOf('\n', start)) {
      if (pendingCharacters + end - start > MAX_LINE_CHARACTERS) {
        throw new Error('Wikimedia JSON dump line exceeds 128 Mi UTF-16 code units');
      }
      const part = chunk.slice(start, end);
      if (parts.length) {
        parts.push(part);
        yield parts.join('');
        parts = [];
        pendingCharacters = 0;
      } else {
        yield part;
      }
      start = end + 1;
    }
    if (start < chunk.length) {
      pendingCharacters += chunk.length - start;
      if (pendingCharacters > MAX_LINE_CHARACTERS) {
        throw new Error('Wikimedia JSON dump line exceeds 128 Mi UTF-16 code units');
      }
      parts.push(chunk.slice(start));
    }
  }
  decoder.decode();
  if (parts.length) yield parts.join('');
}

/** Wikimedia's dump JSON has one top-level record per line. Offsets count records, not bytes. */
export async function* dumpRecords(path: string, offset: number, signal?: AbortSignal):
  AsyncGenerator<{ record: string; offset: number }> {
  let count = 0;
  let state: 'open' | 'first' | 'record' | 'close' | 'done' = 'open';
  for await (const line of dumpLines(path, signal)) {
    signal?.throwIfAborted();
    const data = line.trim();
    if (!data) continue;

    if (state === 'open') {
      if (data !== '[' && data !== '[]') throw new Error('Expected the start of a Wikimedia JSON dump array');
      state = data === '[' ? 'first' : 'done';
      continue;
    }
    if (data === ']' && (state === 'first' || state === 'close')) {
      state = 'done';
      continue;
    }
    if (state === 'done' || state === 'close' || !data.startsWith('{')) {
      throw new Error(`Unexpected Wikimedia JSON dump framing after record ${count}`);
    }

    const comma = data.endsWith(',');
    const record = comma ? data.slice(0, -1).trimEnd() : data;
    if (!record.endsWith('}')) throw new Error(`Incomplete Wikimedia JSON dump record ${count + 1}`);
    state = comma ? 'record' : 'close';
    if (++count > offset) yield { record, offset: count };
  }
  if (state !== 'done') throw new Error('Incomplete Wikimedia JSON dump array');
  if (count < offset) throw new Error('Wikimedia JSON dump ends before the build checkpoint');
}
