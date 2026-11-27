import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';

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

export type CodingDeviceStatus = 'unpaired' | 'offline' | 'online' | 'setup-required' | 'repair-required';

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
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 30_000;
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
  const unavailable = () => pairingError('PAIRING_UNAVAILABLE', 'تعذر الاتصال بخادم API. تحقق من عنوانه في إعدادات موحسن.');
  const response = await new Promise<string>((resolve, reject) => {
    const request = transport(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      agent: false,
      rejectUnauthorized: true,
      signal: AbortSignal.timeout(30_000),
    }, reply => {
      reply.on('error', () => reject(unavailable()));
      reply.on('close', () => { if (!reply.complete) reject(unavailable()); });
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
    request.on('error', () => reject(unavailable()));
    request.end(body);
  });
  let data: unknown;
  try { data = JSON.parse(response); } catch { throw unavailable(); }
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
    cwd: repoRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

type WorkerProcess = ReturnType<typeof startWorker>;
interface WorkerShutdown {
  done: Promise<void>;
  finish: () => void;
  timer: NodeJS.Timeout;
  kill?: Promise<void>;
}
interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}
const firstRetryMs = 1000;
const maxRetryMs = 30_000;
const rapidExitRetryMs = 300_000;
const shutdownMs = 60_000;
const cleanupMs = 5_000;
const stderrLimit = 4096;

function workerCheckoutReady(repoRoot: string) {
  try {
    return statSync(join(repoRoot, 'scripts', 'coding-device.ts'), { throwIfNoEntry: false })?.isFile()
      && statSync(join(repoRoot, 'node_modules', '@mohassan', 'coding-link'), { throwIfNoEntry: false })?.isDirectory();
  } catch {
    return false;
  }
}

