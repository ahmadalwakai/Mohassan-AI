import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    expect(paths).toEqual(Array(6).fill('/api/coding/device/pair'));
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
  readonly kill = vi.fn();
  input = '';
  constructor() {
    super();
    this.stdin.on('data', chunk => { this.input += String(chunk); });
  }
  finish() {
    this.stdout.end();
    this.emit('close');
  }
}

function workerFixture() {
  const children: FakeWorker[] = [];
  const spawnWorker = vi.fn((repoRoot: string) => {
    expect(repoRoot).toBe('C:\\Released Checkout');
    const child = new FakeWorker();
    children.push(child);
    return child as unknown as ReturnType<NonNullable<ConstructorParameters<typeof DesktopCodingWorker>[1]>>;
  });
  const onStatus = vi.fn(), onRevoked = vi.fn(), log = vi.fn();
  const decrypt = vi.fn(() => deviceKey);
  const worker = new DesktopCodingWorker({ repoRoot: 'C:\\Released Checkout', decrypt, onStatus, onRevoked, log }, spawnWorker);
  return { worker, children, spawnWorker, onStatus, onRevoked, log, decrypt };
}

describe('desktop coding worker lifecycle', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('sends the key only via stdin, reports connection state, and waits before replacing the allowed folders', () => {
    const { worker, children, spawnWorker, onStatus, decrypt } = workerFixture();
    worker.setState({ pairing, allowedRoots });
    expect(onStatus).toHaveBeenLastCalledWith('offline');
    expect(spawnWorker).toHaveBeenCalledWith('C:\\Released Checkout');
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
    const { worker, children, onStatus, onRevoked, log } = workerFixture();
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

  it('forces a hung worker to stop after closing its stdin', () => {
    vi.useFakeTimers();
    const { worker, children } = workerFixture();
    worker.setState({ pairing, allowedRoots });
    worker.setState({ allowedRoots });
    expect(children[0]!.stdin.writableEnded).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(children[0]!.kill).toHaveBeenCalledOnce();
    children[0]!.finish();
  });
});
