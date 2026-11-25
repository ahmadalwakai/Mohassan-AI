import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModelAdapter } from './adapters.js';
import { modelRegistry, resolveModel, type ModelEntry, type ResolvedModel } from './registry.js';

export type ModelFailureReason = 'unknown-model' | 'absent' | 'incompatible' | 'gpu-locked' | 'busy'
  | 'memory-budget' | 'timeout' | 'unhealthy' | 'unsupported' | 'invalid-input';
export type ModelFailure = { ok: false; reason: ModelFailureReason; elapsedMs: number; detail?: string };
export type ModelHealthResult = { ok: true; elapsedMs: number } | ModelFailure;
export type ModelRunResult = { ok: true; output: unknown; elapsedMs: number } | ModelFailure;

export class ModelRuntimeError extends Error {
  constructor(readonly reason: ModelFailureReason, readonly detail?: string) {
    super(detail ?? reason);
  }
}

export interface ModelAdapter {
  warmup?(signal: AbortSignal): void | Promise<void>;
  health(signal: AbortSignal): boolean | Promise<boolean>;
  run(input: unknown, signal: AbortSignal, timeoutMs: number): unknown | Promise<unknown>;
  close?(): void | Promise<void>;
}

export interface ModelAdapterContext {
  root: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  memoryBudgetMiB: number;
  dependencies: readonly ResolvedModel[];
  startupMs: number;
  assertGpuFree(): Promise<void>;
}

export interface ModelRuntimeOptions {
  root?: string;
  env?: NodeJS.ProcessEnv;
  memoryBudgetMiB?: number;
  cpuConcurrency?: number;
  idleMs?: number;
  heavyAvailable?: () => boolean;
  registry?: readonly ModelEntry[];
  resolve?: typeof resolveModel;
  loadAdapter?: (model: ResolvedModel, context: ModelAdapterContext) => ModelAdapter | Promise<ModelAdapter>;
}

interface Slot {
  readonly entry: ModelEntry;
  promise: Promise<ModelAdapter>;
  adapter?: ModelAdapter;
  users: number;
  lastUse: number;
  invalid: boolean;
  reserved: boolean;
  loaded: boolean;
  timer?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
}

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const heavy = (entry: ModelEntry) => entry.runtime !== 'node-cpu';
const startupBudget = (entry: ModelEntry) => Math.max(entry.resources.latencyMs, heavy(entry) ? 90_000 : 10_000);

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

/** Holds CPU and memory reservations until underlying work and disposal settle. */
export class ModelRuntime {
  private readonly entries: ReadonlyMap<string, ModelEntry>;
  private readonly root: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly memoryBudgetMiB: number;
  private readonly cpuConcurrency: number;
  private readonly idleMs: number;
  private readonly resolveEntry: typeof resolveModel;
  private readonly loadAdapter: NonNullable<ModelRuntimeOptions['loadAdapter']>;
  private readonly heavyAvailable: () => boolean;
  private readonly slots = new Map<string, Slot>();
  private readonly pending = new Map<Promise<unknown>, AbortController>();
  private cpuUsed = 0;
  private heavyBusy = false;
  private readonly lifecycle = new AbortController();
  private closed = false;
  private closing?: Promise<void>;

  constructor(options: ModelRuntimeOptions = {}) {
    this.entries = new Map((options.registry ?? modelRegistry).map(entry => [entry.id, entry]));
    this.root = resolve(options.root ?? repositoryRoot);
    this.env = options.env ?? process.env;
    this.memoryBudgetMiB = positiveInteger(options.memoryBudgetMiB ?? 4_608, 'memoryBudgetMiB');
    this.cpuConcurrency = positiveInteger(options.cpuConcurrency ?? 2, 'cpuConcurrency');
    this.idleMs = positiveInteger(options.idleMs ?? 60_000, 'idleMs');
    this.resolveEntry = options.resolve ?? resolveModel;
    this.loadAdapter = options.loadAdapter ?? loadModelAdapter;
    this.heavyAvailable = options.heavyAvailable ?? (() => true);
  }

  async run(modelId: string, input: unknown): Promise<ModelRunResult> {
    return this.execute(modelId, async (adapter, signal, timeout) => ({ output: await adapter.run(input, signal, timeout) }), false);
  }

