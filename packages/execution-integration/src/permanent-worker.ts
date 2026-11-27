import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import {
  MAX_WORKER_FRAME_BYTES, MODEL_WORKER_PROTOCOL, parseWorkerFrame, parseWorkerReadiness, parseWorkerResponse,
  type ModelWorkerOperation, type ModelWorkerResult, type ModelWorkerStartupError, type ModelWorkerToken,
  type PermanentModelWorkerReady,
} from './permanent-worker-protocol.js';
import {
  ModelTransportError, copyJson, id, integer, keys, record,
  type ModelIdentity, type TransportErrorCode, type TransportJson,
} from './transport.js';

const STABLE_WORKER_MS = 30_000;
const STDERR_BYTES_PER_SECOND = 1_048_576;
const PROCESS_ERROR = 'model_process_failure';

export interface PermanentModelWorkerOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly identity: ModelIdentity;
  readonly startupTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly restartMinMs?: number;
  readonly restartMaxMs?: number;
  readonly onState?: (status: PermanentModelWorkerStatus) => void;
}

export type PermanentModelWorkerStatus =
  | { readonly state: 'stopped' | 'starting' | 'stopping' }
  | { readonly state: 'ready'; readonly pid: number; readonly startupMs: number; readonly ready: PermanentModelWorkerReady }
  | { readonly state: 'degraded'; readonly code: TransportErrorCode | ModelWorkerStartupError; readonly restartInMs?: number };

export interface PermanentModelWorkerRequest {
  readonly operation: ModelWorkerOperation;
  readonly head: string;
  readonly input: Readonly<Record<string, TransportJson>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onToken?: (token: ModelWorkerToken) => void;
}

interface PendingRequest {
  readonly operation: ModelWorkerOperation;
  readonly chatGeneration: boolean;
  readonly onToken?: (token: ModelWorkerToken) => void;
  readonly resolve: (result: ModelWorkerResult) => void;
  readonly reject: (error: ModelTransportError) => void;
  readonly clearDeadline: () => void;
  readonly tokens: number[];
  readonly textChunks?: string[];
  readonly expiresAt: number;
  readonly maxOutputTokens: number;
  readonly scoreOptionCount?: number;
  bytes: number;
  cancelDeadline?: ReturnType<typeof setTimeout>;
}

interface WorkerProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly startedAt: number;
  readonly closed: Promise<void>;
  readonly pending: Map<string, PendingRequest>;
  startupDeadline?: ReturnType<typeof setTimeout>;
  exitDeadline?: ReturnType<typeof setTimeout>;
  killDeadline?: ReturnType<typeof setTimeout>;
  restartInMs?: number;
  readyAt?: number;
  ready?: PermanentModelWorkerReady;
  failed: boolean;
}

function validateOptions(options: PermanentModelWorkerOptions) {
  const absoluteLocalPath = (path: string) =>
    typeof path === 'string' && isAbsolute(path) && !/^[\\/]{2}/.test(path) && !path.includes('\0');
  const { executable, cwd, args, environment, identity, onState } = options;
  const { startupTimeoutMs = 60_000, cleanupTimeoutMs = 3_000, restartMinMs = 250, restartMaxMs = 10_000 } = options;
  if (!absoluteLocalPath(executable) || !absoluteLocalPath(cwd) || !Array.isArray(args) || args.length > 128
    || args.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0'))
    || !record(environment) || Object.keys(environment).length > 128 || Object.entries(environment).some(([name, value]) =>
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string' || value.length > 32_768 || value.includes('\0'))
    || !identity || !id(identity.modelId) || !id(identity.tokenizerId) || !id(identity.checkpointId)
    || !integer(startupTimeoutMs, 1, 600_000) || !integer(cleanupTimeoutMs, 1, 60_000)
    || !integer(restartMinMs, 1, 60_000) || !integer(restartMaxMs, restartMinMs, 600_000)) {
    throw new ModelTransportError('invalid_configuration');
  }
  return {
    executable, cwd, args: [...args], environment: { ...environment }, identity: { ...identity }, onState,
    startupTimeoutMs, cleanupTimeoutMs, restartMinMs, restartMaxMs,
  };
}

function waitForClose(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const deadline = setTimeout(() => resolve(false), timeoutMs);
    void closed.then(() => {
      clearTimeout(deadline);
      resolve(true);
    });
  });
}

