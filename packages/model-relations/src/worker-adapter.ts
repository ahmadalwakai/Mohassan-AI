import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { PermanentModelWorker, type PermanentModelWorkerStatus } from '../../execution-integration/src/permanent-worker.js';
import type { ModelWorkerOperation, ModelWorkerResult } from '../../execution-integration/src/permanent-worker-protocol.js';
import { ModelTransportError, type TransportJson } from '../../execution-integration/src/transport.js';
import { inputAs, modelArtifact, requiredArtifact } from './adapters.js';
import type { ResolvedModel } from './registry.js';
import { ModelRuntimeError, type ModelAdapter, type ModelAdapterContext } from './runtime.js';

const record = z.record(z.string(), z.unknown());
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const pin = z.object({ path: z.string().min(1), sha256: sha });
const identity = z.object({ modelId: z.string(), tokenizerId: z.string(), checkpointId: z.string() }).strict();
const calibration = z.object({ temperature: z.number().positive(), minConfidence: z.number().min(0).max(1), minMargin: z.number().min(0).max(1) });
const trainingManifest = z.object({
  schema_version: z.literal(1),
  trunk: z.object({ checkpoint: pin, tokenizer: pin, tokenizer_report: pin.nullish() }),
  worker: pin,
  inference: z.object({
    head: z.string(), operation: z.enum(['classify', 'select']), labels: z.array(z.string()).nullable(),
    max_tokens: z.number().int().min(8).max(8_192), eos_token_id: z.number().int().nonnegative(), calibration: calibration.nullable(),
  }),
});
const sidecarManifest = z.object({
  trunk_sha256: sha, source_trunk_sha256: sha.optional(), weights_sha256: sha, kind: z.enum(['classify', 'pointer']),
});
const workerConfig = z.object({ identity, model: record, limits: record.optional() }).strict();
type WorkerConfig = z.infer<typeof workerConfig>;
type HeadManifest = z.infer<typeof trainingManifest>;
type DenseContext = { training: HeadManifest; tokenizer: { path: string; sha256: string }; report?: { path: string; sha256: string } };

const tokenIds = z.array(z.number().int().nonnegative()).min(1).max(8_192);
const candidateIds = z.array(z.number().int().nonnegative()).min(1).max(256);
const genText = z.string().min(1).max(32_000);
const genSettings = z.object({ maxNewTokens: z.number().int().min(1).max(8_192), temperature: z.number().optional(), topK: z.number().int().optional(), topP: z.number().optional(), seed: z.number().int().optional() });
const generateInput = z.union([genSettings.extend({ text: genText }).strict(), genSettings.extend({ inputIds: tokenIds }).strict(),
  // Raw continuation without chat framing, for the reading fine-tunes (packages/execution-integration/model_worker/engine.py).
  genSettings.extend({ prompt: genText }).strict()]);
/** The Ads and code foundation family shares the pointer run's tokenizer, which the worker cannot frame: encode-input.py does. */
const adsFamily = new Set(['google-ads-pointer-lm', 'ads-code-foundation', 'ads-bilingual-code-v1', 'ads-bilingual-code-v2']);
const selectInput = z.object({ inputIds: tokenIds, candidatePositions: candidateIds }).strict();
const classifyInput = z.object({ inputIds: tokenIds }).strict();
const denseInput = z.object({ text: z.string().min(1).max(8_000), history: z.array(z.string().max(8_000)).max(16).optional(), candidates: z.array(z.string().min(1).max(8_000)).max(32).optional() }).strict();
const scoreOptionsInput = z.object({ operation: z.literal('score-options'), head: z.string().max(64).optional(), options: z.array(z.array(z.number().int().nonnegative()).min(1).max(16)).min(2).max(16), text: genText.optional(), inputIds: tokenIds.optional() }).strict().refine(value => (value.text === undefined) !== (value.inputIds === undefined));
const encodedResult = z.object({ inputIds: tokenIds, candidatePositions: candidateIds.optional(), candidateIndices: candidateIds.optional() }).strict();
const finiteScores = z.array(z.number().finite()).min(1).max(256);