  async health(modelId: string): Promise<ModelHealthResult> {
    return this.execute(modelId, async () => ({}), true);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.lifecycle.abort();
    for (const controller of this.pending.values()) controller.abort();
    this.closing = Promise.allSettled([...this.pending.keys()]).then(async () => {
      await Promise.allSettled([...this.slots.values()].map(slot => this.evict(slot)));
    });
    return this.closing;
  }

  private async execute<T extends object>(modelId: string, operation: (adapter: ModelAdapter, signal: AbortSignal, timeout: number) => Promise<T>, check: boolean): Promise<({ ok: true; elapsedMs: number } & T) | ModelFailure> {
    const begin = performance.now();
    const failure = (reason: ModelFailureReason, detail?: string): ModelFailure => ({ ok: false, reason, elapsedMs: performance.now() - begin, ...(detail ? { detail } : {}) });
    const entry = this.entries.get(modelId);
    if (!entry) return failure('unknown-model');
    if (this.closed) return failure('unhealthy', 'Runtime is closed');
    if (this.cpuUsed + entry.resources.cpu > this.cpuConcurrency || (heavy(entry) && (this.heavyBusy || !this.heavyAvailable()))) return failure('busy');
    this.cpuUsed += entry.resources.cpu;
    if (heavy(entry)) this.heavyBusy = true;

    const cold = !this.slots.get(entry.id)?.loaded;
    let phaseStart = begin;
    let phaseBudget = check || cold ? startupBudget(entry) : entry.resources.latencyMs;
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let expired!: (failure: ModelFailure) => void;
    const limit = new Promise<ModelFailure>(done => { expired = done; });
    const startDeadline = () => {
      clearTimeout(deadline);
      deadline = setTimeout(() => {
        controller.abort();
        expired(failure('timeout'));
      }, phaseBudget);
    };
    startDeadline();
    const task = this.use(entry, controller.signal, async adapter => {
      if (performance.now() - phaseStart > phaseBudget) throw new ModelRuntimeError('timeout');
      if (!check && cold) {
        phaseStart = performance.now();
        phaseBudget = entry.resources.latencyMs;
        startDeadline();
      }
      return operation(adapter, controller.signal, Math.max(1, Math.ceil(phaseBudget - (performance.now() - phaseStart))));
    }).finally(() => {
      this.cpuUsed -= entry.resources.cpu;
      if (heavy(entry)) this.heavyBusy = false;
    });
    this.pending.set(task, controller);
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
    try {
      const result = await Promise.race([
        task.then(value => performance.now() - phaseStart > phaseBudget ? failure('timeout') : { ok: true as const, elapsedMs: performance.now() - begin, ...value }),
        limit,
      ]);
      return result;
    } catch (error) {
      if (controller.signal.aborted) return failure(this.closed ? 'unhealthy' : 'timeout');
      if (error instanceof ModelRuntimeError) return failure(error.reason, error.detail);
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return failure('absent');
      return failure('unhealthy');
    } finally {
      clearTimeout(deadline);
    }
  }

  private async use<T>(entry: ModelEntry, signal: AbortSignal, operation: (adapter: ModelAdapter) => Promise<T>): Promise<T> {
    let slot = this.slots.get(entry.id);
    if (slot?.closing) {
      await slot.closing;
      slot = this.slots.get(entry.id);
    }
    signal.throwIfAborted();
    if (!slot) {
      const loading: Slot = { entry, users: 0, lastUse: performance.now(), invalid: false, reserved: false, loaded: false, promise: Promise.resolve().then(() => this.load(entry)) };
      void loading.promise.catch(() => { loading.invalid = true; });
      slot = loading;
      this.slots.set(entry.id, loading);
    }
    clearTimeout(slot.timer);
    slot.users++;
    try {
      const adapter = await slot.promise;
      slot.loaded = true;
      signal.throwIfAborted();
      if (!(await adapter.health(signal))) throw new ModelRuntimeError('unhealthy');
      signal.throwIfAborted();
      return await operation(adapter);
    } catch (error) {
      if (!signal.aborted && (!(error instanceof ModelRuntimeError) || !['invalid-input', 'unsupported', 'busy', 'timeout'].includes(error.reason))) slot.invalid = true;
      throw error;
    } finally {
      slot.users--;
      slot.lastUse = performance.now();
      if (slot.users === 0) {
        if (slot.invalid || this.closed) await this.evict(slot);
        else {
          slot.timer = setTimeout(() => { void this.evict(slot).catch(() => {}); }, this.idleMs);
          slot.timer.unref();
        }
      }
    }
  }

