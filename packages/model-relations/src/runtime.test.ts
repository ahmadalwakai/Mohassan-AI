import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelRegistry, type ModelEntry } from './registry.js';
import { createModelRuntime, type ModelAdapter, type ModelRuntimeOptions } from './runtime.js';

const roots: string[] = [];
const runtimes: ReturnType<typeof createModelRuntime>[] = [];

function runtime(options: ModelRuntimeOptions = {}) {
  const instance = createModelRuntime(options);
  runtimes.push(instance);
  return instance;
}

function entry(id: string, options: Partial<ModelEntry> = {}): ModelEntry {
  return {
    ...modelRegistry[0]!, id, version: 'v1', state: 'experimental', artifacts: [],
    runtime: 'node-cpu', resources: { memoryMb: 8, cpu: 1, gpu: false, latencyMs: 500 },
    dependencies: [], ...options,
  };
}

const present: NonNullable<ModelRuntimeOptions['resolve']> = async entry => ({ entry, state: entry.state, artifacts: [] });

function adapter(run: ModelAdapter['run'] = input => input): ModelAdapter {
  return { health: () => true, run };
}

function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(value => value.close()));
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('model runtime', () => {
  it('loads lazily once, warms up, and reuses healthy resident models', async () => {
    const warmup = vi.fn();
    const health = vi.fn(() => true);
    const loadAdapter = vi.fn(() => ({ ...adapter(), warmup, health }));
    const instance = runtime({ registry: [entry('small')], resolve: present, loadAdapter });
    expect(loadAdapter).not.toHaveBeenCalled();
    expect(await instance.run('small', 'first')).toMatchObject({ ok: true, output: 'first' });
    expect(await instance.health('small')).toMatchObject({ ok: true });
    expect(await instance.run('small', 'second')).toMatchObject({ ok: true, output: 'second' });
    expect(loadAdapter).toHaveBeenCalledTimes(1);
    expect(warmup).toHaveBeenCalledTimes(1);
    expect(health).toHaveBeenCalledTimes(3);
  });

  it('budgets lazy startup independently of an already warm request', async () => {
    const small = entry('small', { resources: { memoryMb: 8, cpu: 1, gpu: false, latencyMs: 150 } });
    const instance = runtime({ registry: [small], resolve: present, loadAdapter: async () => {
      await new Promise(done => setTimeout(done, 200));
      return adapter();
    } });
    const result = await instance.run('small', 'after startup');
    expect(result).toMatchObject({ ok: true, output: 'after startup' });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(150);
  });

  it('reports absent artifacts and wrong trunk versions without launching an adapter', async () => {
    const loadAdapter = vi.fn(() => adapter());
    const resolve: ModelRuntimeOptions['resolve'] = async model => ({ entry: model, state: model.id === 'missing' ? 'absent' : model.state, artifacts: [] });
    const instance = runtime({ registry: [entry('missing'), entry('trunk'), entry('head', { dependencies: [{ id: 'trunk', version: 'v5' }] })], resolve, loadAdapter });
    expect(await instance.health('missing')).toMatchObject({ ok: false, reason: 'absent' });
    expect(await instance.run('head', {})).toMatchObject({ ok: false, reason: 'incompatible', detail: 'head requires trunk@v5; found v1' });
    expect(loadAdapter).not.toHaveBeenCalled();
  });

  it('does not call a failed health adapter and retries a new load', async () => {
    const run = vi.fn();
    const close = vi.fn();
    const loadAdapter = vi.fn().mockReturnValueOnce({ health: () => false, run, close }).mockImplementation(() => adapter());
    const instance = runtime({ registry: [entry('small')], resolve: present, loadAdapter });
    expect(await instance.run('small', 'input')).toMatchObject({ ok: false, reason: 'unhealthy' });
    expect(run).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(await instance.run('small', 'input')).toMatchObject({ ok: true, output: 'input' });
  });

  it('keeps timed-out work in the CPU budget until it actually stops', async () => {
    const worker = pending<string>();
    const start = pending<AbortSignal>();
    const small = entry('small', { resources: { memoryMb: 8, cpu: 1, gpu: false, latencyMs: 100 } });
    const other = entry('other', { resources: small.resources });
    const loadAdapter = vi.fn<NonNullable<ModelRuntimeOptions['loadAdapter']>>(model => model.entry.id === 'small'
      ? adapter((_input, signal) => { start.resolve(signal); return worker.promise; }) : adapter());
    const instance = runtime({ registry: [small, other], cpuConcurrency: 1, resolve: present, loadAdapter });
    await instance.health('small');
    const timed = instance.run('small', {});
    try {
      const signal = await start.promise;
      expect(await timed).toMatchObject({ ok: false, reason: 'timeout' });
      expect(signal.aborted).toBe(true);
      expect(await instance.run('other', {})).toMatchObject({ ok: false, reason: 'timeout' });
      expect(loadAdapter).toHaveBeenCalledOnce();
    } finally {
      worker.resolve('late result');
    }
    await vi.waitFor(async () => expect(await instance.health('other')).toMatchObject({ ok: true }));
  });

  it('waits in order during a CPU burst and gives admitted work only its remaining time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const workers = Array.from({ length: 5 }, () => pending<number>());
    const run = vi.fn<ModelAdapter['run']>((input) => workers[input as number]!.promise);
    const small = entry('small', { resources: { memoryMb: 8, cpu: 1, gpu: false, latencyMs: 100 } });
    const instance = runtime({ registry: [small], resolve: present, loadAdapter: () => adapter(run), cpuConcurrency: 2 });
    try {
      await instance.health('small');
      const [first, second, third, fourth, fifth] = workers.map((_, index) => instance.run('small', index));
      await vi.advanceTimersByTimeAsync(0);
      expect(run.mock.calls.map(([input]) => input)).toEqual([0, 1]);

      await vi.advanceTimersByTimeAsync(60);
      workers[0]!.resolve(0);
      expect(await first).toMatchObject({ ok: true, output: 0 });
      await vi.advanceTimersByTimeAsync(0);
      expect(run.mock.calls[2]).toEqual([2, expect.any(AbortSignal), 40]);

      await vi.advanceTimersByTimeAsync(20);
      workers[2]!.resolve(2);
      expect(await third).toMatchObject({ ok: true, output: 2 });
      await vi.advanceTimersByTimeAsync(0);
      expect(run.mock.calls[3]).toEqual([3, expect.any(AbortSignal), 20]);

      await vi.advanceTimersByTimeAsync(20);
      for (const result of await Promise.all([second, fourth, fifth])) {
        expect(result).toMatchObject({ ok: false, reason: 'timeout', elapsedMs: 100 });
      }
      expect(run.mock.calls.map(([input]) => input)).toEqual([0, 1, 2, 3]);
    } finally {
      workers.forEach((worker, index) => worker.resolve(index));
      await instance.close();
      vi.useRealTimers();
    }
  });

  it('subtracts a cold model’s slot wait from its call allowance and uses its separate startup budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const callMs = 100;
    const waitedMs = 60;
    const startupMs = 250;
    const startupDurationMs = 200;
    const warmWork = pending<number>();
    const coldAdapter = pending<ModelAdapter>();
    const cold = entry('cold', { resources: { memoryMb: 8, cpu: 1, gpu: false, latencyMs: callMs, startupMs } });
    const coldRun = vi.fn<ModelAdapter['run']>(input => input);
    const load = vi.fn<NonNullable<ModelRuntimeOptions['loadAdapter']>>(model => model.entry.id === 'cold'
      ? coldAdapter.promise : adapter(() => warmWork.promise));
    const instance = runtime({ registry: [entry('warm'), cold], resolve: present, loadAdapter: load, cpuConcurrency: 1 });
    try {
      await instance.health('warm');
      const active = instance.run('warm', 1);
      const queued = instance.run('cold', 2);
      await vi.advanceTimersByTimeAsync(waitedMs);
      expect(load).toHaveBeenCalledOnce();
      warmWork.resolve(1);
      expect(await active).toMatchObject({ ok: true });
      await vi.advanceTimersByTimeAsync(startupDurationMs);
      expect(load.mock.calls[1]?.[1].startupMs).toBe(startupMs);
      coldAdapter.resolve(adapter(coldRun));
      expect(await queued).toMatchObject({ ok: true, output: 2 });
      expect(coldRun).toHaveBeenCalledWith(2, expect.any(AbortSignal), callMs - waitedMs);
    } finally {
      warmWork.resolve(1);
      coldAdapter.resolve(adapter(coldRun));
      await instance.close();
      vi.useRealTimers();
    }
  });

  it('cancels a queued call when the caller deadline aborts before a slot opens', async () => {
    const worker = pending<number>();
    const started = pending<void>();
    const run = vi.fn<ModelAdapter['run']>(() => { started.resolve(); return worker.promise; });
    const instance = runtime({ registry: [entry('small')], resolve: present, loadAdapter: () => adapter(run), cpuConcurrency: 1 });
    const active = instance.run('small', 1);
    try {
      await started.promise;
      const caller = new AbortController();
      const queued = instance.run('small', 2, caller.signal);
      caller.abort();
      expect(await queued).toMatchObject({ ok: false, reason: 'timeout' });
    } finally {
      worker.resolve(1);
    }
    expect(await active).toMatchObject({ ok: true, output: 1 });
    expect(run).toHaveBeenCalledOnce();
  });

  it('unloads idle adapters and evicts the least recently used adapter under memory pressure', async () => {
    const disposed = vi.fn();
    const instance = runtime({ registry: [entry('first'), entry('second'), entry('too-large', { resources: { memoryMb: 9, cpu: 1, gpu: false, latencyMs: 500 } })],
      memoryBudgetMiB: 8, idleMs: 75, resolve: present, loadAdapter: model => ({ ...adapter(), close: () => disposed(model.entry.id) }) });
    expect(await instance.health('first')).toMatchObject({ ok: true });
    expect(await instance.health('second')).toMatchObject({ ok: true });
    expect(disposed).toHaveBeenCalledWith('first');
    expect(await instance.health('too-large')).toMatchObject({ ok: false, reason: 'memory-budget' });
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledWith('second'));
  });

  it('treats any existing GPU lock as authoritative and runs CPU adapters alongside it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'model-relations-lock-'));
    roots.push(root);
    await mkdir(join(root, '.data'));
    const lock = join(root, '.data', 'gpu.lock');
    await writeFile(lock, 'incomplete training lock');
    const loadAdapter = vi.fn(() => adapter());
    const instance = runtime({ root, registry: [entry('processor'), entry('accelerator', { runtime: 'gpu' })], resolve: present, loadAdapter });
    expect(await instance.health('accelerator')).toMatchObject({ ok: false, reason: 'gpu-locked' });
    expect(loadAdapter).not.toHaveBeenCalled();
    expect(await instance.health('processor')).toMatchObject({ ok: true });
    expect(loadAdapter).toHaveBeenCalledOnce();
  });

  it('serializes heavy adapters and unloads the current worker before loading a second worker', async () => {
    const events: string[] = [];
    const started = pending<void>();
    const release = pending<void>();
    const slow = adapter(async () => { started.resolve(); await release.promise; return 'done'; });
    const instance = runtime({ registry: [entry('first', { runtime: 'python-worker' }), entry('second', { runtime: 'python-worker' }), entry('cpu')], resolve: present,
      loadAdapter: model => {
        const id = model.entry.id;
        events.push(`start ${id}`);
        return { ...(id === 'first' ? slow : adapter()), close: () => { events.push(`stop ${id}`); } };
      } });
    const active = instance.run('first', {});
    let queued: ReturnType<typeof instance.health>;
    try {
      await started.promise;
      queued = instance.health('second');
      expect(await instance.health('cpu')).toMatchObject({ ok: true });
      expect(events).toEqual(['start first', 'start cpu']);
    } finally {
      release.resolve();
    }
    expect(await active).toMatchObject({ ok: true, output: 'done' });
    expect(await queued).toMatchObject({ ok: true });
    expect(events).toEqual(['start first', 'start cpu', 'stop first', 'start second']);
  });

  it.each([false, true])('retains heavy reservations after disposal fails (warmup failure: %s)', async failWarmup => {
    const stop = vi.fn(async () => { throw new Error('process_cleanup_failed'); });
    const loadAdapter = vi.fn<NonNullable<ModelRuntimeOptions['loadAdapter']>>(model => model.entry.id === 'first' ? {
      ...adapter(), close: stop,
      warmup: () => { if (failWarmup) throw new Error('could not warm worker'); },
    } : adapter());
    const instance = runtime({ registry: [entry('first', { runtime: 'python-worker' }), entry('second', { runtime: 'python-worker' }), entry('cpu')],
      resolve: present, loadAdapter });
    const first = await instance.health('first');
    expect(first.ok).toBe(!failWarmup);
    expect(await instance.health('second')).toMatchObject({ ok: false, reason: 'unhealthy' });
    expect(await instance.health('second')).toMatchObject({ ok: false, reason: 'unhealthy' });
    expect(loadAdapter).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledOnce();
    expect(await instance.health('cpu')).toMatchObject({ ok: true });
  });

  it('defers heavy work when another service controls the worker', async () => {
    let available = false;
    const loadAdapter = vi.fn(() => adapter());
    const instance = runtime({ registry: [entry('heavy', { runtime: 'python-worker' }), entry('cpu')],
      resolve: present, loadAdapter, heavyAvailable: () => available });
    expect(await instance.health('heavy')).toMatchObject({ ok: false, reason: 'busy' });
    expect(loadAdapter).not.toHaveBeenCalled();
    expect(await instance.health('cpu')).toMatchObject({ ok: true });
    available = true;
    expect(await instance.health('heavy')).toMatchObject({ ok: true });
  });

  it('loads and scores the packaged CPU classifiers through the real registry', async () => {
    const registry = modelRegistry.map(model => ({ ...model, resources: { ...model.resources, latencyMs: 500 } }));
    const instance = runtime({ registry });
    expect(await instance.health('scratch-route')).toMatchObject({ ok: true });
    expect(await instance.run('scratch-route', { text: 'What time is it?' })).toMatchObject({ ok: true, output: { abstained: expect.any(Boolean), topK: expect.any(Array) } });
    expect(await instance.health('refusal')).toMatchObject({ ok: true });
    expect(await instance.run('refusal', { text: 'Hello' })).toMatchObject({ ok: true, output: { label: expect.any(String), confidence: expect.any(Number) } });
    expect(await instance.run('refusal', { text: 3 })).toMatchObject({ ok: false, reason: 'invalid-input' });
  });

  it('queues concurrent calls to the checked-in arithmetic ranker in its single CPU worker', async () => {
    const registry = modelRegistry.map(model => ({ ...model, resources: { ...model.resources, latencyMs: 10_000 } }));
    const instance = runtime({ registry });
    const text = 'A workshop has 8 rolls with 14 meters of ribbon per roll. The ribbon is divided equally into 4 display frames. How many meters of ribbon go on each frame?';
    const calls = await Promise.all([instance.run('arithmetic', { text }), instance.run('arithmetic', { text })]);
    expect(calls).toMatchObject([
      { ok: true, output: { value: '28' } },
      { ok: true, output: { value: '28' } },
    ]);
  });

});
