import { join } from 'node:path';
import { CodingDeviceBootstrapSchema } from '@mohassan/coding-link';
import { runCodingDevice } from '@mohassan/coding-link/worker';

const stdinLimit = 1_048_576;
const shutdown = new AbortController();
process.once('SIGINT', () => shutdown.abort());
process.once('SIGTERM', () => shutdown.abort());
process.stdin.once('end', () => shutdown.abort());
process.stdin.once('error', () => shutdown.abort());

function receiveBootstrap() {
  return new Promise<unknown>((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const aborted = () => { process.stdin.off('data', receive); reject(new Error('Desktop connection closed.')); };
    const receive = (chunk: Buffer) => {
      const boundary = chunk.indexOf(10);
      const line = boundary === -1 ? chunk : chunk.subarray(0, boundary);
      if (buffered.length + line.length > stdinLimit) { shutdown.abort(); return; }
      buffered = Buffer.concat([buffered, line]);
      if (boundary === -1) return;
      process.stdin.off('data', receive);
      shutdown.signal.removeEventListener('abort', aborted);
      try { resolve(JSON.parse(buffered.toString('utf8')) as unknown); }
      catch { reject(new Error('Desktop connection supplied invalid credentials.')); }
      finally { buffered.fill(0); }
    };
    shutdown.signal.addEventListener('abort', aborted, { once: true });
    process.stdin.on('data', receive);
  });
}

try {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) throw new Error('Coding device requires Windows.');
  const bootstrap = CodingDeviceBootstrapSchema.parse(await receiveBootstrap());
  await runCodingDevice({ ...bootstrap, dataDir: join(process.env.LOCALAPPDATA, 'Mohassan', 'coding'), signal: shutdown.signal,
    onStatus: status => process.stdout.write(`${JSON.stringify(status === 'revoked' ? { revoked: true } : { online: status === 'online' })}\n`),
  });
} catch {
  if (!shutdown.signal.aborted) {
    process.stderr.write('تعذر بدء محرك البرمجة على هذا الجهاز.\n');
    process.exitCode = 1;
  }
} finally {
  process.stdin.destroy();
}
