import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSlotShadow, type SlotShadow, type SlotShadowOptions, type SlotShadowWorker } from '../apps/server/src/assistant/slot-shadow.js';

const fixture = path.resolve('tests/fixtures/slot-tagger-v1');
const manifestBytes = readFileSync(path.join(fixture, 'manifest.json'));
const weightsBytes = readFileSync(path.join(fixture, 'weights.bin'));
const modelId = (JSON.parse(manifestBytes.toString('utf8')) as { modelId: string }).modelId;
const model = { modelId, manifestBytes, weightsBytes };
const observers: SlotShadow[] = [];
const track = (options: SlotShadowOptions = {}) => {
  const observer = createSlotShadow(options); observers.push(observer); return observer;
};
class FakeWorker extends EventEmitter implements SlotShadowWorker {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly packets: Array<{ id: number; text: string }> = [];
  terminated = 0;
  unrefed = false;
  postMessage(packet: unknown) { this.packets.push(packet as { id: number; text: string }); }
  async terminate() { this.terminated++; return 0; }
  unref() { this.unrefed = true; }
}
function harness(options: Partial<SlotShadowOptions> = {}) {
  const worker = new FakeWorker();
  let configuration: WorkerOptions | undefined;
  const factory = vi.fn((_source: string, value: WorkerOptions) => { configuration = value; return worker; });
  const observer = track({ enabled: true, model, workerFactory: factory, ...options });
  const ready = () => worker.emit('message', { v: 1, type: 'ready', modelId });
  const result = (overrides: Record<string, unknown> = {}) => worker.emit('message', { v: 1, type: 'result', id: worker.packets.at(-1)!.id, modelId,
    counts: { date: 1, place: 0 }, confidence: { date: [0, 0, 1, 0], place: [0, 0, 0, 0] }, elapsedMs: 0, ...overrides });
  return { worker, observer, factory, ready, result, configuration: () => configuration! };
}
afterEach(() => { for (const observer of observers.splice(0)) observer.close(); vi.useRealTimers(); });

