import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { councilRole, createCouncilSchedule } from '../apps/server/src/assistant/council-scheduler.js';
import { getModelEntry, modelRegistry, type ModelEntry, type ResolvedModel } from '../packages/model-relations/src/registry.js';

const entry = (id: string) => getModelEntry(id)!;
const resolved = (model: ModelEntry, present = true): ResolvedModel => ({
  entry: model,
  state: present ? model.state : 'absent',
  artifacts: model.artifacts.map(artifact => ({
    role: artifact.role, path: artifact.path, sha256: artifact.sha256, present, required: !artifact.optional,
  })),
});
const present = async (model: ModelEntry) => resolved(model);
const runner = async (model: ModelEntry) => model.id;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('council scheduler', () => {
  it('assigns registry entries from the training task and delta owner', () => {
    expect(modelRegistry.filter(model => councilRole(model) === undefined)).toEqual([]);

    // Registry at 29448ae, retrieved 2026-11-27:
    // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/packages/model-relations/src/registry.ts
    const examples = [
      ['router-context-history', 'understanding'], ['router-b2', 'understanding'],
      ['reading-v4-hn-last', 'reader'], ['reading-v4-lora', 'reader'], ['reading-abstain-verifier', 'verifier'],
      ['slot-date-place-tagger', 'extractor'], ['slot-tagger', 'extractor'], ['chat-v5', 'generator'],
      ['arithmetic', 'calculator'], ['ocr-v2', 'image-reader'], ['google-ads-pointer', 'ads-tagger'],
      ['ads-v4-last2', 'ads-tagger'], ['execution-c9m', 'code'],
    ];
    for (const [id, role] of examples) expect(councilRole(entry(id!)), id).toBe(role);
  });

  it('records missing artifacts, untrained weights and a present model with no eligible input', async () => {
    const registry = ['reading-v4-hn-last', 'question-edit', 'monitor-context-head', 'ocr-v2'].map(entry);
    const run = vi.fn(runner);
    const schedule = createCouncilSchedule({
      registry,
      resolve: async model => resolved(model, model.id === 'ocr-v2'),
      signal: new AbortController().signal,
      deadline: performance.now() + 1_000,
      weight: () => 0,
    });
    const results = await schedule.run(['understanding', 'reader', 'image-reader'],
      model => model.id === 'ocr-v2' ? 'This turn has no stored image.' : true, run);
    const records = Object.fromEntries(results.map(result => [result.entry.id, result]));
    expect(records['reading-v4-hn-last']).toMatchObject({ status: 'absent', reason: expect.stringContaining('checkpoint') });
    expect(records['question-edit']).toMatchObject({ status: 'untrained', reason: expect.stringContaining('weights') });
    expect(records['monitor-context-head']).toMatchObject({ status: 'untrained', reason: expect.stringContaining('weights') });
    expect(records['ocr-v2']).toMatchObject({ status: 'skipped', reason: 'This turn has no stored image.' });
    expect(run).not.toHaveBeenCalled();
  });

  it('runs present, turn-eligible models in the supplied measured-priority order', async () => {
    const registry = ['reading-v3-last', 'reading-v4-hn-last', 'google-ads-pointer', 'arithmetic'].map(entry);
    const run = vi.fn(runner);
    const receipts = new Map([['reading-v3-last', 1 / 7], ['reading-v4-hn-last', 2 / 3], ['arithmetic', 1]]);
    const schedule = createCouncilSchedule({
      registry,
      resolve: present,
      signal: new AbortController().signal,
      deadline: performance.now() + 1_000,
      weight: model => receipts.get(model.id) ?? 0,
    });
    const results = await schedule.run(['reader', 'calculator'], model => model.id !== 'arithmetic', run);
    expect(run.mock.calls.map(([model]) => model.id)).toEqual(['reading-v4-hn-last', 'reading-v3-last']);
    expect(results.map(result => result.status)).toEqual(['ok', 'ok']);
  });

  it('stops at the round deadline and aborts the running model', async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    const registry = ['reading-v4-hn-last', 'arithmetic'].map(entry);
    const schedule = createCouncilSchedule({
      registry, resolve: present, signal: new AbortController().signal,
      deadline: performance.now() + 1_000,
      weight: (_model, role) => role === 'reader' ? 1 : 0,
    });
    const run = vi.fn(async (_model: ModelEntry, _role: string, signal: AbortSignal) =>
      new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })));
    const result = schedule.run(['reader', 'calculator'], () => true, run, performance.now() + 50);
    await vi.advanceTimersByTimeAsync(51);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[2].aborted).toBe(true);
    expect(await result).toMatchObject([
      { entry: registry[0], status: 'timeout', ms: 50 }, { entry: registry[1], status: 'timeout', ms: 0 },
    ]);
  });

  it('keeps a timed-out Python slot reserved until the model stops and still runs CPU models', async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    const registry = ['reading-v4-hn-last', 'reading-v3-last', 'slot-tagger'].map(entry);
    const schedule = createCouncilSchedule({
      registry, resolve: present, signal: new AbortController().signal, deadline: performance.now() + 1_000,
      weight: model => (registry.length - registry.indexOf(model)) / registry.length,
      capMs: () => 10,
    });
    let stop!: (text: string) => void;
    const pending = new Promise<string>(resolve => { stop = resolve; });
    const run = vi.fn(async (model: ModelEntry) => model === registry[0] ? pending : model.id);
    const result = schedule.run(['reader', 'extractor'], () => true, run);
    await vi.advanceTimersByTimeAsync(11);
    expect(await result).toMatchObject([
      { entry: registry[0], status: 'timeout' },
      { entry: registry[1], status: 'skipped', reason: 'Previous Python model is still stopping.' },
      { entry: registry[2], status: 'ok' },
    ]);
    expect(run.mock.calls.map(([model]) => model.id)).toEqual(['reading-v4-hn-last', 'slot-tagger']);

    stop('done');
    await vi.advanceTimersByTimeAsync(0);
    expect(await schedule.run(['reader'], model => model === registry[1], run))
      .toMatchObject([{ entry: registry[1], status: 'ok' }]);
  });

  it('lets the higher-priority model run when a lower-priority presence probe is slow', async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    const registry = ['router-b2', 'router-b0'].map(entry);
    const schedule = createCouncilSchedule({
      registry,
      resolve: async model => model === registry[0] ? resolved(model) : new Promise<ResolvedModel>(() => {}),
      signal: new AbortController().signal,
      deadline: performance.now() + 100,
      weight: model => Number(model === registry[0]),
    });
    const run = vi.fn(runner);
    const results = schedule.run(['understanding'], () => true, run);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.mock.calls.map(([model]) => model.id)).toEqual(['router-b2']);
    await vi.advanceTimersByTimeAsync(100);
    expect(await results).toMatchObject([{ status: 'ok' }, { status: 'timeout' }]);
  });
});