async function readJson(path: string): Promise<unknown> {
  const info = await stat(path);
  if (!info.isFile() || info.size < 1 || info.size > 8 * 1024 * 1024) throw new ModelRuntimeError('unhealthy', 'Invalid worker metadata size');
  return JSON.parse(await readFile(path, 'utf8'));
}

function configuredPath(parent: string, path: unknown): string {
  if (typeof path !== 'string' || !path || path.includes('\0') || /^[\\/]{2}/u.test(path) || path.includes('://') || path.split(/[\\/]/u).includes('..')) {
    throw new ModelRuntimeError('unhealthy', 'Invalid local worker path');
  }
  return resolve(parent, path);
}

async function fileHash(path: string): Promise<string> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new ModelRuntimeError('absent', 'Configured worker artifact is absent');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

function existingConfig(config: WorkerConfig, base: string): WorkerConfig {
  const { model } = config;
  const checkpoint = record.parse(model.checkpoint);
  checkpoint.path = configuredPath(base, checkpoint.path);
  model.checkpoint = checkpoint;
  if (model.tokenizer !== undefined) {
    const tokenizer = record.parse(model.tokenizer);
    tokenizer.path = configuredPath(base, tokenizer.path);
    if (tokenizer.reportPath !== undefined) tokenizer.reportPath = configuredPath(base, tokenizer.reportPath);
    model.tokenizer = tokenizer;
  }
  if (model.heads !== undefined) {
    const heads = record.parse(model.heads);
    for (const [name, value] of Object.entries(heads)) {
      const head = record.parse(value);
      if (head.sidecar !== undefined) {
        const sidecar = record.parse(head.sidecar);
        sidecar.path = configuredPath(base, sidecar.path);
        head.sidecar = sidecar;
      }
      heads[name] = head;
    }
    model.heads = heads;
  }
  return config;
}

function freshConfig(id: string, tokenizerId: string, digest: string, model: Record<string, unknown>): WorkerConfig {
  return { identity: { modelId: id, tokenizerId: `sha256:${tokenizerId}`, checkpointId: `sha256:${digest}` }, model };
}