describe('optional lab-only slot shadow', () => {
  it('is disabled by default without reading a model or creating a worker', async () => {
    let reads = 0;
    const options: SlotShadowOptions = { workerFactory: () => { throw new Error('must not allocate'); } };
    Object.defineProperty(options, 'model', { get: () => { reads++; throw new Error('must not read'); } });
    const observer = track(options);
    await observer.observe('Meet in York tomorrow.');
    expect(await observer.ready()).toBe(false);
    expect(reads).toBe(0);
    expect(observer.snapshot()).toMatchObject({ enabled: false, status: 'disabled', modelId: null, counts: { attempted: 0 } });
  });

  it('validates outer bounds before cloning or launching and pins the reviewed model', async () => {
    for (const override of [
      { deadlineMs: 51 }, { deadlineMs: 0 }, { startupTimeoutMs: 5001 }, { maxSamples: 10001 },
      { model: { ...model, modelId: 'invalid' } }, { model: { ...model, manifestBytes: new Uint8Array(256 * 1024 + 1) } },
      { model: { ...model, weightsBytes: new Uint8Array(4 * 1024 * 1024 + 4) } },
    ]) {
      const test = harness(override);
      expect(await test.observer.ready()).toBe(false);
      expect(test.factory).not.toHaveBeenCalled();
      expect(test.observer.snapshot().closedReason).toBe('invalid_config');
    }
    const test = harness(), config = test.configuration();
    expect(config).toMatchObject({ eval: true, execArgv: [], stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, codeRangeSizeMb: 8, stackSizeMb: 4 } });
    expect(config.workerData.modelId).toBe(modelId);
    expect(config.workerData.weights).not.toBe(weightsBytes);
    expect(config.workerData.manifest).not.toBe(manifestBytes);
    expect(test.worker.unrefed).toBe(true);
    expect(test.worker.stdout.listenerCount('data')).toBe(1);
    expect(test.worker.stderr.listenerCount('data')).toBe(1);
  });

  it('drops startup requests and concurrent work without a queue or per-request semantic return', async () => {
    const test = harness();
    expect(await test.observer.observe('Meet tomorrow.')).toBeUndefined();
    expect(test.worker.packets).toHaveLength(0);
    test.ready(); expect(await test.observer.ready()).toBe(true);
    const first = test.observer.observe('Meet in Tallinn next week.');
    expect(await test.observer.observe('Then meet in Riga.')).toBeUndefined();
    expect(test.worker.packets).toHaveLength(1);
    test.result(); expect(await first).toBeUndefined();
    expect(test.observer.snapshot()).toMatchObject({ status: 'ready', counts: { attempted: 3, completed: 1, droppedNotReady: 1, droppedBusy: 1 } });
  });

  it('aggregates only bounded fixed labels, confidence and explicit-host count disagreement', async () => {
    const test = harness(); test.ready();
    const secret = 'For my private plan, meet in Lund on Friday.';
    const pending = test.observer.observe(secret, { provenance: 'trusted_host_explicit', date: 0, place: 1 });
    test.result(); await pending;
    const snapshot = test.observer.snapshot();
    expect(snapshot).toMatchObject({ labels: { date: { spans: 1, confidenceBuckets: [0, 0, 1, 0] }, place: { spans: 0 } },
      disagreement: { compared: 1, dateCount: 1, placeCount: 1, eitherCount: 1 }, latency: { samples: 1 } });
    const serialized = JSON.stringify(snapshot);
    for (const fragment of [secret, 'Lund', 'Friday', 'text', 'spanText', 'query', 'route', 'permission', 'source']) expect(serialized).not.toContain(fragment);
    expect(Object.isFrozen(snapshot.labels.date.confidenceBuckets)).toBe(true);
    expect(Object.isFrozen(snapshot.counts)).toBe(true);
    const next = test.observer.observe('Meet later.', { provenance: 'trusted_host_explicit', date: -1, place: 0 });
    test.result(); await next;
    expect(test.observer.snapshot()).toMatchObject({ counts: { rejectedHostCounts: 1 }, disagreement: { compared: 1 } });
  });

  it('requires strict host counts and never accepts model-provided freeform labels', async () => {
    const test = harness(); test.ready();
    for (const host of [{ date: 1, place: 0 }, { provenance: 'trusted_host_explicit', date: 1.5, place: 0 },
      { provenance: 'trusted_host_explicit', date: 0, place: 81 }, { provenance: 'trusted_host_explicit', date: 0, place: 0, text: 'private' }]) {
      const pending = test.observer.observe('Set a reminder.', host as never); test.result(); await pending;
    }
    expect(test.observer.snapshot()).toMatchObject({ counts: { completed: 4, rejectedHostCounts: 4 }, disagreement: { compared: 0 } });
    const pending = test.observer.observe('Find lunch tomorrow.');
    test.result({ counts: { date: 0, place: 0, address: 'secret' } }); await pending;
    expect(test.observer.snapshot()).toMatchObject({ status: 'closed', closedReason: 'protocol_error', counts: { completed: 4, protocolErrors: 1 } });
  });

  it('checks complete input bounds without posting or truncating invalid text', async () => {
    const test = harness(); test.ready();
    for (const text of ['', ' \u001c\u0085', 'x'.repeat(513), '😀'.repeat(513), '\ud800', '\udfff']) await test.observer.observe(text);
    expect(test.worker.packets).toHaveLength(0);
    expect(test.observer.snapshot().counts.rejectedInput).toBe(6);
    const pending = test.observer.observe('😀' + 'x'.repeat(511)); test.result(); await pending;
    expect(test.worker.packets.at(-1)!.text).toHaveLength(513);
    const punctuation = test.observer.observe('\ufeff'); test.result(); await punctuation;
    expect(test.observer.snapshot().counts.completed).toBe(2);
  });

  it('terminates real CPU isolation on deadline, ignores late results and never auto-restarts', async () => {
    vi.useFakeTimers();
    const test = harness({ deadlineMs: 10 }); test.ready();
    const pending = test.observer.observe('Meet tomorrow.');
    await vi.advanceTimersByTimeAsync(11); await pending;
    expect(test.worker.terminated).toBe(1);
    expect(test.observer.snapshot()).toMatchObject({ status: 'closed', closedReason: 'inference_timeout', counts: { completed: 0, timeouts: 1 } });
    test.result(); await test.observer.observe('Try again.');
    expect(test.factory).toHaveBeenCalledTimes(1);
    expect(test.worker.packets).toHaveLength(1);
    expect(test.observer.snapshot().counts.completed).toBe(0);
  });

  it('bounds startup separately and closes on explicit cancellation or saturation', async () => {
    vi.useFakeTimers();
    const boot = harness({ startupTimeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(21);
    expect(await boot.observer.ready()).toBe(false);
    expect(boot.observer.snapshot().closedReason).toBe('startup_timeout');
    boot.ready(); expect(boot.observer.snapshot().status).toBe('closed');
    const cancel = harness(); cancel.ready();
    const pending = cancel.observer.observe('Cancel this inference.'); cancel.observer.close(); await pending;
    expect(cancel.worker.terminated).toBe(1);
    expect(cancel.observer.snapshot().closedReason).toBe('manual');
    const bounded = harness({ maxSamples: 1 }); bounded.ready();
    const first = bounded.observer.observe('One sample.'); bounded.result(); await first;
    await bounded.observer.observe('Dropped sample.');
    expect(bounded.worker.packets).toHaveLength(1);
    expect(bounded.observer.snapshot()).toMatchObject({ status: 'closed', closedReason: 'saturated', counts: { attempted: 1, completed: 1 } });
  });

  it('fails closed for malformed protocol, duplicate readiness, false model IDs and impossible statistics', async () => {
    const cases: Array<Record<string, unknown>> = [
      { modelId: '0'.repeat(64) }, { counts: { date: 81, place: 0 } }, { confidence: { date: [1, 0, 0, 0], place: [0, 0, 0, 0] }, counts: { date: 0, place: 0 } },
      { elapsedMs: NaN }, { elapsedMs: Infinity }, { elapsedMs: 51 }, { text: 'must never be persisted' }, { id: 999 },
    ];
    for (const value of cases) {
      const test = harness(); test.ready(); const pending = test.observer.observe('A bounded request.'); test.result(value); await pending;
      expect(test.observer.snapshot()).toMatchObject({ status: 'closed', closedReason: 'protocol_error', counts: { completed: 0, protocolErrors: 1 } });
      expect(test.worker.terminated).toBe(1);
    }
    const duplicate = harness(); duplicate.ready(); duplicate.ready(); expect(duplicate.observer.snapshot().closedReason).toBe('protocol_error');
    const unexpected = harness(); unexpected.worker.emit('message', null); expect(unexpected.observer.snapshot().closedReason).toBe('protocol_error');
  });

  it('handles worker errors and input rejection without logging error text or fabricating counts', async () => {
    const test = harness(); test.ready();
    const rejected = test.observer.observe('a '.repeat(81));
    test.worker.emit('message', { v: 1, type: 'rejected', id: test.worker.packets.at(-1)!.id, modelId }); await rejected;
    expect(test.observer.snapshot()).toMatchObject({ status: 'ready', counts: { rejectedInput: 1, completed: 0 } });
    const pending = test.observer.observe('Private secret request.');
    test.worker.emit('error', new Error('Private secret request.')); await pending;
    expect(test.observer.snapshot()).toMatchObject({ status: 'closed', closedReason: 'worker_error', counts: { workerErrors: 1 } });
    expect(JSON.stringify(test.observer.snapshot())).not.toContain('secret');
  });

  it('keeps the host responsive while terminating an actually busy worker', async () => {
    const observer = track({ enabled: true, model, deadlineMs: 20,
      workerFactory: (_source, options) => new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        parentPort.on('message', () => { const until = Date.now() + 1000; while (Date.now() < until) {} });
        parentPort.postMessage({v:1,type:'ready',modelId:workerData.modelId});
      `, options) });
    expect(await observer.ready()).toBe(true);
    let heartbeat = 0;
    const interval = setInterval(() => { heartbeat++; }, 1);
    try {
      await observer.observe('Only a fixed synthetic input.');
      expect(heartbeat).toBeGreaterThan(0);
      expect(observer.snapshot()).toMatchObject({ status: 'closed', closedReason: 'inference_timeout', counts: { completed: 0, timeouts: 1 } });
    } finally { clearInterval(interval); }
  }, 10000);

  it('loads the real own model in a compiled worker and exports only summaries', async () => {
    const base = path.resolve('.data'); mkdirSync(base, { recursive: true });
    const temporary = mkdtempSync(path.join(base, 'slot-shadow-test-'));
    try {
      for (const file of ['slot-tagger-math', 'slot-tagger', 'slot-shadow']) {
        const source = readFileSync(path.resolve(`apps/server/src/assistant/${file}.ts`), 'utf8');
        writeFileSync(path.join(temporary, `${file}.js`), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
      }
      const runner = path.join(temporary, 'runner.js');
      writeFileSync(runner, `
        import { readFileSync } from 'node:fs';
        import { createSlotShadow } from ${JSON.stringify(pathToFileURL(path.join(temporary, 'slot-shadow.js')).href)};
        const directory = process.argv[2];
        const manifestBytes = readFileSync(directory + '/manifest.json');
        const weightsBytes = readFileSync(directory + '/weights.bin');
        const modelId = JSON.parse(manifestBytes).modelId;
        const observer = createSlotShadow({enabled:true,model:{modelId,manifestBytes,weightsBytes},deadlineMs:50});
        const ready = await observer.ready();
        const semanticReturn = await observer.observe('Meet in Oslo next Wednesday.',{provenance:'trusted_host_explicit',date:1,place:1});
        const completed = observer.snapshot();
        await observer.observe('word '.repeat(81));
        const rejected = observer.snapshot(); observer.close();
        process.stdout.write(JSON.stringify({ready,noSemanticReturn:semanticReturn===undefined,completed,rejected,closed:observer.snapshot()}));
      `);
      const learned = path.resolve('artifacts/brain-slot-development-v1/typescript-export-v1-20261121-b');
      const directories = existsSync(path.join(learned, 'manifest.json')) ? [fixture, learned] : [fixture];
      for (const directory of directories) {
        const expectedId = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8')).modelId;
        const { stdout, stderr } = await promisify(execFile)(process.execPath, [runner, directory], { timeout: 10000, maxBuffer: 64 * 1024, windowsHide: true });
        expect(stderr).toBe('');
        const report = JSON.parse(stdout);
        expect(report.ready).toBe(true); expect(report.noSemanticReturn).toBe(true);
        expect(report.completed).toMatchObject({ status: 'ready', modelId: expectedId, counts: { completed: 1 }, disagreement: { compared: 1 } });
        expect(report.rejected.counts.rejectedInput).toBe(1);
        expect(report.closed.closedReason).toBe('manual');
        expect(stdout).not.toContain('Oslo');
      }
    } finally {
      const resolved = realpathSync(temporary);
      if (path.dirname(resolved) !== realpathSync(base) || !path.basename(resolved).startsWith('slot-shadow-test-')) throw new Error('unsafe test cleanup path');
      rmSync(resolved, { recursive: true, force: true });
    }
  }, 15000);
});
