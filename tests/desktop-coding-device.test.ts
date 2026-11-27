import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DesktopCodingWorker, pairCodingDevice, readCodingDeviceState, writeCodingDeviceState } from '../apps/desktop/src/coding-device.js';

const code = randomBytes(12).toString('base64url');
const credentials = { deviceId: randomUUID(), deviceKey: randomBytes(32).toString('base64url'), pollIntervalMs: 1000 };
const encryptedKey = randomBytes(32).toString('base64');
const allowedRoots = ['C:\\Projects'];
const serverUrl = 'https://coding.example';
const { deviceKey, ...publicPairing } = credentials;
const pairing = { ...publicPairing, encryptedKey, serverUrl };

async function withHttpServer(listener: RequestListener, run: (url: string) => Promise<void>) {
  const server = createServer(listener);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const info = server.address();
    if (!info || typeof info === 'string') throw new Error('Missing HTTP test port');
    await run(`http://127.0.0.1:${info.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe('desktop coding device pairing', () => {
  it('sends the bounded native pairing request without browser headers and reads the returned credentials', async () => {
    const received: Record<string, unknown> = {};
    await withHttpServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      Object.assign(received, {
        path: request.url, method: request.method, headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      response.end(JSON.stringify(credentials));
    }, async url => {
      expect(await pairCodingDevice(url, ` ${code} \n`, 'Test PC')).toEqual(credentials);
    });
    expect(received).toMatchObject({ method: 'POST', path: '/api/coding/device/pair', body: { code, name: 'Test PC' } });
    const headers = Object.keys(received.headers as object);
    expect(headers.some(header => header === 'origin' || header === 'cookie' || header === 'authorization' || header.startsWith('sec-fetch-'))).toBe(false);
  });

  it('refuses non-loopback HTTP, credential-bearing URLs and malformed codes before sending', async () => {
    await expect(pairCodingDevice('http://coding.example', code, 'Test PC')).rejects.toMatchObject({ code: 'INVALID_SERVER_URL' });
    await expect(pairCodingDevice('https://user:pass@coding.example', code, 'Test PC')).rejects.toMatchObject({ code: 'INVALID_SERVER_URL' });
    await expect(pairCodingDevice(serverUrl, 'short', 'Test PC')).rejects.toMatchObject({ code: 'INVALID_PAIRING_CODE' });
  });

  it('rejects redirects, expired codes, rate limits, and invalid or oversized pairing replies', async () => {
    const outcomes: Array<{ status: number; body?: string; code: string }> = [
      { status: 302, code: 'PAIRING_UNAVAILABLE' },
      { status: 401, code: 'PAIRING_CODE_EXPIRED' },
      { status: 429, code: 'PAIRING_RATE_LIMIT' },
      { status: 200, body: JSON.stringify({ ...credentials, extra: true }), code: 'INVALID_PAIRING_RESPONSE' },
      { status: 200, body: JSON.stringify({ ...credentials, deviceKey: '' }), code: 'INVALID_PAIRING_RESPONSE' },
      { status: 200, body: JSON.stringify({ ...credentials, pollIntervalMs: 99 }), code: 'INVALID_PAIRING_RESPONSE' },
      { status: 200, body: JSON.stringify({ ...credentials, pollIntervalMs: 30_001 }), code: 'INVALID_PAIRING_RESPONSE' },
      { status: 200, body: '{"deviceId":', code: 'PAIRING_UNAVAILABLE' },
      { status: 200, body: 'x'.repeat(4097), code: 'INVALID_PAIRING_RESPONSE' },
    ];
    const paths: Array<string | undefined> = [];
    await withHttpServer((request, response) => {
      paths.push(request.url);
      const next = outcomes.shift();
      if (!next) { response.writeHead(500).end(); return; }
      response.writeHead(next.status, { Location: '/redirected' }).end(next.body);
    }, async url => {
      for (const expected of [...outcomes]) {
        await expect(pairCodingDevice(url, code, 'Test PC')).rejects.toMatchObject({ code: expected.code });
      }
      expect(outcomes).toHaveLength(0);
    });
    expect(paths).toEqual(Array(9).fill('/api/coding/device/pair'));
  });

  it('maps a cut pairing reply to a connection error and gives the request thirty seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      await withHttpServer((_request, response) => {
        response.writeHead(200, { 'Content-Length': 100 }).flushHeaders();
        response.socket!.end('{"deviceId":');
      }, async url => {
        await expect(pairCodingDevice(url, code, 'Test PC')).rejects.toMatchObject({ code: 'PAIRING_UNAVAILABLE' });
      });
      expect(timeout).toHaveBeenCalledExactlyOnceWith(30_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it('persists encrypted credentials and folder choices and removes the pairing without deleting those choices', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'coding-device-desktop-'));
    try {
      const path = join(folder, 'coding-device.json');
      expect(readCodingDeviceState(path)).toEqual({ allowedRoots: [] });
      writeCodingDeviceState(path, { pairing, allowedRoots });
      const saved = await readFile(path, 'utf8');
      expect(saved).toContain(encryptedKey);
      expect(saved).not.toContain(deviceKey);
      expect(readCodingDeviceState(path)).toEqual({ pairing, allowedRoots });
      writeCodingDeviceState(path, { allowedRoots });
      expect(readCodingDeviceState(path)).toEqual({ allowedRoots });
      expect(await readdir(folder)).toEqual(['coding-device.json']);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});

class FakeWorker extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn();
  input = '';
  constructor() {
    super();
    this.stdin.on('data', chunk => { this.input += String(chunk); });
  }
  finish(code = 0, signal: NodeJS.Signals | null = null) {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, signal);
  }
}

function workerFixture(repoRoot: string) {
  const children: FakeWorker[] = [];
  const spawnWorker = vi.fn((_repoRoot: string) => {
    const child = new FakeWorker();
    children.push(child);
    return child as unknown as ReturnType<NonNullable<ConstructorParameters<typeof DesktopCodingWorker>[1]>>;
  });
  const onStatus = vi.fn(), onRevoked = vi.fn(), onRapidExit = vi.fn(), log = vi.fn();
  const decrypt = vi.fn(() => deviceKey);
  const worker = new DesktopCodingWorker({ repoRoot, decrypt, onStatus, onRevoked, onRapidExit, log }, spawnWorker);
  return { worker, children, spawnWorker, onStatus, onRevoked, onRapidExit, log, decrypt };
}

describe('desktop coding worker lifecycle', () => {
  let repoRoot: string;
  beforeAll(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'coding-device-checkout-'));
    await mkdir(join(repoRoot, 'scripts'));
    await writeFile(join(repoRoot, 'scripts', 'coding-device.ts'), '');
    await mkdir(join(repoRoot, 'node_modules', '@mohassan', 'coding-link'), { recursive: true });
  });
  afterAll(async () => { await rm(repoRoot, { force: true, recursive: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it('sends the key only via stdin, reports connection state, and waits before replacing the allowed folders', () => {
    const { worker, children, spawnWorker, onStatus, decrypt } = workerFixture(repoRoot);
    worker.setState({ pairing, allowedRoots });
    expect(onStatus).toHaveBeenLastCalledWith('offline');
    expect(spawnWorker).toHaveBeenCalledWith(repoRoot);
    expect(decrypt).toHaveBeenCalledWith(encryptedKey);
    expect(children[0]!.input).toBe(`${JSON.stringify({ ...publicPairing, serverUrl, allowedRoots, deviceKey })}\n`);
    expect(children[0]!.stdin.writableEnded).toBe(false);
    children[0]!.stdout.write('{"online":true}\n');
    expect(onStatus).toHaveBeenLastCalledWith('online');
    children[0]!.stdout.write('{"online":false}\n');
    expect(onStatus).toHaveBeenLastCalledWith('offline');
    worker.setState({ pairing, allowedRoots: ['D:\\Projects'] });
    expect(children[0]!.stdin.writableEnded).toBe(true);
    expect(children).toHaveLength(1);
    children[0]!.stdout.write('{"revoked":true}\n');
    children[0]!.finish();
    expect(children).toHaveLength(2);
    expect(JSON.parse(children[1]!.input).allowedRoots).toEqual(['D:\\Projects']);
    worker.setState({ allowedRoots });
    children[1]!.finish();
    expect(children).toHaveLength(2);
    expect(onStatus).toHaveBeenLastCalledWith('unpaired');
  });

  it('backs off after worker failures, resets after a connected poll, and stops retrying on credential revocation', () => {
    vi.useFakeTimers();
    const { worker, children, onStatus, onRevoked, log } = workerFixture(repoRoot);
    worker.setState({ pairing, allowedRoots });
    children[0]!.emit('error', new Error(deviceKey));
    children[0]!.finish();
    vi.advanceTimersByTime(999);
    expect(children).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(children).toHaveLength(2);
    children[1]!.finish();
    vi.advanceTimersByTime(1999);
    expect(children).toHaveLength(2);
    vi.advanceTimersByTime(1);
    children[2]!.stdout.write('{"online":true}\n');
    vi.advanceTimersByTime(10_000);
    children[2]!.finish();
    vi.advanceTimersByTime(1000);
    expect(children).toHaveLength(4);
    children[3]!.stdout.write('{"revoked":true}\n');
    children[3]!.finish();
    vi.advanceTimersByTime(60_000);
    expect(children).toHaveLength(4);
    expect(onRevoked).toHaveBeenCalledOnce();
    expect(onStatus).toHaveBeenLastCalledWith('unpaired');
    expect(JSON.stringify(log.mock.calls)).not.toContain(deviceKey);
  });

  it('reports permanent checkout and decryption failures without launching a worker or retrying', () => {
    vi.useFakeTimers();
    const missing = workerFixture(join(repoRoot, 'missing'));
    missing.worker.setState({ pairing, allowedRoots });
    expect(missing.onStatus).toHaveBeenLastCalledWith('setup-required');
    expect(missing.log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('codingDeviceRepoRoot'));
    expect(missing.decrypt).not.toHaveBeenCalled();
    const revoked = workerFixture(repoRoot);
    revoked.decrypt.mockImplementation(() => { throw new Error(deviceKey); });
    revoked.worker.setState({ pairing, allowedRoots });
    expect(revoked.onStatus).toHaveBeenLastCalledWith('repair-required');
    expect(revoked.log.mock.calls[0]?.[0]).not.toContain(deviceKey);
    vi.advanceTimersByTime(600_000);
    expect(missing.spawnWorker).not.toHaveBeenCalled();
    expect(revoked.decrypt).toHaveBeenCalledOnce();
    expect(revoked.spawnWorker).not.toHaveBeenCalled();
  });

  it('reports one rapid-exit notification and waits five minutes after three consecutive fast exits', () => {
    vi.useFakeTimers();
    const { worker, children, onRapidExit } = workerFixture(repoRoot);
    worker.setState({ pairing, allowedRoots });
    children[0]!.finish(1);
    vi.advanceTimersByTime(1000);
    children[1]!.finish(1);
    vi.advanceTimersByTime(2000);
    children[2]!.finish(1);
    expect(onRapidExit).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(299_999);
    expect(children).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(children).toHaveLength(4);
    children[3]!.finish(1);
    expect(onRapidExit).toHaveBeenCalledOnce();
    void worker.stop();
  });

  it('logs an exit code and signal with at most 4 KiB of key-redacted stderr', () => {
    const { worker, children, log } = workerFixture(repoRoot);
    worker.setState({ pairing, allowedRoots });
    children[0]!.stderr.write('x'.repeat(4090) + deviceKey.slice(0, 20));
    children[0]!.stderr.write(deviceKey.slice(20) + 'z'.repeat(1000));
    children[0]!.finish(17, 'SIGTERM');
    expect(log).toHaveBeenCalledWith('coding device worker exited (code 17, signal SIGTERM)');
    const stderr = String(log.mock.calls[1]?.[0]).split('stderr: ')[1]!;
    expect(Buffer.byteLength(stderr)).toBe(4096);
    expect(stderr.slice(-6)).toBe('[redac');
    expect(JSON.stringify(log.mock.calls)).not.toContain(deviceKey.slice(0, 6));
    void worker.stop();
  });

  it('shares the shutdown promise, gives a hung worker one minute, and waits for worker exit', async () => {
    vi.useFakeTimers();
    const { worker, children } = workerFixture(repoRoot);
    worker.setState({ pairing, allowedRoots });
    const stop = worker.stop();
    expect(worker.stop()).toBe(stop);
    expect(children[0]!.stdin.writableEnded).toBe(true);
    vi.advanceTimersByTime(59_999);
    expect(children[0]!.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(children[0]!.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    children[0]!.finish();
    await stop;
  });

  it('drains a worker that has exited without killing it while its stdio still holds close open', async () => {
    vi.useFakeTimers();
    const { worker, children, log } = workerFixture(repoRoot);
    worker.setState({ pairing, allowedRoots });
    const stop = worker.stop();
    const child = children[0]!;
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(60_000);
    await stop;
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.stderr.destroyed).toBe(true);
    expect(log).toHaveBeenCalledWith('coding device worker exited (code 0, signal none)');
  });
});