async function workerConfiguration(model: ResolvedModel, context: ModelAdapterContext): Promise<WorkerConfig> {
  const configured = modelArtifact(model, 'worker-config');
  if (configured) {
    const config = existingConfig(workerConfig.parse(await readJson(configured.path)), dirname(configured.path));
    if (model.entry.id !== 'chat-v5') return config;
    const checkpoint = record.parse(config.model.checkpoint);
    // Older checkouts could point the v5 setting at a GoalTagger config. Fall back to v5's native files for those setups.
    if (checkpoint.format !== 'goal-tagger') {
      const registered = requiredArtifact(model, 'checkpoint');
      if (checkpoint.sha256 !== registered.sha256 || (checkpoint.format && checkpoint.format !== 'training')) {
        throw new ModelRuntimeError('incompatible', 'The worker configuration does not identify the registered v5 trunk');
      }
      config.model.checkpoint = { ...checkpoint, path: registered.path };
      if (config.model.tokenizer !== undefined) {
        const tokenizer = record.parse(config.model.tokenizer);
        const native = requiredArtifact(model, 'tokenizer');
        const report = modelArtifact(model, 'tokenizer-report');
        if (tokenizer.sha256 !== native.sha256 || (tokenizer.reportSha256 && tokenizer.reportSha256 !== report?.sha256)) {
          throw new ModelRuntimeError('incompatible', 'The worker tokenizer differs from the registered v5 tokenizer');
        }
        config.model.tokenizer = { ...tokenizer, path: native.path, ...(tokenizer.reportPath && report ? { reportPath: report.path } : {}) };
      }
      return config;
    }
  }
  if (model.entry.id === 'execution' || model.entry.id.startsWith('execution-')) {
    const manifestEntry = requiredArtifact(model, 'manifest');
    const weights = requiredArtifact(model, 'weights');
    const manifest = z.object({ tokenizer_identity: sha, weights_sha256: sha }).parse(await readJson(manifestEntry.path));
    const digest = manifest.weights_sha256;
    if (weights.sha256 !== digest) throw new ModelRuntimeError('incompatible', 'Execution weights do not match the export manifest');
    return freshConfig(model.entry.id, manifest.tokenizer_identity, digest, {
      checkpoint: { path: dirname(manifestEntry.path), format: 'inference', sha256: digest, manifestSha256: manifestEntry.sha256, tokenizerId: manifest.tokenizer_identity },
      device: context.env.EXECUTOR_DEVICE === 'cuda' ? 'cuda' : 'cpu',
    });
  }
  const checkpoint = requiredArtifact(model, 'checkpoint');
  const tokenizer = requiredArtifact(model, 'tokenizer');
  const tokenizerReport = modelArtifact(model, 'tokenizer-report');
  const digest = sha.parse(checkpoint.sha256);
  const metadata = modelArtifact(model, 'settings');
  const tokenizerReference = metadata
    ? z.object({ tokenizer_identity: sha, tokenizer_sha256: sha.optional(), tokenizer_report_sha256: sha.optional() }).parse(await readJson(metadata.path))
    : undefined;
  const report = tokenizerReport ? z.object({ identity: sha }).parse(await readJson(tokenizerReport.path)) : undefined;
  const tokenizerId = tokenizerReference?.tokenizer_identity ?? report?.identity;
  if (!tokenizerId) throw new ModelRuntimeError('absent', 'A tokenizer identity or tokenizer report is required');
  if (tokenizerReference?.tokenizer_sha256 && tokenizer.sha256 !== tokenizerReference.tokenizer_sha256
    || tokenizerReference?.tokenizer_report_sha256 && tokenizerReport?.sha256 !== tokenizerReference.tokenizer_report_sha256) {
    throw new ModelRuntimeError('incompatible', 'Tokenizer bytes differ from model settings');
  }
  return freshConfig(model.entry.id, tokenizerId, digest, {
    checkpoint: { path: checkpoint.path, sha256: digest, format: 'training' },
    tokenizer: { path: tokenizer.path, sha256: tokenizer.sha256, ...(tokenizerReport ? { reportPath: tokenizerReport.path, reportSha256: tokenizerReport.sha256 } : {}) },
    ...(model.entry.id === 'chat-v5' ? { heads: { lm: { kind: 'generate' }, options: { kind: 'score-options' } } } : {}),
    device: model.entry.id === 'google-ads-pointer-lm' && context.env.ADS_MODEL_DEVICE === 'cuda' ? 'cuda' : 'cpu',
  });
}

