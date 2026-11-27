import { win32 } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { z } from 'zod';
import { CodingDeviceBootstrapSchema } from './protocol.js';
import { runCodingDevice } from './worker.js';

const stdinLimit = 1_048_576;
const statusLines = {
  online: '{"online":true}\n',
  offline: '{"online":false}\n',
  revoked: '{"revoked":true}\n',
} as const;

function readBootstrap(input: Readable, signal: AbortSignal) {
  return new Promise<z.output<typeof CodingDeviceBootstrapSchema>>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const stopReading = () => {
      input.off('data', receive);
      signal.removeEventListener('abort', aborted);
    };
    const clear = () => { for (const chunk of chunks) chunk.fill(0); };
    const aborted = () => { stopReading(); clear(); reject(signal.reason); };
    const receive = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const boundary = bytes.indexOf(10);
      const line = boundary === -1 ? bytes : bytes.subarray(0, boundary);
      size += line.length;
      if (size > stdinLimit) {
        stopReading();
        clear();
        reject(new Error('Desktop bootstrap exceeded its size limit.'));
        return;
      }
      chunks.push(Buffer.from(line));
      if (boundary === -1) return;

      stopReading();
      const bootstrap = Buffer.concat(chunks, size);
      try {
        const parsed = CodingDeviceBootstrapSchema.safeParse(JSON.parse(bootstrap.toString('utf8')) as unknown);
        if (!parsed.success) throw new Error('Invalid bootstrap fields.');
        resolve(parsed.data);
      } catch {
        reject(new Error('Desktop connection supplied invalid credentials.'));
      } finally {
        bootstrap.fill(0);
        clear();
      }
    };
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    input.on('data', receive);
  });
}

interface DesktopBootstrapOptions {
  platform: NodeJS.Platform;
  localAppData: string | undefined;
  input: Readable;
  output: Writable;
  signal?: AbortSignal;
}

/** The desktop input pipe delivers one credential line and stays open until shutdown. */
export async function runCodingDeviceFromDesktop({ platform, localAppData, input, output, signal }: DesktopBootstrapOptions,
  run = runCodingDevice): Promise<void> {
  if (platform !== 'win32' || !localAppData) throw new Error('Coding device requires Windows.');
  const connection = new AbortController();
  const stopping = signal ? AbortSignal.any([signal, connection.signal]) : connection.signal;
  if (stopping.aborted || input.readableEnded || input.destroyed || output.destroyed || output.writableEnded) return;
  const disconnected = () => connection.abort();
  let statusWrites = 0;
  let finished = false;
  const releaseOutputErrorHandler = () => {
    // A status write can settle after the worker returns, and its error event follows its callback.
    if (finished && statusWrites === 0) setImmediate(() => output.off('error', disconnected)).unref();
  };
  input.once('end', disconnected);
  input.once('close', disconnected);
  input.once('error', disconnected);
  output.once('close', disconnected);
  output.on('error', disconnected);
  try {
    const bootstrap = await readBootstrap(input, stopping);
    if (stopping.aborted) return;
    input.resume();
    await run({ ...bootstrap, dataDir: win32.join(localAppData, 'Mohassan', 'coding'), signal: stopping,
      onStatus: status => {
        if (stopping.aborted) return;
        statusWrites++;
        output.write(statusLines[status], error => {
          if (error) disconnected();
          statusWrites--;
          releaseOutputErrorHandler();
        });
      },
    });
  } catch (error) {
    if (!stopping.aborted) throw error;
  } finally {
    input.off('end', disconnected);
    input.off('close', disconnected);
    input.off('error', disconnected);
    output.off('close', disconnected);
    finished = true;
    releaseOutputErrorHandler();
  }
}