function killWorker(child: ChildProcessWithoutNullStreams): void {
  try {
    if (process.platform === 'linux' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** Multiplexes trusted, locally configured model inference over a single NDJSON process. */
export class PermanentModelWorker {
  private readonly options: ReturnType<typeof validateOptions>;
  private currentStatus: PermanentModelWorkerStatus = Object.freeze({ state: 'stopped' });
  private worker?: WorkerProcess;
  private running = false;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private stopping?: Promise<void>;
  private nextRestartMs: number;

  constructor(options: PermanentModelWorkerOptions) {
    this.options = validateOptions(options);
    this.nextRestartMs = this.options.restartMinMs;
  }

  get status(): PermanentModelWorkerStatus {
    return this.currentStatus;
  }

  start(): void {
    if (this.running || this.worker || this.stopping) return;
    this.running = true;
    this.nextRestartMs = this.options.restartMinMs;
    this.setStatus({ state: 'starting' });
    this.launch();
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.running = false;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const worker = this.worker;
    if (!worker) {
      if (this.status.state !== 'stopped') this.setStatus({ state: 'stopped' });
      return Promise.resolve();
    }
    this.setStatus({ state: 'stopping' });
    this.rejectRequests(worker, 'cancelled');
    clearTimeout(worker.startupDeadline);
    worker.child.stdin.end(JSON.stringify({ protocol: MODEL_WORKER_PROTOCOL, kind: 'shutdown' }) + '\n');
    this.stopping = this.finishStop(worker).finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  async request(request: PermanentModelWorkerRequest): Promise<ModelWorkerResult> {
    const worker = this.worker;
    const ready = worker?.ready;
    if (request.signal?.aborted) throw new ModelTransportError('cancelled');
    if (this.status.state !== 'ready' || !worker || !ready) throw new ModelTransportError(PROCESS_ERROR);
    const { operation, head, signal, onToken } = request;
    const timeoutMs = request.timeoutMs ?? Math.min(30_000, ready.limits.maxTimeoutMs);
    if (!id(head) || !integer(timeoutMs, 1, ready.limits.maxTimeoutMs)
      || !['classify', 'score', 'select', 'generate', 'score-options'].includes(operation)
      || (onToken !== undefined && (operation !== 'generate' || typeof onToken !== 'function'))) {
      throw new ModelTransportError('invalid_request');
    }
    const requiredHead = operation === 'score' || operation === 'select' ? 'pointer' : operation;
    if (ready.heads[head] !== requiredHead) throw new ModelTransportError('unsupported_capability');
    if (worker.pending.size >= ready.limits.maxPending) throw new ModelTransportError('resource_exhaustion');

    const input = copyJson(request.input, 'invalid_request');
    if (!record(input)) throw new ModelTransportError('invalid_request');
    const chatGeneration = operation === 'generate' && input.messages !== undefined;
    const textInput = (operation === 'generate' || operation === 'score-options') && input.text !== undefined;
    if (chatGeneration && (!Array.isArray(input.messages) || !input.messages.length || textInput
      || input.inputIds !== undefined || onToken !== undefined)) throw new ModelTransportError('invalid_request');
    if (textInput && (typeof input.text !== 'string' || input.inputIds !== undefined)) throw new ModelTransportError('invalid_request');
    // A raw prompt continues plain text without chat framing (model_worker/engine.py); it streams text like a text turn.
    const promptInput = operation === 'generate' && input.prompt !== undefined;
    if (promptInput && (typeof input.prompt !== 'string' || textInput || chatGeneration || input.inputIds !== undefined)) {
      throw new ModelTransportError('invalid_request');
    }
    if ((textInput || chatGeneration || promptInput) && !ready.text) throw new ModelTransportError('unsupported_capability');
    const textChunks = (textInput || promptInput) && operation === 'generate' ? [] : undefined;
    let maxOutputTokens = 0;
    if (operation === 'generate') {
      if (!integer(input.maxNewTokens, 1, ready.limits.maxOutputTokens)) throw new ModelTransportError('invalid_request');
      maxOutputTokens = input.maxNewTokens;
    }
    let scoreOptionCount: number | undefined;
    if (operation === 'score-options') {
      if (!Array.isArray(input.options) || !integer(input.options.length, 2, 16)) {
        throw new ModelTransportError('invalid_request');
      }
      scoreOptionCount = input.options.length;
    }
    const requestId = randomUUID();
    const frame = JSON.stringify({ protocol: MODEL_WORKER_PROTOCOL, kind: 'request', requestId, timeoutMs, operation, head, input }) + '\n';
    const bytes = Buffer.byteLength(frame);
    if (bytes > ready.limits.maxInputBytes) throw new ModelTransportError('invalid_request');
    if (worker.child.stdin.writableLength + bytes > MAX_WORKER_FRAME_BYTES) throw new ModelTransportError('resource_exhaustion');
    if (signal?.aborted) throw new ModelTransportError('cancelled');
    if (this.status.state !== 'ready' || this.worker !== worker) throw new ModelTransportError(PROCESS_ERROR);

    return new Promise((resolve, reject) => {
      const onAbort = () => this.cancel(worker, requestId, 'cancelled');
      const expiresAt = performance.now() + timeoutMs;
      const deadline = setTimeout(() => this.cancel(worker, requestId, 'timeout'), timeoutMs);
      const clearDeadline = () => {
        clearTimeout(deadline);
        signal?.removeEventListener('abort', onAbort);
      };
      worker.pending.set(requestId, {
        operation, chatGeneration, onToken, resolve, reject, clearDeadline, expiresAt, maxOutputTokens,
        scoreOptionCount, textChunks, tokens: [], bytes: 0,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.write(worker, frame);
    });
  }

  private setStatus(status: PermanentModelWorkerStatus): void {
    this.currentStatus = Object.freeze(status);
    const notify = this.options.onState;
    if (notify) queueMicrotask(() => {
      try { notify(status); } catch { /* Status observers cannot interrupt worker supervision. */ }
    });
  }

  private launch(): void {
    const { executable, args, cwd, environment, startupTimeoutMs } = this.options;
    const startedAt = performance.now();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, args, {
        cwd, env: environment, stdio: 'pipe', shell: false, windowsHide: true, detached: process.platform === 'linux',
      });
    } catch {
      this.scheduleRestart(this.recordFailure(PROCESS_ERROR));
      return;
    }
    let close!: () => void;
    const closed = new Promise<void>(resolve => { close = resolve; });
    const worker: WorkerProcess = { child, startedAt, closed, pending: new Map(), failed: false };
    this.worker = worker;
    worker.startupDeadline = setTimeout(() => this.fail(worker, 'timeout'), startupTimeoutMs);
    const onError = () => this.fail(worker, PROCESS_ERROR);
    child.once('error', onError);
    child.once('exit', () => {
      // Let buffered frames drain even if the worker exits before stdout closes.
      worker.exitDeadline = setTimeout(onError, this.options.cleanupTimeoutMs);
    });
    child.stdin.on('error', onError);
    child.stdout.on('error', onError);
    child.stderr.on('error', onError);
    child.once('close', () => {
      close();
      clearTimeout(worker.startupDeadline);
      clearTimeout(worker.exitDeadline);
      clearTimeout(worker.killDeadline);
      this.worker = undefined;
      this.rejectRequests(worker, PROCESS_ERROR);
      if (!this.running) {
        this.setStatus({ state: 'stopped' });
        return;
      }
      this.scheduleRestart(worker.restartInMs ?? this.recordFailure(PROCESS_ERROR));
    });

    this.readOutput(worker);
    let stderrBytes = 0;
    let stderrWindow = startedAt;
    child.stderr.on('data', (chunk: Buffer) => {
      const now = performance.now();
      if (now - stderrWindow >= 1_000) {
        stderrBytes = 0;
        stderrWindow = now;
      }
      stderrBytes += chunk.length;
      if (stderrBytes > STDERR_BYTES_PER_SECOND) this.fail(worker, 'resource_exhaustion');
    });
  }

  private readOutput(worker: WorkerProcess): void {
    let buffer = Buffer.alloc(0);
    let pending = 0;
    worker.child.stdout.on('data', (chunk: Buffer) => {
      if (worker.failed || !this.running) return;
      try {
        for (let offset = 0; offset < chunk.length && !worker.failed && this.running;) {
          const newline = chunk.indexOf(10, offset);
          const part = chunk.subarray(offset, newline === -1 ? chunk.length : newline);
          const size = pending + part.length;
          const frameLimit = Math.min(MAX_WORKER_FRAME_BYTES, worker.ready?.limits.maxOutputBytes ?? MAX_WORKER_FRAME_BYTES);
          if (size + 1 > frameLimit) throw new ModelTransportError('resource_exhaustion');
          if (pending || newline === -1) {
            if (size > buffer.length) {
              const grown = Buffer.allocUnsafe(Math.min(frameLimit, Math.max(4096, buffer.length * 2, size)));
              buffer.copy(grown, 0, 0, pending);
              buffer = grown;
            }
            part.copy(buffer, pending);
            pending = size;
          }
          if (newline === -1) break;
          const line = pending ? buffer.subarray(0, pending) : part;
          this.receive(worker, parseWorkerFrame(line), size + 1);
          offset = newline + 1;
          pending = 0;
        }
      } catch (error) {
        this.fail(worker, error instanceof ModelTransportError ? error.code : 'invalid_model_output');
      }
    });
  }

  private receive(worker: WorkerProcess, frame: Record<string, unknown>, bytes: number): void {
    const ready = worker.ready;
    if (!ready) {
      const message = parseWorkerReadiness(frame, this.options.identity);
      if (message.kind === 'startup_error') return this.fail(worker, message.code);
      if (worker.child.pid === undefined) throw new ModelTransportError(PROCESS_ERROR);
      clearTimeout(worker.startupDeadline);
      worker.ready = message.ready;
      worker.readyAt = performance.now();
      this.setStatus({ state: 'ready', pid: worker.child.pid, ready: message.ready, startupMs: worker.readyAt - worker.startedAt });
      return;
    }

    const response = parseWorkerResponse(frame);
    const pending = worker.pending.get(response.requestId);
    if (!pending) throw new ModelTransportError('invalid_model_output');
    if (response.kind !== 'error') {
      pending.bytes += bytes;
      if (pending.bytes > ready.limits.maxOutputBytes) throw new ModelTransportError('resource_exhaustion');
    }
    if (response.kind === 'token') {
      const { token, index, text } = response;
      if (pending.operation !== 'generate' || pending.chatGeneration || index !== pending.tokens.length
        || pending.tokens.length >= pending.maxOutputTokens || Boolean(pending.textChunks) !== (text !== undefined)) {
        throw new ModelTransportError('invalid_model_output');
      }
      pending.tokens.push(token);
      if (text !== undefined) pending.textChunks?.push(text);
      if (performance.now() >= pending.expiresAt) this.cancel(worker, response.requestId, 'timeout');
      if (!pending.cancelDeadline) {
        try { pending.onToken?.({ token, index, ...(text === undefined ? {} : { text }) }); }
        catch { this.cancel(worker, response.requestId, 'cancelled'); }
      }
      return;
    }
    if (response.kind === 'result' && pending.chatGeneration) {
      keys(response.result, ['text', 'stopReason', 'loopCut']);
      const { text, stopReason, loopCut } = response.result;
      if (typeof text !== 'string' || /\p{Surrogate}/u.test(text) || typeof loopCut !== 'boolean'
        || (stopReason !== 'eos' && stopReason !== 'length'
          && !(stopReason === 'context_limit' && text === '' && !loopCut))) {
        throw new ModelTransportError('invalid_model_output');
      }
    } else if (response.kind === 'result' && pending.operation === 'generate') {
      keys(response.result, pending.textChunks ? ['tokenIds', 'stopReason', 'text', 'inputTokens'] : ['tokenIds', 'stopReason']);
      const { tokenIds: tokens, stopReason, text, inputTokens } = response.result;
      if (!Array.isArray(tokens) || tokens.length !== pending.tokens.length
        || (stopReason !== 'eos' && stopReason !== 'length')
        || tokens.some((token, index) => token !== pending.tokens[index])
        || (pending.textChunks && (text !== pending.textChunks.join('') || !integer(inputTokens, 1, 8192)))) {
        throw new ModelTransportError('invalid_model_output');
      }
    }
    if (response.kind === 'result' && pending.operation === 'score-options') {
      keys(response.result, ['scores']);
      const { scores } = response.result;
      if (!Array.isArray(scores) || scores.length !== pending.scoreOptionCount
        || scores.some(score => typeof score !== 'number' || !Number.isFinite(score) || score > 0)) {
        throw new ModelTransportError('invalid_model_output');
      }
    }
    worker.pending.delete(response.requestId);
    pending.clearDeadline();
    clearTimeout(pending.cancelDeadline);
    if (performance.now() >= pending.expiresAt) pending.reject(new ModelTransportError('timeout'));
    else if (response.kind === 'error') pending.reject(new ModelTransportError(response.code));
    else pending.resolve(response.result);
  }

  private write(worker: WorkerProcess, frame: string): void {
    try {
      worker.child.stdin.write(frame, error => { if (error) this.fail(worker, PROCESS_ERROR); });
    } catch {
      this.fail(worker, PROCESS_ERROR);
    }
  }

  private cancel(worker: WorkerProcess, requestId: string, code: 'cancelled' | 'timeout'): void {
    const pending = worker.pending.get(requestId);
    if (!pending || pending.cancelDeadline) return;
    pending.clearDeadline();
    pending.reject(new ModelTransportError(code));
    // Keep the slot until the peer acknowledges cancellation, including races with completion.
    pending.cancelDeadline = setTimeout(() => this.fail(worker, 'timeout'), this.options.cleanupTimeoutMs);
    this.write(worker, JSON.stringify({ protocol: MODEL_WORKER_PROTOCOL, kind: 'cancel', requestId }) + '\n');
  }

  private rejectRequests(worker: WorkerProcess, code: TransportErrorCode): void {
    for (const pending of worker.pending.values()) {
      pending.clearDeadline();
      clearTimeout(pending.cancelDeadline);
      pending.reject(new ModelTransportError(code));
    }
    worker.pending.clear();
  }

  private fail(worker: WorkerProcess, code: TransportErrorCode | ModelWorkerStartupError): void {
    if (worker.failed || !this.running) return;
    worker.failed = true;
    clearTimeout(worker.startupDeadline);
    this.rejectRequests(worker, code === 'model_identity_mismatch' || code === 'invalid_model_output'
      || code === 'resource_exhaustion' || code === 'timeout' ? code : PROCESS_ERROR);
    worker.restartInMs = this.recordFailure(code, worker.readyAt);
    killWorker(worker.child);
    worker.killDeadline = setTimeout(() => this.setStatus({ state: 'degraded', code: 'process_cleanup_failed' }),
      this.options.cleanupTimeoutMs);
  }

  private recordFailure(code: TransportErrorCode | ModelWorkerStartupError, readyAt?: number): number {
    if (readyAt !== undefined && performance.now() - readyAt >= STABLE_WORKER_MS) {
      this.nextRestartMs = this.options.restartMinMs;
    }
    const restartInMs = this.nextRestartMs;
    this.nextRestartMs = Math.min(restartInMs * 2, this.options.restartMaxMs);
    this.setStatus({ state: 'degraded', code, restartInMs });
    return restartInMs;
  }

  private scheduleRestart(delay: number): void {
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.running) this.launch();
    }, delay);
  }

  private async finishStop(worker: WorkerProcess): Promise<void> {
    if (await waitForClose(worker.closed, this.options.cleanupTimeoutMs)) return;
    killWorker(worker.child);
    if (await waitForClose(worker.closed, this.options.cleanupTimeoutMs)) return;
    this.setStatus({ state: 'degraded', code: 'process_cleanup_failed' });
    throw new ModelTransportError('process_cleanup_failed');
  }
}