async function checkDenseHead(model: ResolvedModel, context: ModelAdapterContext, config: WorkerConfig): Promise<DenseContext> {
  const sidecarFile = requiredArtifact(model, 'head-manifest');
  const sidecar = sidecarManifest.parse(await readJson(sidecarFile.path));
  const trained = trainingManifest.parse(await readJson(requiredArtifact(model, 'training-manifest').path));
  const anyTrunk = context.dependencies.find(dependency => dependency.entry.id === 'chat-v5');
  const registryTrunk = anyTrunk && modelArtifact(anyTrunk, 'checkpoint');
  if (!registryTrunk) throw new ModelRuntimeError('absent', 'The registered v5 trunk checkpoint is absent');
  const checkpoint = pin.parse(config.model.checkpoint);
  const worker = requiredArtifact(model, 'worker-config');
  const source = sidecar.source_trunk_sha256 ?? sidecar.trunk_sha256;
  if (checkpoint.sha256 !== sidecar.trunk_sha256 || trained.trunk.checkpoint.sha256 !== source
    || (registryTrunk.expectedSha256 && source !== registryTrunk.expectedSha256)) {
    throw new ModelRuntimeError('incompatible', 'The head is bound to a different v5 trunk checkpoint or worker configuration');
  }
  if (worker.sha256 !== trained.worker.sha256 || source !== await fileHash(registryTrunk.path)) {
    throw new ModelRuntimeError('incompatible', 'The head worker configuration or v5 trunk bytes differ from the training pin', 'pin-mismatch');
  }
  if (model.entry.workerHead && trained.inference.head !== model.entry.workerHead) {
    throw new ModelRuntimeError('incompatible', 'The head manifest does not identify the registered head');
  }
  const heads = record.parse(config.model.heads);
  const head = z.object({ kind: z.enum(['classify', 'pointer']), sidecar: pin.extend({ manifestSha256: sha }) }).parse(heads[trained.inference.head]);
  if (head.kind !== sidecar.kind || head.kind !== (trained.inference.operation === 'classify' ? 'classify' : 'pointer')
    || head.sidecar.sha256 !== sidecar.weights_sha256) {
    throw new ModelRuntimeError('incompatible', 'The head metadata and sidecar do not match');
  }
  if (head.sidecar.sha256 !== requiredArtifact(model, 'weights').sha256 || head.sidecar.manifestSha256 !== sidecarFile.sha256) {
    throw new ModelRuntimeError('incompatible', 'The head weights or sidecar manifest bytes differ from the sidecar pin', 'pin-mismatch');
  }
  const adaptedPath = join(dirname(sidecarFile.path), 'adapted-trunk.pt');
  const checkpointPath = sidecar.source_trunk_sha256 ? adaptedPath : registryTrunk.path;
  if (checkpointPath === adaptedPath && await fileHash(adaptedPath) !== checkpoint.sha256) {
    throw new ModelRuntimeError('incompatible', 'The adapted trunk bytes differ from the head pin', 'pin-mismatch');
  }
  // Preserve the original manifest and worker digest. The temporary worker file refers to
  // the verified local copy of each artifact, including exports transferred from Windows.
  config.model.checkpoint = { ...record.parse(config.model.checkpoint), path: checkpointPath };
  config.model.heads = { [trained.inference.head]: { ...head, sidecar: { ...head.sidecar, path: dirname(sidecarFile.path) } } };
  const tokenizer = modelArtifact(anyTrunk!, 'tokenizer');
  const report = modelArtifact(anyTrunk!, 'tokenizer-report');
  if (!tokenizer || (trained.trunk.tokenizer_report && !report)) throw new ModelRuntimeError('absent', 'The trained head tokenizer is absent');
  if (await fileHash(tokenizer.path) !== trained.trunk.tokenizer.sha256
    || (report && trained.trunk.tokenizer_report && await fileHash(report.path) !== trained.trunk.tokenizer_report.sha256)) {
    throw new ModelRuntimeError('incompatible', 'The tokenizer differs from the head training pin', 'pin-mismatch');
  }
  return { training: trained, tokenizer: { path: tokenizer.path, sha256: trained.trunk.tokenizer.sha256 },
    ...(trained.trunk.tokenizer_report && report ? { report: { path: report.path, sha256: trained.trunk.tokenizer_report.sha256 } } : {}) };
}

function workerEnvironment(executable: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const system = process.platform === 'win32' ? env.SystemRoot : undefined;
  return system ? { SystemRoot: system, PATH: [dirname(executable), join(system, 'System32'), system].join(delimiter) } : {};
}

function encode(executable: string, env: Record<string, string>, context: ModelAdapterContext, signal: AbortSignal, mode: 'head' | 'ads-encode' | 'ads-decode', payload: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ['-I', '-B', join(context.root, 'packages', 'model-relations', 'src', 'encode-input.py'), mode],
      { cwd: context.root, env, signal, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout) => {
        if (error) reject(new ModelRuntimeError(error.code === 2 ? 'invalid-input' : 'unhealthy'));
        else {
          try { resolve(JSON.parse(stdout)); } catch { reject(new ModelRuntimeError('unhealthy')); }
        }
      });
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(payload));
  });
}

function decide(scores: readonly number[], gate: z.infer<typeof calibration> | null) {
  if (scores.length < 2 || !gate) return { index: null, confidence: 0 };
  const best = Math.max(...scores);
  const winner = scores.indexOf(best);
  const weights = scores.map(value => Math.exp((value - best) / gate.temperature));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const runnerUp = Math.max(...weights.filter((_, index) => index !== winner));
  const confidence = 1 / total;
  const margin = (1 - runnerUp) / total;
  return { index: margin > 0 && margin >= gate.minMargin && confidence >= gate.minConfidence ? winner : null, confidence };
}

