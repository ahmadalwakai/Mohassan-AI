import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

const codePattern = /^[A-Za-z0-9_-]{16}$/;
const keyPattern = /^[A-Za-z0-9_-]{43}$/;
const deviceIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

interface Credentials {
  deviceId: string;
  deviceKey: string;
  pollIntervalMs: number;
}

export interface CodingDeviceState {
  allowedRoots: string[];
  pairing?: Omit<Credentials, 'deviceKey'> & { serverUrl: string; encryptedKey: string };
}

export type CodingDeviceStatus = 'unpaired' | 'offline' | 'online';

function pairingError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function deviceOrigin(value: string): URL {
  const url = URL.parse(value);
  if (
    !url || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
  ) throw pairingError('INVALID_SERVER_URL', 'اضبط عنوان خادم API على HTTPS في إعدادات موحسن.');
  return url;
}

function validInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 60_000;
}

export function readCodingDeviceState(path: string): CodingDeviceState {
  let allowedRoots: string[] = [];
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    allowedRoots = Array.isArray(stored.allowedRoots) && stored.allowedRoots.every((root: unknown) => typeof root === 'string')
      ? stored.allowedRoots as string[] : [];
    const pairing = stored.pairing;
    if (
      !pairing || typeof pairing.deviceId !== 'string' || !deviceIdPattern.test(pairing.deviceId) ||
      typeof pairing.serverUrl !== 'string' || typeof pairing.encryptedKey !== 'string' ||
      !/^[A-Za-z0-9+/]{1,8192}={0,2}$/.test(pairing.encryptedKey) || !validInterval(pairing.pollIntervalMs)
    ) return { allowedRoots };
    const serverUrl = deviceOrigin(pairing.serverUrl).origin;
    return { allowedRoots, pairing: { deviceId: pairing.deviceId, serverUrl, encryptedKey: pairing.encryptedKey, pollIntervalMs: pairing.pollIntervalMs } };
  } catch {
    return { allowedRoots };
  }
}

export function writeCodingDeviceState(path: string, state: CodingDeviceState) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function pairCodingDevice(serverUrl: string, code: unknown, name: string): Promise<Credentials> {
  if (typeof code !== 'string' || !codePattern.test(code.trim())) {
    throw pairingError('INVALID_PAIRING_CODE', 'ألصق رمز الربط من قسم «مشاريع البرمجة» في موحسن.');
  }
  const url = new URL('/api/coding/device/pair', deviceOrigin(serverUrl));
  const body = JSON.stringify({ code: code.trim(), name: name.trim().slice(0, 80) || 'Windows' });
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const response = await new Promise<string>((resolve, reject) => {
    const request = transport(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      agent: false,
      rejectUnauthorized: true,
      signal: AbortSignal.timeout(10_000),
    }, reply => {
      reply.on('error', reject);
      if (reply.statusCode !== 200) {
        reply.resume();
        const error = reply.statusCode === 401
          ? pairingError('PAIRING_CODE_EXPIRED', 'رمز الربط غير صالح أو انتهى. أنشئ رمزًا جديدًا.')
          : reply.statusCode === 429
            ? pairingError('PAIRING_RATE_LIMIT', 'محاولات الربط كثيرة. انتظر قليلًا ثم حاول مجددًا.')
            : pairingError('PAIRING_UNAVAILABLE', 'تعذر الربط. تحقق من عنوان خادم API ومن تفعيل ربط محرك البرمجة.');
        reject(error);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      reply.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4096) {
          reject(pairingError('INVALID_PAIRING_RESPONSE', 'رد الربط غير صالح.'));
          reply.destroy();
        } else chunks.push(chunk);
      });
      reply.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    request.on('error', () => reject(pairingError('PAIRING_UNAVAILABLE', 'تعذر الاتصال بخادم API. تحقق من عنوانه في إعدادات موحسن.')));
    request.end(body);
  });
  let data: unknown;
  try { data = JSON.parse(response); } catch { /* The shape check rejects malformed JSON. */ }
  if (
    !data || typeof data !== 'object' || Object.keys(data).length !== 3 ||
    !('deviceId' in data) || typeof data.deviceId !== 'string' || !deviceIdPattern.test(data.deviceId) ||
    !('deviceKey' in data) || typeof data.deviceKey !== 'string' || !keyPattern.test(data.deviceKey) ||
    !('pollIntervalMs' in data) || !validInterval(data.pollIntervalMs)
  ) throw pairingError('INVALID_PAIRING_RESPONSE', 'رد الربط غير صالح.');
  return { deviceId: data.deviceId, deviceKey: data.deviceKey, pollIntervalMs: data.pollIntervalMs };
}