function killWorkerTree(worker: WorkerProcess, isRunning: () => boolean, log: (message: string) => void): Promise<void> {
  const kill = () => { if (isRunning()) worker.kill('SIGKILL'); };
  if (process.platform !== 'win32' || !worker.pid) {
    kill();
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const tree = spawn('taskkill', ['/PID', String(worker.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    let settled = false;
    const finish = (failure?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failure) {
        log(`coding device worker tree termination failed (${failure})`);
        kill();
      }
      resolve();
    };
    const timer = setTimeout(() => {
      tree.kill();
      finish('taskkill timed out');
    }, cleanupMs);
    tree.on('error', () => { /* Close reports a failed tree termination. */ });
    tree.once('close', code => finish(code === 0 ? undefined : `taskkill code ${code ?? 'none'}`));
  });
}

export class DesktopCodingWorker {
  private state: CodingDeviceState = { allowedRoots: [] };
  private worker: WorkerProcess | undefined;
  private workerExit: WorkerExit | undefined;
  private finishWorker: ((exit: WorkerExit) => void) | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private shutdown: WorkerShutdown | undefined;
  private retryMs = firstRetryMs;
  private rapidExits = 0;
  private online = false;

  constructor(private readonly options: {
    repoRoot: string;
    decrypt: (encryptedKey: string) => string;
    onStatus: (status: CodingDeviceStatus) => void;
    onRevoked: () => void;
    onRapidExit: () => void;
    log: (message: string) => void;
  }, private readonly spawnWorker = startWorker) {}

  setState(state: CodingDeviceState) {
    this.state = state;
    this.retryMs = firstRetryMs;
    this.rapidExits = 0;
    clearTimeout(this.retryTimer);
    this.online = false;
    this.options.onStatus(state.pairing ? 'offline' : 'unpaired');
    if (!this.worker) {
      this.start();
      return;
    }
    void this.stopCurrent();
  }

  stop(): Promise<void> {
    this.state = { allowedRoots: this.state.allowedRoots };
    clearTimeout(this.retryTimer);
    return this.stopCurrent();
  }

  private stopCurrent(): Promise<void> {
    if (this.shutdown) return this.shutdown.done;
    const worker = this.worker;
    if (!worker) return Promise.resolve();
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const finishAfterDrain = () => {
      worker.stdout.destroy();
      worker.stderr.destroy();
      if (this.workerExit) this.finishWorker?.(this.workerExit);
      else {
        // Keep tracking the original worker so a settings change cannot
        // start a second worker after an unconfirmed forced shutdown.
        this.options.log('coding device worker shutdown could not be confirmed');
        shutdown.finish();
      }
    };
    const afterGrace = () => {
      if (this.workerExit) { finishAfterDrain(); return; }
      shutdown.kill = killWorkerTree(worker, () => this.worker === worker && !this.workerExit, this.options.log);
      void shutdown.kill.then(() => {
        if (this.shutdown === shutdown) shutdown.timer = setTimeout(finishAfterDrain, cleanupMs);
      });
    };
    const shutdown: WorkerShutdown = {
      done,
      finish,
      timer: this.workerExit ? setTimeout(finishAfterDrain, cleanupMs) : setTimeout(afterGrace, shutdownMs),
    };
    this.shutdown = shutdown;
    // Closing the pipe asks the worker to abort its active job. A crashed
    // Electron process closes the same pipe automatically.
    worker.stdin.end();
    return shutdown.done;
  }

  private retry() {
    if (!this.state.pairing) return;
    this.retryTimer = setTimeout(() => this.start(), this.rapidExits >= 3 ? rapidExitRetryMs : this.retryMs);
    this.retryTimer.unref();
    this.retryMs = Math.min(this.retryMs * 2, maxRetryMs);
  }

  private start() {
    const { pairing, allowedRoots } = this.state;
    if (!pairing) return;
    if (!workerCheckoutReady(this.options.repoRoot)) {
      this.options.log('coding device worker needs setup: codingDeviceRepoRoot must contain scripts/coding-device.ts and node_modules/@mohassan/coding-link');
      this.options.onStatus('setup-required');
      return;
    }
    const { encryptedKey, ...connection } = pairing;
    let deviceKey: string;
    try {
      deviceKey = this.options.decrypt(encryptedKey);
      if (!keyPattern.test(deviceKey)) throw new Error('Invalid device key');
    } catch {
      this.options.log('coding device worker needs pairing again: Windows could not decrypt the stored key');
      this.options.onStatus('repair-required');
      return;
    }
    let worker: WorkerProcess;
    const startedAt = Date.now();
    try {
      worker = this.spawnWorker(this.options.repoRoot);
    } catch {
      this.options.log('could not start the coding device worker');
      this.retry();
      return;
    }
    this.worker = worker;
    this.workerExit = undefined;
    worker.stdin.on('error', () => { /* The child close handler owns recovery. */ });
    worker.on('error', () => { /* Spawn failures are followed by close. */ });
    // Capture a key's worth of look-ahead so truncation cannot log a partial
    // key split across chunks or across the 4 KiB boundary.
    const captureLimit = stderrLimit + deviceKey.length - 1;
    let stderr = Buffer.alloc(0);
    worker.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < captureLimit) stderr = Buffer.concat([stderr, chunk.subarray(0, captureLimit - stderr.length)]);
    });
    const output = createInterface({ input: worker.stdout, crlfDelay: Infinity });
    output.on('line', line => {
      if (this.worker !== worker || this.shutdown) return;
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
    let finishing = false;
    this.finishWorker = ({ code, signal }) => {
      if (finishing) return;
      finishing = true;
      output.close();
      this.options.log(`coding device worker exited (code ${code ?? 'none'}, signal ${signal ?? 'none'})`);
      if (stderr.length) {
        const safe = stderr.toString('utf8').replaceAll(deviceKey, '[redacted]').replace(/[\x00-\x1f\x7f]/g, ' ');
        const preview = new StringDecoder('utf8').write(Buffer.from(safe).subarray(0, stderrLimit));
        this.options.log(`coding device worker stderr: ${preview}`);
      }
      const shutdown = this.shutdown;
      if (shutdown) {
        clearTimeout(shutdown.timer);
        const finish = () => {
          clearTimeout(shutdown.timer);
          this.worker = undefined;
          this.finishWorker = undefined;
          this.shutdown = undefined;
          shutdown.finish();
          this.start();
        };
        if (shutdown.kill) void shutdown.kill.then(finish);
        else finish();
        return;
      }
      this.worker = undefined;
      this.finishWorker = undefined;
      this.online = false;
      this.options.onStatus('offline');
      this.rapidExits = Date.now() - startedAt < 10_000 ? this.rapidExits + 1 : 0;
      if (this.rapidExits === 3) this.options.onRapidExit();
      this.retry();
    };
    const finish = this.finishWorker;
    worker.once('exit', (code, signal) => { this.workerExit = { code, signal }; });
    worker.once('close', (code, signal) => finish({ code, signal }));
    worker.stdin.write(`${JSON.stringify({ ...connection, allowedRoots, deviceKey })}\n`);
  }
}
