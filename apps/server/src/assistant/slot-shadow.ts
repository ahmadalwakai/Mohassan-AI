import { Worker, type WorkerOptions } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';

/** Optional LAB observer. Nothing returned here is a routing or action decision. */
export const SLOT_SHADOW_VERSION = 1;
const MAX_CP = 512, MAX_TOKENS = 80, MAX_WEIGHTS = 4 * 1024 * 1024, MAX_MANIFEST = 256 * 1024;
const LATENCY_LIMITS = [1, 2, 5, 10, 25, 50] as const;
const HASH = /^[a-f0-9]{64}$/u;

export interface TrustedExplicitSlotCounts {
  readonly provenance: 'trusted_host_explicit';
  readonly date: number;
  readonly place: number;
}
/** Trusted dependency seam; the default implementation owns a real isolated Worker. */
export interface SlotShadowWorker {
  on(event: 'message' | 'error' | 'exit', listener: (value: unknown) => void): unknown;
  postMessage(message: unknown): void;
  terminate(): Promise<unknown>;
  unref(): void;
  readonly stdout?: { on(event: 'data', listener: () => void): unknown } | null;
  readonly stderr?: { on(event: 'data', listener: () => void): unknown } | null;
}
export interface SlotShadowOptions {
  readonly enabled?: boolean;
  readonly model?: { readonly modelId: string; readonly manifestBytes: Uint8Array; readonly weightsBytes: Uint8Array };
  readonly deadlineMs?: number;
  readonly startupTimeoutMs?: number;
  readonly maxSamples?: number;
  readonly workerFactory?: (source: string, options: WorkerOptions) => SlotShadowWorker;
}
type Status = 'disabled' | 'starting' | 'ready' | 'busy' | 'closed';
type CloseReason = 'manual' | 'invalid_config' | 'startup_timeout' | 'inference_timeout' | 'worker_error' | 'protocol_error' | 'saturated' | null;
export interface SlotShadowSnapshot {
  readonly version: 1;
  readonly enabled: boolean;
  readonly status: Status;
  readonly closedReason: CloseReason;
  readonly modelId: string | null;
  readonly counts: Readonly<Record<'attempted' | 'completed' | 'droppedBusy' | 'droppedNotReady' | 'rejectedInput' | 'rejectedHostCounts' | 'timeouts' | 'workerErrors' | 'protocolErrors', number>>;
  readonly labels: Readonly<Record<'date' | 'place', { readonly spans: number; readonly confidenceBuckets: readonly number[] }>>;
  readonly latency: { readonly samples: number; readonly sumMs: number; readonly maxMs: number; readonly histogram: readonly number[] };
  readonly disagreement: { readonly compared: number; readonly dateCount: number; readonly placeCount: number; readonly eitherCount: number };
}
export interface SlotShadow {
  ready(): Promise<boolean>;
  /** Resolves without returning any per-request semantic information. */
  observe(currentUserText: string, trustedExplicitCounts?: TrustedExplicitSlotCounts): Promise<void>;
  snapshot(): SlotShadowSnapshot;
  /** Terminates the worker, cancels in-flight work and permanently closes this instance. */
  close(): void;
}