function startWorker(repoRoot: string) {
  return spawn('node', ['--import', 'tsx', 'scripts/coding-device.ts'], {
    cwd: repoRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
}

type WorkerProcess = ReturnType<typeof startWorker>;
const firstRetryMs = 1000;
const maxRetryMs = 30_000;

export class DesktopCodingWorker {
  private state: CodingDeviceState = { allowedRoots: [] };
  private worker: WorkerProcess | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private stopTimer: NodeJS.Timeout | undefined;
  private retryMs = firstRetryMs;
  private online = false;
  private stopping = false;

  constructor(private readonly options: {
    repoRoot: string;
    decrypt: (encryptedKey: string) => string;
    onStatus: (status: CodingDeviceStatus) => void;
    onRevoked: () => void;
    log: (message: string) => void;
  }, private readonly spawnWorker = startWorker) {}

  setState(state: CodingDeviceState) {
    this.state = state;
    this.retryMs = firstRetryMs;
    clearTimeout(this.retryTimer);
    this.online = false;
    this.options.onStatus(state.pairing ? 'offline' : 'unpaired');
    if (!this.worker) {
      this.start();
      return;
    }
    if (this.stopping) return;
    const worker = this.worker;
    this.stopping = true;
    // Closing the pipe asks the worker to abort its active job. A crashed
    // Electron process closes the same pipe automatically.
    worker.stdin.end();
    this.stopTimer = setTimeout(() => worker.kill(), 5000);
    this.stopTimer.unref();
  }

  private retry() {
    if (!this.state.pairing) return;
    this.retryTimer = setTimeout(() => this.start(), this.retryMs);
    this.retryTimer.unref();
    this.retryMs = Math.min(this.retryMs * 2, maxRetryMs);
  }

  private start() {
    const { pairing, allowedRoots } = this.state;
    if (!pairing) return;
    let worker: WorkerProcess;
    let input: string;
    try {
      const { encryptedKey, ...connection } = pairing;
      const deviceKey = this.options.decrypt(encryptedKey);
      if (!keyPattern.test(deviceKey)) throw new Error('Invalid device key');
      input = `${JSON.stringify({ ...connection, allowedRoots, deviceKey })}\n`;
      worker = this.spawnWorker(this.options.repoRoot);
    } catch {
      this.options.log('could not start the coding device worker');
      this.retry();
      return;
    }
    this.worker = worker;
    worker.stdin.on('error', () => { /* The child close handler owns recovery. */ });
    worker.on('error', () => { /* Spawn failures are followed by close. */ });
    const output = createInterface({ input: worker.stdout, crlfDelay: Infinity });
    output.on('line', line => {
      if (this.worker !== worker || this.stopping) return;
      if (line === '{"revoked":true}') {
        this.setState({ allowedRoots: this.state.allowedRoots });
        this.options.onRevoked();
        return;
      }
      if (line !== '{"online":true}' && line !== '{"online":false}') return;
      const online = line === '{"online":true}';
      if (online) this.retryMs = firstRetryMs;
      if (this.online === online) return;
      this.online = online;
      this.options.onStatus(online ? 'online' : 'offline');
    });
    worker.once('close', () => {
      output.close();
      this.worker = undefined;
      clearTimeout(this.stopTimer);
      const stopping = this.stopping;
      this.stopping = false;
      if (stopping) {
        this.start();
        return;
      }
      this.online = false;
      this.options.onStatus('offline');
      this.options.log('coding device worker stopped');
      this.retry();
    });
    worker.stdin.write(input);
  }
}