function transportFailure(error: unknown): never {
  if (error instanceof ModelTransportError) {
    const reason = { invalid_request: 'invalid-input', unsupported_capability: 'unsupported', timeout: 'timeout', resource_exhaustion: 'busy' } as const;
    if (Object.hasOwn(reason, error.code)) throw new ModelRuntimeError(reason[error.code as keyof typeof reason]);
  }
  throw error;
}

export async function loadWorkerAdapter(model: ResolvedModel, context: ModelAdapterContext): Promise<ModelAdapter> {
  const config = await workerConfiguration(model, context);
  const checkpoint = pin.parse(config.model.checkpoint);
  const wantsCuda = config.model.device === 'cuda';
  if (wantsCuda) await context.assertGpuFree();
  const heavyMemoryBytes = Math.min(4_096, model.entry.resources.memoryMb, context.memoryBudgetMiB) * 1024 * 1024;
  const configuredMemoryBytes = config.limits?.memoryBytes;
  config.limits = { ...config.limits,
    memoryBytes: typeof configuredMemoryBytes === 'number' ? Math.min(configuredMemoryBytes, heavyMemoryBytes) : heavyMemoryBytes,
    cpuThreads: Math.min(Number(config.limits?.cpuThreads ?? 1), model.entry.resources.cpu),
  };
  const hasHead = model.entry.dependencies.some(dependency => dependency.id === 'chat-v5');
  const dense = hasHead ? await checkDenseHead(model, context, config) : undefined;
  const isAds = adsFamily.has(model.entry.id);
  const goalTagger = record.parse(config.model.checkpoint).format === 'goal-tagger';
  const head = dense?.training.inference.head ?? (goalTagger ? 'goal-tagger' : 'lm');
  const operation: ModelWorkerOperation = dense?.training.inference.operation ?? (goalTagger ? 'select' : 'generate');
  if (config.identity.checkpointId !== `sha256:${checkpoint.sha256}`) throw new ModelRuntimeError('incompatible', 'Worker checkpoint identity does not match its pin');
  const executable = resolve(context.root, context.env.EXECUTOR_PYTHON?.trim() || (process.platform === 'win32' ? '.venv-execution/Scripts/python.exe' : '.venv-execution/bin/python'));
  await access(executable).catch(() => { throw new ModelRuntimeError('unhealthy', 'The local Python runtime is unavailable'); });
  context.signal.throwIfAborted();
  const env = workerEnvironment(executable, context.env);
  const temporary = await mkdtemp(join(tmpdir(), 'mohassan-model-runtime-'));
  const configPath = join(temporary, 'worker.json');
  const configBytes = JSON.stringify(config);
  const configDigest = createHash('sha256').update(configBytes).digest('hex');
  let worker: PermanentModelWorker;
  let stateObserver: ((status: PermanentModelWorkerStatus) => void) | undefined;
  try {
    await writeFile(configPath, configBytes, { mode: 0o600 });
    worker = new PermanentModelWorker({
      executable, args: ['-I', '-B', join(context.root, 'packages', 'execution-integration', 'model_worker', 'worker.py'), configPath, String(process.pid)],
      cwd: context.root, environment: env, identity: config.identity, startupTimeoutMs: context.startupMs,
      onState: status => stateObserver?.(status),
    });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  const expectedHead = operation === 'select' ? 'pointer' : operation;
  const ready = () => worker.status.state === 'ready' && worker.status.ready.configSha256 === configDigest
    && worker.status.ready.heads[head] === expectedHead && worker.status.ready.device === (wantsCuda ? 'cuda' : 'cpu');
  const request = async (op: ModelWorkerOperation, name: string, input: Readonly<Record<string, TransportJson>>, signal: AbortSignal, timeoutMs: number): Promise<ModelWorkerResult> => {
    const budget = worker.status.state === 'ready' ? Math.min(timeoutMs, worker.status.ready.limits.maxTimeoutMs) : timeoutMs;
    return worker.request({ operation: op, head: name, input, signal, timeoutMs: budget }).catch(transportFailure);
  };
  return {
    warmup: async signal => {
      if (wantsCuda) await context.assertGpuFree();
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const clear = () => { stateObserver = undefined; signal.removeEventListener('abort', abort); };
        const abort = () => { clear(); reject(new ModelRuntimeError('timeout')); };
        signal.addEventListener('abort', abort, { once: true });
        stateObserver = status => {
          if (status.state === 'ready') {
            clear();
            if (ready()) resolve();
            else reject(new ModelRuntimeError('incompatible', 'Worker readiness does not match this model configuration'));
          } else if (status.state === 'degraded') {
            clear();
            const pinMismatch = status.code === 'checkpoint_pin_mismatch';
            const reason = status.code === 'gpu_locked' ? 'gpu-locked'
              : pinMismatch ? 'incompatible'
                : status.code === 'timeout' ? 'timeout' : 'unhealthy';
            reject(new ModelRuntimeError(reason, status.code, pinMismatch ? 'pin-mismatch' : undefined));
          }
        };
        worker.start();
      });
      const input: Readonly<Record<string, TransportJson>> = goalTagger ? { text: 'Hello' } : operation === 'classify' ? { inputIds: [0] }
        : operation === 'select' ? { inputIds: [0, 1], candidatePositions: [0, 1] } : { inputIds: [0], maxNewTokens: 1 };
      await request(operation, head, input, signal, context.startupMs);
    },
    health: ready,
    run: async (input, signal, timeoutMs) => {
      if (dense) {
        const fromText = denseInput.safeParse(input);
        const inference = dense.training.inference;
        const encoded = fromText.success ? encodedResult.parse(await encode(executable, env, context, signal, 'head', {
          ...fromText.data, tokenizer: dense.tokenizer, tokenizerReport: dense.report,
          tokenizerId: config.identity.tokenizerId, eosTokenId: inference.eos_token_id, maxTokens: inference.max_tokens,
        })) : undefined;
        const payload = operation === 'classify' ? inputAs(classifyInput, encoded ? { inputIds: encoded.inputIds } : input)
          : inputAs(selectInput, encoded ? { inputIds: encoded.inputIds, candidatePositions: encoded.candidatePositions } : input);
        const result = await request(operation, head, payload, signal, timeoutMs);
        const scores = finiteScores.parse(operation === 'classify' ? result.logits : result.scores);
        if (operation === 'classify' && inference.labels?.length !== scores.length) throw new ModelRuntimeError('incompatible', 'Head labels do not match its output width');
        const decision = decide(scores, inference.calibration);
        const index = decision.index;
        return operation === 'classify' ? { ...result, label: index === null ? undefined : inference.labels?.[index], abstained: index === null, confidence: decision.confidence }
          : { ...result, selectedIndex: index === null ? null : (encoded?.candidateIndices?.[index] ?? index), abstained: index === null, confidence: decision.confidence };
      }
      if (goalTagger) return request(operation, head, inputAs(z.object({ text: genText }).strict(), input), signal, timeoutMs);
      const scored = scoreOptionsInput.safeParse(input);
      if (scored.success && model.entry.id === 'chat-v5') {
        const { head = 'options', operation, ...payload } = scored.data;
        return request(operation, head, Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined)), signal, timeoutMs);
      }
      const generated = inputAs(generateInput, input);
      if (!isAds || !('text' in generated)) return request(operation, head, generated, signal, timeoutMs);
      const { text, ...settings } = generated;
      const tokenizer = record.parse(config.model.tokenizer);
      const extra = { tokenizer, tokenizerId: config.identity.tokenizerId };
      const inputIds = tokenIds.parse(await encode(executable, env, context, signal, 'ads-encode', { text, ...extra }));
      const raw = await request(operation, head, { ...settings, inputIds }, signal, timeoutMs);
      const decoded = await encode(executable, env, context, signal, 'ads-decode', { tokens: raw.tokenIds, ...extra });
      return { ...raw, text: decoded };
    },
    close: async () => {
      try { await worker.stop(); } finally { await rm(temporary, { recursive: true, force: true }); }
    },
  };
}