  private async load(entry: ModelEntry): Promise<ModelAdapter> {
    const slot = this.slots.get(entry.id)!;
    const startupMs = startupBudget(entry);
    const signal = AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(startupMs)]);
    const model = await this.resolveEntry(entry, this.root, this.env, false);
    if (model.state === 'absent') throw new ModelRuntimeError('absent');
    const dependencies: ResolvedModel[] = [];
    for (const dependency of entry.dependencies) {
      const candidate = this.entries.get(dependency.id);
      if (!candidate || candidate.version !== dependency.version) {
        throw new ModelRuntimeError('incompatible', `${entry.id} requires ${dependency.id}@${dependency.version}; found ${candidate?.version ?? 'no registered version'}`);
      }
      const resolved = await this.resolveEntry(candidate, this.root, this.env, false);
      if (resolved.state === 'absent') throw new ModelRuntimeError('absent', `Dependency ${dependency.id}@${dependency.version} is absent`);
      dependencies.push(resolved);
    }
    await this.reserve(slot);
    const assertGpuFree = async () => {
      try {
        await lstat(join(this.root, '.data', 'gpu.lock'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      }
      throw new ModelRuntimeError('gpu-locked');
    };
    if (entry.runtime === 'gpu') await assertGpuFree();
    signal.throwIfAborted();
    const verified = await this.resolveEntry(entry, this.root, this.env, true);
    if (verified.state === 'absent') throw new ModelRuntimeError('absent');
    const badPin = verified.artifacts.find(artifact => artifact.matchesPin === false || (artifact.present &&
      entry.artifacts.some(pin => pin.role === artifact.role && pin.sha256 && artifact.sha256 !== pin.sha256)));
    if (badPin) throw new ModelRuntimeError('unhealthy', `Could not verify ${badPin.role} SHA-256`);
    try {
      signal.throwIfAborted();
      if (heavy(entry) && !this.heavyAvailable()) throw new ModelRuntimeError('busy');
      const adapter = await this.loadAdapter(verified, { root: this.root, env: this.env, signal, memoryBudgetMiB: this.memoryBudgetMiB, dependencies, startupMs, assertGpuFree });
      slot.adapter = adapter;
      await adapter.warmup?.(signal);
      signal.throwIfAborted();
      return adapter;
    } catch (error) {
      if (signal.aborted) throw new ModelRuntimeError('timeout');
      throw error;
    }
  }

  private async reserve(slot: Slot): Promise<void> {
    if (slot.entry.resources.memoryMb > this.memoryBudgetMiB) throw new ModelRuntimeError('memory-budget');
    if (heavy(slot.entry)) {
      await Promise.all([...this.slots.values()].filter(other => other !== slot && heavy(other.entry)).map(other => this.evict(other)));
    }
    const used = () => [...this.slots.values()].reduce((sum, other) => sum + (other.reserved ? other.entry.resources.memoryMb : 0), slot.entry.resources.memoryMb);
    const idle = [...this.slots.values()].filter(other => other.reserved && other.users === 0).sort((a, b) => a.lastUse - b.lastUse);
    for (const other of idle) {
      if (used() <= this.memoryBudgetMiB) break;
      if (other.users === 0) await this.evict(other);
    }
    if (used() > this.memoryBudgetMiB) throw new ModelRuntimeError('memory-budget');
    slot.reserved = true;
  }

  private evict(slot: Slot): Promise<void> {
    if (slot.closing) return slot.closing;
    clearTimeout(slot.timer);
    slot.closing = slot.promise.catch(() => {}).then(() => slot.adapter?.close?.()).then(() => {
      // A failed stop can leave an OS process alive. Keep its reservation until cleanup is confirmed.
      this.slots.delete(slot.entry.id);
    });
    return slot.closing;
  }
}

export function createModelRuntime(options: ModelRuntimeOptions = {}): ModelRuntime {
  return new ModelRuntime(options);
}
