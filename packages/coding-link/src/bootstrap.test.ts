import { randomBytes, randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runCodingDeviceFromDesktop } from './bootstrap.js';
import type { runCodingDevice } from './worker.js';

function desktop() {
  const input = new PassThrough();
  const lines: string[] = [];
  const output = new Writable({ write(chunk: Buffer, _encoding, done) { lines.push(chunk.toString('utf8')); done(); } });
  const credentials = {
    serverUrl: 'https://example.invalid', deviceId: randomUUID(), deviceKey: randomBytes(32).toString('base64url'),
    allowedRoots: ['C:\\Projects\\مشاريع'], pollIntervalMs: 1_000,
  };
  return { input, output, lines, credentials, platform: 'win32' as const, localAppData: 'C:\\Users\\Owner\\AppData\\Local' };
}

describe('Windows coding device entry', () => {
  it('reads the first stdin line, reports exact statuses, and aborts the worker when the pipe closes', async () => {
    const fixture = desktop();
    let reportStarted!: () => void;
    const started = new Promise<void>(resolve => { reportStarted = resolve; });
    const run = vi.fn<typeof runCodingDevice>(async ({ signal, onStatus }) => {
      onStatus?.('online');
      onStatus?.('offline');
      onStatus?.('revoked');
      reportStarted();
      await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
    });
    const done = runCodingDeviceFromDesktop(fixture, run);
    const line = Buffer.from(`${JSON.stringify(fixture.credentials)}\n`);
    const split = line.indexOf(Buffer.from('م')) + 1;
    fixture.input.write(line.subarray(0, split));
    expect(run).not.toHaveBeenCalled();
    fixture.input.write(line.subarray(split));
    await started;
    expect(run).toHaveBeenCalledTimes(1);
    const options = run.mock.calls[0]![0];
    expect(options).toMatchObject({ ...fixture.credentials, dataDir: 'C:\\Users\\Owner\\AppData\\Local\\Mohassan\\coding' });
    expect(fixture.lines).toEqual(['{"online":true}\n', '{"online":false}\n', '{"revoked":true}\n']);
    expect(options.signal?.aborted).toBe(false);
    fixture.input.end();
    await done;
    expect(options.signal?.aborted).toBe(true);
  });

  it('aborts and waits for worker cleanup when a status write hits a broken stdout pipe', async () => {
    const fixture = desktop();
    const output = new Writable({ write(_chunk, _encoding, done) {
      setImmediate(() => done(Object.assign(new Error('The desktop status pipe closed.'), { code: 'EPIPE' })));
    } });
    let acknowledgeAbort!: () => void;
    const aborted = new Promise<void>(resolve => { acknowledgeAbort = resolve; });
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
    const run = vi.fn<typeof runCodingDevice>(async ({ signal, onStatus }) => {
      signal!.addEventListener('abort', acknowledgeAbort, { once: true });
      onStatus?.('online');
      await aborted;
      await cleanup;
    });
    let stopped = false;
    const done = runCodingDeviceFromDesktop({ ...fixture, output }, run).then(() => { stopped = true; });
    fixture.input.write(`${JSON.stringify(fixture.credentials)}\n`);
    await aborted;
    expect(fixture.input.readableEnded).toBe(false);
    expect(stopped).toBe(false);
    finishCleanup();
    await done;
    expect(stopped).toBe(true);
    fixture.input.destroy();
  });

  it('handles a status pipe error reported after the worker has returned', async () => {
    const fixture = desktop();
    let completeWrite!: (error: Error) => void;
    const output = new Writable({ write(_chunk, _encoding, done) { completeWrite = done; } });
    const run = vi.fn<typeof runCodingDevice>(async ({ onStatus }) => { onStatus?.('revoked'); });
    const done = runCodingDeviceFromDesktop({ ...fixture, output }, run);
    fixture.input.write(`${JSON.stringify(fixture.credentials)}\n`);
    await done;
    completeWrite(Object.assign(new Error('The desktop status pipe closed.'), { code: 'EPIPE' }));
    await new Promise<void>(resolve => output.once('close', resolve));
    expect(output.destroyed).toBe(true);
    fixture.input.destroy();
  });

  it.each(['malformed JSON', 'invalid fields'] as const)('rejects %s with a fixed credential-free error', async scenario => {
    const fixture = desktop();
    const run = vi.fn<typeof runCodingDevice>();
    const done = runCodingDeviceFromDesktop(fixture, run);
    const body = JSON.stringify(fixture.credentials);
    fixture.input.write(`${scenario === 'malformed JSON' ? body.slice(0, -1) : JSON.stringify({ ...fixture.credentials, pollIntervalMs: 0 })}\n`);
    await expect(done).rejects.toThrow(/^Desktop connection supplied invalid credentials\.$/);
    expect(run).not.toHaveBeenCalled();
    expect(fixture.lines).toEqual([]);
    fixture.input.destroy();
  });

  it('rejects a bootstrap line over one MiB even before EOF', async () => {
    const fixture = desktop();
    const run = vi.fn<typeof runCodingDevice>();
    const done = runCodingDeviceFromDesktop(fixture, run);
    fixture.input.write(Buffer.alloc(1_048_576, 'a'));
    fixture.input.write('a');
    await expect(done).rejects.toThrow('Desktop bootstrap exceeded its size limit.');
    expect(run).not.toHaveBeenCalled();
    expect(fixture.lines).toEqual([]);
    fixture.input.destroy();
  });

  it('exits when stdin closes before the full credential line', async () => {
    const fixture = desktop();
    const run = vi.fn<typeof runCodingDevice>();
    const done = runCodingDeviceFromDesktop(fixture, run);
    fixture.input.end(JSON.stringify(fixture.credentials));
    await expect(done).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(fixture.lines).toEqual([]);
  });

  it('rejects a non-Windows platform before reading stdin', async () => {
    const fixture = desktop();
    const run = vi.fn<typeof runCodingDevice>();
    await expect(runCodingDeviceFromDesktop({ ...fixture, platform: 'linux' }, run)).rejects.toThrow('Coding device requires Windows.');
    expect(fixture.input.readableFlowing).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(fixture.lines).toEqual([]);
    fixture.input.destroy();
  });
});