// Constant bootstrap: no user code, request text or model source text is interpolated.
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const sameKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).sort().join('|') === keys.slice().sort().join('|');
(async () => {
  try {
    const { loadSlotTagger } = await import(workerData.loaderUrl);
    const tagger = loadSlotTagger(workerData.manifest, workerData.weights, { expectedModelId: workerData.modelId, cacheEmbeddings: false });
    parentPort.on('message', packet => {
      if (!sameKeys(packet, ['v', 'type', 'id', 'text']) || packet.v !== 1 || packet.type !== 'observe' || !Number.isInteger(packet.id) || packet.id < 1 || packet.id > 10000 || typeof packet.text !== 'string' || packet.text.length > 1024) {
        parentPort.postMessage({ v: 1, type: 'failed', modelId: tagger.modelId }); return;
      }
      const start = performance.now();
      try {
        const result = tagger.infer(packet.text);
        const counts = { date: 0, place: 0 }, confidence = { date: [0, 0, 0, 0], place: [0, 0, 0, 0] };
        for (const span of result.hypotheses) {
          if ((span.label !== 'date' && span.label !== 'place') || !Number.isFinite(span.confidence) || span.confidence < 0 || span.confidence > 1) throw new Error('invalid');
          counts[span.label]++;
          confidence[span.label][span.confidence < .8 ? 0 : span.confidence < .9 ? 1 : span.confidence < .95 ? 2 : 3]++;
        }
        parentPort.postMessage({ v: 1, type: 'result', id: packet.id, modelId: tagger.modelId, counts, confidence, elapsedMs: performance.now() - start });
      } catch {
        parentPort.postMessage({ v: 1, type: 'rejected', id: packet.id, modelId: tagger.modelId });
      }
    });
    parentPort.postMessage({ v: 1, type: 'ready', modelId: tagger.modelId });
  } catch {
    parentPort.postMessage({ v: 1, type: 'failed', modelId: workerData.modelId });
  }
})();
`;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join('|') === [...expected].sort().join('|');
}
function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}
function validInput(text: unknown): text is string {
  if (typeof text !== 'string' || !text || text.length > MAX_CP * 2) return false;
  let count = 0, nonSpace = false;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (++count > MAX_CP || cp >= 0xd800 && cp <= 0xdfff) return false;
    // Full Unicode-14 validity, token count and exact whitespace are checked by the worker loader.
    nonSpace ||= !/[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028-\u2029\u202f\u205f\u3000]/u.test(char);
  }
  return nonSpace;
}
function explicitCounts(value: unknown): { date: number; place: number } | undefined {
  if (!record(value) || !keys(value, ['provenance', 'date', 'place']) || value.provenance !== 'trusted_host_explicit'
    || !integer(value.date, 0, MAX_TOKENS) || !integer(value.place, 0, MAX_TOKENS)) return undefined;
  return { date: value.date, place: value.place };
}
function summary(value: Record<string, unknown>): value is Record<string, unknown> & {
  counts: { date: number; place: number }; confidence: { date: number[]; place: number[] }; elapsedMs: number;
} {
  if (!record(value.counts) || !keys(value.counts, ['date', 'place']) || !record(value.confidence) || !keys(value.confidence, ['date', 'place'])
    || typeof value.elapsedMs !== 'number' || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > 1000) return false;
  let total = 0;
  for (const label of ['date', 'place'] as const) {
    const count = value.counts[label], buckets = value.confidence[label];
    if (!integer(count, 0, MAX_TOKENS) || !Array.isArray(buckets) || buckets.length !== 4 || Object.getPrototypeOf(buckets) !== Array.prototype
      || Object.keys(buckets).sort().join('|') !== '0|1|2|3'
      || buckets.some(bucket => !integer(bucket, 0, MAX_TOKENS)) || buckets.reduce((sum, bucket) => sum + bucket, 0) !== count) return false;
    total += count;
  }
  return total <= MAX_TOKENS;
}

/** Disabled by default. Enabled instances allocate one worker and never queue requests. */
export function createSlotShadow(options: SlotShadowOptions = {}): SlotShadow {
  const enabled = options.enabled === true;
  const deadline = options.deadlineMs ?? 50, startup = options.startupTimeoutMs ?? 5000, maximum = options.maxSamples ?? 10000;
  const model = enabled ? options.model : undefined;
  const modelId = enabled && typeof model?.modelId === 'string' && HASH.test(model.modelId) ? model.modelId : null;
  let status: Status = enabled ? 'starting' : 'disabled', closedReason: CloseReason = null;
  const counts = { attempted: 0, completed: 0, droppedBusy: 0, droppedNotReady: 0, rejectedInput: 0, rejectedHostCounts: 0, timeouts: 0, workerErrors: 0, protocolErrors: 0 };
  const labels = { date: { spans: 0, confidenceBuckets: [0, 0, 0, 0] }, place: { spans: 0, confidenceBuckets: [0, 0, 0, 0] } };
  const latency = { samples: 0, sumMs: 0, maxMs: 0, histogram: [0, 0, 0, 0, 0, 0, 0] };
  const disagreement = { compared: 0, dateCount: 0, placeCount: 0, eitherCount: 0 };
  let worker: SlotShadowWorker | undefined, startupTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: { id: number; start: number; timer: ReturnType<typeof setTimeout>; resolve: () => void; host?: { date: number; place: number } } | undefined;
  let resolveReady: (value: boolean) => void = () => {};
  const readiness = new Promise<boolean>(resolve => { resolveReady = resolve; });
  const bootStart = performance.now();

  function finishPending() {
    if (!pending) return;
    clearTimeout(pending.timer);
    const resolve = pending.resolve;
    pending = undefined;
    resolve();
  }
  function close(reason: CloseReason) {
    if (status === 'closed' || status === 'disabled') { resolveReady(false); return; }
    status = 'closed'; closedReason = reason;
    clearTimeout(startupTimer); startupTimer = undefined;
    resolveReady(false); finishPending();
    if (worker) { try { void worker.terminate().catch(() => {}); } catch { /* No exception or text leaves the observer. */ } }
  }
  function protocolError() { counts.protocolErrors++; close('protocol_error'); }
  function onMessage(value: unknown) {
    if (status === 'closed' || status === 'disabled') return;
    if (!record(value) || value.v !== 1 || value.modelId !== modelId) { protocolError(); return; }
    if (value.type === 'ready') {
      if (!keys(value, ['v', 'type', 'modelId']) || status !== 'starting') { protocolError(); return; }
      if (performance.now() - bootStart > startup) { counts.timeouts++; close('startup_timeout'); return; }
      clearTimeout(startupTimer); startupTimer = undefined;
      status = 'ready'; resolveReady(true); return;
    }
    if (value.type === 'failed') {
      if (!keys(value, ['v', 'type', 'modelId'])) { protocolError(); return; }
      counts.workerErrors++; close('worker_error'); return;
    }
    if (!pending || status !== 'busy' || value.id !== pending.id) { protocolError(); return; }
    const wallMs = performance.now() - pending.start;
    if (wallMs > deadline) { counts.timeouts++; close('inference_timeout'); return; }
    if (value.type === 'rejected') {
      if (!keys(value, ['v', 'type', 'id', 'modelId'])) { protocolError(); return; }
      counts.rejectedInput++; status = 'ready'; finishPending(); return;
    }
    if (value.type !== 'result' || !keys(value, ['v', 'type', 'id', 'modelId', 'counts', 'confidence', 'elapsedMs']) || !summary(value)
      || value.elapsedMs > wallMs + 1 || value.elapsedMs > deadline) { protocolError(); return; }
    counts.completed++;
    for (const label of ['date', 'place'] as const) {
      labels[label].spans += value.counts[label];
      for (let bucket = 0; bucket < 4; bucket++) labels[label].confidenceBuckets[bucket] += value.confidence[label][bucket];
    }
    latency.samples++; latency.sumMs += wallMs; latency.maxMs = Math.max(latency.maxMs, wallMs);
    const bucket = LATENCY_LIMITS.findIndex(limit => wallMs < limit);
    latency.histogram[bucket < 0 ? LATENCY_LIMITS.length : bucket]++;
    if (pending.host) {
      const date = pending.host.date !== value.counts.date, place = pending.host.place !== value.counts.place;
      disagreement.compared++; disagreement.dateCount += Number(date); disagreement.placeCount += Number(place); disagreement.eitherCount += Number(date || place);
    }
    status = 'ready'; finishPending();
  }

  if (!enabled) resolveReady(false);
  else if (!modelId || !model || !integer(deadline, 1, 50) || !integer(startup, 1, 5000) || !integer(maximum, 1, 10000)
    || !(model.manifestBytes instanceof Uint8Array) || model.manifestBytes.length < 1 || model.manifestBytes.length > MAX_MANIFEST
    || !(model.weightsBytes instanceof Uint8Array) || model.weightsBytes.length < 4 || model.weightsBytes.length > MAX_WEIGHTS || model.weightsBytes.length % 4 !== 0) close('invalid_config');
  else {
    // Copy only after explicit enablement and all outer bounds pass; transfer owned copies once.
    const manifest = Uint8Array.from(model.manifestBytes), weights = Uint8Array.from(model.weightsBytes);
    startupTimer = setTimeout(() => { counts.timeouts++; close('startup_timeout'); }, startup);
    try {
      const factory = options.workerFactory ?? ((source: string, config: WorkerOptions) => new Worker(source, config));
      worker = factory(WORKER_SOURCE, { eval: true, execArgv: [], name: 'slot-shadow-lab', stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, codeRangeSizeMb: 8, stackSizeMb: 4 },
        workerData: { loaderUrl: new URL('./slot-tagger.js', import.meta.url).href, modelId, manifest, weights }, transferList: [manifest.buffer, weights.buffer] });
      worker.stdout?.on('data', () => {}); worker.stderr?.on('data', () => {});
      worker.on('message', onMessage);
      worker.on('error', () => { if (status !== 'closed') { counts.workerErrors++; close('worker_error'); } });
      worker.on('exit', () => { if (status !== 'closed') { counts.workerErrors++; close('worker_error'); } });
      worker.unref();
    } catch { counts.workerErrors++; close('worker_error'); }
  }

  return Object.freeze({
    ready: () => status === 'closed' || status === 'disabled' ? Promise.resolve(false) : readiness,
    observe: (text: string, host?: TrustedExplicitSlotCounts): Promise<void> => {
      if (status === 'closed' || status === 'disabled') return Promise.resolve();
      if (counts.attempted >= maximum) { close('saturated'); return Promise.resolve(); }
      counts.attempted++;
      if (!validInput(text)) { counts.rejectedInput++; return Promise.resolve(); }
      if (status === 'starting') { counts.droppedNotReady++; return Promise.resolve(); }
      if (status === 'busy') { counts.droppedBusy++; return Promise.resolve(); }
      const trusted = explicitCounts(host);
      if (host !== undefined && !trusted) counts.rejectedHostCounts++;
      const start = performance.now(), id = counts.attempted;
      status = 'busy';
      return new Promise<void>(resolve => {
        const timer = setTimeout(() => { counts.timeouts++; close('inference_timeout'); }, deadline);
        pending = { id, start, timer, resolve, host: trusted };
        try { worker!.postMessage({ v: 1, type: 'observe', id, text }); }
        catch { counts.workerErrors++; close('worker_error'); }
      });
    },
    snapshot: (): SlotShadowSnapshot => Object.freeze({ version: 1, enabled, status, closedReason, modelId,
      counts: Object.freeze({ ...counts }),
      labels: Object.freeze({ date: Object.freeze({ spans: labels.date.spans, confidenceBuckets: Object.freeze([...labels.date.confidenceBuckets]) }),
        place: Object.freeze({ spans: labels.place.spans, confidenceBuckets: Object.freeze([...labels.place.confidenceBuckets]) }) }),
      latency: Object.freeze({ ...latency, histogram: Object.freeze([...latency.histogram]) }), disagreement: Object.freeze({ ...disagreement }) }),
    close: () => close('manual'),
  });
}
