/**
 * Local experiment path for Mohassan's own execution model (the scratch-trained worker).
 *
 * Reasoning and execution stay separate:
 *   - direct:   typed fields -> the local worker. No external model is called.
 *   - assisted: a reasoning provider only turns the owner's text into typed fields; the
 *               local worker still produces the candidate. The app wires no provider here:
 *               the owner allows no external AI API, so this mode stays off until the
 *               reasoning is local. Any reasoning call would be recorded with the result.
 * The worker runs through ExperimentalUncontainedWorkerTransport, which has no OS
 * containment, so this path is owner-only, off in production and off unless
 * EXECUTOR_EXPERIMENT=uncontained-local. Generated TypeScript runs only in the
 * AppContainer sandbox; JSON candidates are checked by a fixed domain predicate.
 * Nothing here needs Ollama, downloads a model, trains, or falls back to a cloud model.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ollamaInventory, ProviderError, type ModelRequest, type ModelResult, type OllamaInventory } from '@mohassan/providers';
import { ExperimentalUncontainedWorkerTransport } from '../../../packages/execution-integration/src/experimental-worker-transport.js';
import { ModelTransportError, type LocalModelProcessConfig, type ModelTransport } from '../../../packages/execution-integration/src/transport.js';

export const EXECUTOR_EXPERIMENT_MODE = 'uncontained-local';
const WORKER_MAX_OUTPUT_TOKENS = 96;
const SHA = /^[a-f0-9]{64}$/;

export interface ExecutorConfig {
  /** True only when EXECUTOR_EXPERIMENT=uncontained-local and not production. */
  enabled: boolean;
  /** Inference checkpoint directory (manifest.json, config.json, tokenizer.json, weights.pt). */
  checkpointDir?: string;
  /** Phase 3 registry entry for this model version; its .evaluation.json sibling is read too. */
  registryEntry?: string;
  /** Independent evaluation report whose model_metadata names this exact checkpoint. */
  evaluationReport?: string;
  python: string;
  packageDir: string;
  device: 'cpu' | 'cuda';
  ollamaUrl?: string;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  /** Used only to resolve the registry's relative training-report reference. */
  root: string;
}

export function executorConfigFromEnv(env: NodeJS.ProcessEnv, root: string, production: boolean): ExecutorConfig {
  const path = (value: string | undefined) => value?.trim() ? resolve(root, value.trim()) : undefined;
  const seconds = (value: string | undefined, fallback: number) => /^\d{1,3}$/.test(value ?? '') && Number(value) >= 5 ? Number(value) * 1000 : fallback;
  return {
    enabled: !production && env.EXECUTOR_EXPERIMENT === EXECUTOR_EXPERIMENT_MODE,
    checkpointDir: path(env.EXECUTOR_CHECKPOINT), registryEntry: path(env.EXECUTOR_REGISTRY_ENTRY), evaluationReport: path(env.EXECUTOR_EVALUATION_REPORT),
    python: path(env.EXECUTOR_PYTHON) ?? join(root, '.venv-execution', 'Scripts', 'python.exe'),
    packageDir: join(root, 'packages', 'execution-pipeline'),
    device: env.EXECUTOR_DEVICE === 'cuda' ? 'cuda' : 'cpu',
    ollamaUrl: env.LOCAL_MODEL_URL?.trim() || undefined,
    startupTimeoutMs: seconds(env.EXECUTOR_STARTUP_TIMEOUT_SECONDS, 90_000),
    requestTimeoutMs: seconds(env.EXECUTOR_REQUEST_TIMEOUT_SECONDS, 60_000),
    root,
  };
}

/** The tasks this UI offers. Domain bounds are enforced by the worker itself (tasks.py). */
export const EXECUTOR_TASKS = {
  'json.transform.v1:integers-to-strings': {
    family: 'type_transform', output: 'json', required: ['values'],
    fields: z.object({ values: z.array(z.number().int()).max(16) }).strict(),
    schema: { type: 'object', properties: { values: { type: 'array', items: { type: 'integer' }, maxItems: 16 } }, required: ['values'], additionalProperties: false },
  },
  'json.check.v1:inclusive-interval': {
    family: 'boundary_conditions', output: 'json', required: ['value', 'minimum', 'maximum'],
    fields: z.object({ value: z.number().int(), minimum: z.number().int(), maximum: z.number().int() }).strict(),
    schema: { type: 'object', properties: { value: { type: 'integer' }, minimum: { type: 'integer' }, maximum: { type: 'integer' } }, required: ['value', 'minimum', 'maximum'], additionalProperties: false },
  },
  'typescript.implement.v1:null-safe-delta': {
    family: 'typescript_function', output: 'typescript', required: ['function_name', 'increment'],
    fields: z.object({ function_name: z.string().min(1).max(64), increment: z.number().int() }).strict(),
    schema: { type: 'object', properties: { function_name: { type: 'string' }, increment: { type: 'integer' } }, required: ['function_name', 'increment'], additionalProperties: false },
  },
} as const;
export type ExecutorCapability = keyof typeof EXECUTOR_TASKS;
const isCapability = (value: string): value is ExecutorCapability => Object.hasOwn(EXECUTOR_TASKS, value);

export type CheckpointState =
  | { state: 'disabled'; message: string }
  | { state: 'checkpoint_missing'; message: string; path: string | null }
  | { state: 'checkpoint_incompatible'; message: string; reason: string; path: string }
  | { state: 'runtime_missing'; message: string; python: string }
  | { state: 'available'; checkpoint: CheckpointInfo };

export interface CheckpointInfo {
  path: string;
  modelVersion: string;
  architecture: string;
  checkpointId: string;
  tokenizerId: string;
  configIdentity: string;
  weightsSha256: string;
  vocabularySize: number;
  parameters: { layers: number; hidden: number; heads: number; contextLength: number };
  initialization: 'random';
  trainingStatus: string;
  training: { optimizerSteps: number; processedTokens: number; uniqueDatasetTokens: number; status: string } | null;
  evaluation: { status: string; promotion: string; passed: boolean | null; reportBound: boolean; perFamily: Record<string, { tasks: number; modelSuccess: number }> } | null;
  device: 'cpu' | 'cuda';
}

export interface LoadCheck { status: 'loaded' | 'failed'; checkedAt: string; durationMs: number; capabilities: string[]; error?: string }

/** available: configured and not in a known error state. verified: a real call succeeded within the provider's window. */
export interface ReasoningStatus { provider: string; configured: boolean; available: boolean; verified?: boolean; model: string | null; message: string }
export interface ExecutorReasoning {
  status(): Promise<ReasoningStatus>;
  /** Absent when no reasoning provider is configured. */
  extract?(request: ModelRequest): Promise<ModelResult>;
}

export interface ExecutorSandbox {
  available(): Promise<{ available: boolean; provider: string | null; message: string }>;
  run(request: { files: { path: string; content: string }[]; testFiles: string[]; signal?: AbortSignal; timeoutMs?: number }): Promise<{ exitCode: number | null; timedOut: boolean; stdout: string; provider: string; network: string; isolationVerified: boolean; durationMs: number }>;
}

export interface ExecutorDependencies {
  config: ExecutorConfig;
  sandbox?: ExecutorSandbox;
  reasoning?: ExecutorReasoning;
  /** Tests inject a fake; the default launches the real worker without containment. */
  transport?: (config: LocalModelProcessConfig) => ModelTransport;
  /** Read-only Ollama status probe; injected in tests. */
  fetch?: typeof fetch;
}

export type RunStatus = 'candidate' | 'missing_context' | 'unsupported' | 'timeout' | 'cancelled' | 'process_failure'
  | 'checkpoint_missing' | 'checkpoint_incompatible' | 'runtime_missing' | 'reasoning_unavailable' | 'reasoning_failed' | 'disabled';

export interface Verification {
  status: 'passed' | 'rejected' | 'unavailable';
  method: string;
  checks: string[];
  reason?: string;
  sandbox?: { provider: string; network: string; isolationVerified: boolean; exitCode: number | null; timedOut: boolean; durationMs: number };
}

export interface ExecutorRun {
  runId: string;
  mode: 'direct' | 'assisted';
  capability: string;
  status: RunStatus;
  message: string;
  submitted: { capability: string; fields: Record<string, unknown> | null };
  executor: { kind: 'local-custom-model'; transport: 'ExperimentalUncontainedWorkerTransport'; contained: false; modelVersion: string | null; checkpointId: string | null; tokenizerId: string | null; device: 'cpu' | 'cuda'; called: boolean };
  /** Every external model call made for this run. Empty in direct mode. */
  external: { provider: string; model: string; purpose: 'field_extraction'; inputTokens: number; outputTokens: number; durationMs: number; output: Record<string, unknown> | null }[];
  candidate: { text: string; outputTokens: number; generationMs: number; stopReason: string } | null;
  missingContextKeys?: string[];
  verification: Verification | null;
  timing: { totalMs: number; executorMs: number | null };
  startedAt: string;
}

class ExecutorHttpError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}

async function exists(path: string) { try { await access(path); return true; } catch { return false; } }
async function readJson(path: string): Promise<{ text: string; value: Record<string, any> }> {
  const text = await readFile(path, 'utf8');
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
  return { text, value: value as Record<string, any> };
}
function sha256File(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', fail).on('end', () => done(hash.digest('hex')));
  });
}

/** Independent predicates for the JSON families; they never call the model or the generator. */
export function verifyJsonCandidate(capability: ExecutorCapability, fields: Record<string, unknown>, text: string): Verification {
  const method = 'deterministic-domain-predicate-v1';
  let output: unknown;
  try { output = JSON.parse(text); } catch { return { status: 'rejected', method, checks: ['json_parse'], reason: 'المخرج ليس JSON صالحًا.' }; }
  if (!output || typeof output !== 'object' || Array.isArray(output)) return { status: 'rejected', method, checks: ['json_object'], reason: 'المخرج ليس كائن JSON.' };
  const keys = Object.keys(output).sort();
  const record = output as Record<string, unknown>;
  if (capability === 'json.transform.v1:integers-to-strings') {
    const input = fields.values as number[];
    const checks = ['json_object', 'exact_keys', 'same_length', 'canonical_base10_strings', 'same_values_in_order'];
    if (keys.join() !== 'values' || !Array.isArray(record.values)) return { status: 'rejected', method, checks, reason: 'يجب أن يحتوي الكائن على المفتاح values فقط.' };
    if (record.values.length !== input.length) return { status: 'rejected', method, checks, reason: `عدد العناصر ${record.values.length} والمطلوب ${input.length}.` };
    const wrong = record.values.findIndex((item, index) => typeof item !== 'string' || !/^(0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(item) || Number(item) !== input[index]);
    return wrong >= 0 ? { status: 'rejected', method, checks, reason: `العنصر ${wrong + 1} لا يطابق ${input[wrong]}.` } : { status: 'passed', method, checks };
  }
  if (capability === 'json.check.v1:inclusive-interval') {
    const { value, minimum, maximum } = fields as { value: number; minimum: number; maximum: number };
    const truth = minimum <= value && value <= maximum;
    const checks = ['json_object', 'exact_keys', 'boolean_type', 'inclusive_interval_truth'];
    if (keys.join() !== 'within' || typeof record.within !== 'boolean') return { status: 'rejected', method, checks, reason: 'يجب أن يحتوي الكائن على within منطقيًا فقط.' };
    return record.within === truth ? { status: 'passed', method, checks } : { status: 'rejected', method, checks, reason: `الجواب ${record.within} والصحيح ${truth}.` };
  }
  return { status: 'unavailable', method, checks: [], reason: 'لا يوجد فاحص JSON لهذه القدرة.' };
}

/** The supervisor's own test, never written by the model. */
export function nullSafeDeltaSpec(name: string, increment: number): string {
  const numeric = [-1024, -1, 0, 7].map(input => `[${input}, ${input + increment}]`).join(', ');
  return `import test from 'node:test';import assert from 'node:assert/strict';import { ${name} } from './candidate.ts';\n`
    + `test('${name} specification', () => {\n  for (const [input, expected] of [[null, 0], [undefined, 0], ${numeric}]) assert.equal(${name}(input), expected, String(input));\n});\n`;
}

export function createExecutorControl(dependencies: ExecutorDependencies) {
  const { config } = dependencies;
  let cached: { key: string; state: CheckpointState } | null = null;
  let lastLoad: LoadCheck | null = null;
  let transport: { key: string; value: ModelTransport } | null = null;
  const active = new Map<string, AbortController>();
  let busy = false;

  async function checkpoint(): Promise<CheckpointState> {
    if (!config.enabled) return { state: 'disabled', message: 'تجربة المنفّذ المحلي غير مفعّلة. فعّلها بـ EXECUTOR_EXPERIMENT=uncontained-local خارج الإنتاج.' };
    const dir = config.checkpointDir;
    if (!dir) return { state: 'checkpoint_missing', message: 'لم يُحدد مسار نقطة الحفظ (EXECUTOR_CHECKPOINT).', path: null };
    const files = ['manifest.json', 'config.json', 'tokenizer.json', 'weights.pt'].map(name => join(dir, name));
    for (const file of files) if (!await exists(file)) return { state: 'checkpoint_missing', message: `ملف نقطة الحفظ غير موجود: ${file}`, path: dir };
    const weightsStat = await stat(files[3]!);
    const key = JSON.stringify([dir, weightsStat.size, weightsStat.mtimeMs, config.registryEntry, config.evaluationReport, config.python]);
    if (cached?.key === key) return cached.state;
    const incompatible = (reason: string, message: string): CheckpointState => ({ state: 'checkpoint_incompatible', reason, message, path: dir });
    const state = await (async (): Promise<CheckpointState> => {
      let manifest: Awaited<ReturnType<typeof readJson>>, modelConfig: Record<string, any>;
      try { manifest = await readJson(files[0]!); modelConfig = (await readJson(files[1]!)).value; }
      catch { return incompatible('unreadable_metadata', 'تعذرت قراءة manifest.json أو config.json.'); }
      const m = manifest.value;
      if (m.format !== 'mohassan-execution-checkpoint' || m.architecture !== 'dense-decoder-v1') return incompatible('unknown_format', 'صيغة نقطة الحفظ أو معماريتها غير معروفة.');
      if (!SHA.test(String(m.tokenizer_identity)) || !SHA.test(String(m.weights_sha256)) || !SHA.test(String(m.config_identity))) return incompatible('invalid_identity', 'هويات نقطة الحفظ ناقصة أو غير صالحة.');
      if (await sha256File(files[3]!) !== m.weights_sha256) return incompatible('weights_hash_mismatch', 'بصمة الأوزان لا تطابق manifest.json.');
      // Same derivation the worker pins on load (scripts/execution-try.ts).
      const checkpointId = createHash('sha256').update(manifest.text.replace(/\n$/, '')).digest('hex');
      let modelVersion = `local:${checkpointId.slice(0, 12)}`;
      let training: CheckpointInfo['training'] = null;
      let evaluation: CheckpointInfo['evaluation'] = null;
      if (config.registryEntry) {
        let entry: Record<string, any>;
        try { entry = (await readJson(config.registryEntry)).value; } catch { return incompatible('registry_unreadable', 'تعذرت قراءة سجل إصدار النموذج.'); }
        if (entry.tokenizer_version?.identity !== m.tokenizer_identity) return incompatible('tokenizer_mismatch', 'هوية المُرمِّز في السجل لا تطابق نقطة الحفظ.');
        if (entry.tokenizer_version?.vocabulary_size !== modelConfig.vocab_size) return incompatible('vocabulary_mismatch', 'حجم المفردات في السجل لا يطابق إعداد النموذج.');
        if (entry.architecture_identity !== m.architecture) return incompatible('architecture_mismatch', 'معمارية السجل لا تطابق نقطة الحفظ.');
        if (entry.training_provenance?.initialization !== 'random') return incompatible('not_scratch', 'السجل لا يثبت أن النموذج بدأ من أوزان عشوائية.');
        modelVersion = String(entry.model_version);
        const reportRef = entry.training_provenance?.report_reference;
        if (typeof reportRef === 'string') {
          try {
            const report = (await readJson(isAbsolute(reportRef) ? reportRef : resolve(config.root, reportRef))).value;
            training = { optimizerSteps: Number(report.session_optimizer_steps), processedTokens: Number(report.session_committed_training_tokens), uniqueDatasetTokens: Number(report.unique_dataset_tokens), status: String(report.status) };
          } catch { training = null; }
        }
        try {
          const verdict = (await readJson(config.registryEntry.replace(/\.json$/, '.evaluation.json'))).value;
          evaluation = { status: String(verdict.evaluation_status), promotion: String(verdict.promotion_status), passed: typeof verdict.attestation?.passed === 'boolean' ? verdict.attestation.passed : null, reportBound: false, perFamily: {} };
        } catch { evaluation = { status: String(entry.evaluation_status ?? 'unknown'), promotion: String(entry.promotion_status ?? 'unknown'), passed: null, reportBound: false, perFamily: {} }; }
      }
      if (config.evaluationReport) {
        try {
          const report = (await readJson(config.evaluationReport)).value;
          const bound = report.model_metadata?.checkpoint_identity === checkpointId && report.model_metadata?.tokenizer_identity === m.tokenizer_identity;
          const perFamily = Object.fromEntries(Object.entries((report.per_family ?? {}) as Record<string, { tasks: number; model_first_attempt: number }>)
            .map(([family, row]) => [family, { tasks: Number(row.tasks), modelSuccess: Number(row.model_first_attempt) }]));
          evaluation = { ...(evaluation ?? { status: 'unknown', promotion: 'unknown', passed: null }), reportBound: bound, perFamily: bound ? perFamily : {} };
        } catch { /* An unreadable report leaves the evaluation unbound; it never blocks loading. */ }
      }
      if (!await exists(config.python)) return { state: 'runtime_missing', message: `مفسّر Python للمنفّذ غير موجود: ${config.python}`, python: config.python };
      return { state: 'available', checkpoint: {
        path: dir, modelVersion, architecture: m.architecture, checkpointId, tokenizerId: m.tokenizer_identity, configIdentity: m.config_identity,
        weightsSha256: m.weights_sha256, vocabularySize: Number(modelConfig.vocab_size),
        parameters: { layers: Number(modelConfig.num_layers), hidden: Number(modelConfig.hidden_size), heads: Number(modelConfig.num_heads), contextLength: Number(modelConfig.max_context_length) },
        initialization: 'random', trainingStatus: String(m.training_status ?? 'unknown'), training, evaluation, device: config.device,
      } };
    })();
    cached = { key, state };
    return state;
  }

  function transportFor(info: CheckpointInfo): ModelTransport {
    const key = `${info.checkpointId}:${config.device}`;
    if (transport?.key === key) return transport.value;
    const identity = { modelId: info.modelVersion.replace(/[^A-Za-z0-9._:/@+-]/g, '-'), tokenizerId: `sha256:${info.tokenizerId}`, checkpointId: `sha256:${info.checkpointId}` };
    const processConfig: LocalModelProcessConfig = {
      executable: config.python,
      args: ['-m', 'execution_pipeline.worker', '--checkpoint', info.path, '--model-id', identity.modelId, '--tokenizer-id', identity.tokenizerId, '--checkpoint-id', identity.checkpointId, '--device', config.device],
      cwd: config.packageDir,
      environment: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
      identity, readOnlyPaths: [info.path], maxRememberedRequestIds: 10_000,
      limits: { memoryBytes: 4 * 1024 ** 3, cpuTimeMs: 600_000, maxProcesses: 1, maxInputBytes: 65_536, maxMessageBytes: 65_536, maxOutputBytes: 262_144,
        maxStderrBytes: 0, maxOutputTokens: WORKER_MAX_OUTPUT_TOKENS, startupTimeoutMs: config.startupTimeoutMs, requestTimeoutMs: config.requestTimeoutMs, cleanupTimeoutMs: 10_000 },
    };
    const value = dependencies.transport?.(processConfig) ?? new ExperimentalUncontainedWorkerTransport(processConfig, {
      mode: 'uncontained-local-demonstration', reason: 'Owner-only local experiment; inference-only worker with no tools, network client or writes.',
    });
    transport = { key, value };
    return value;
  }

  async function reasoningStatus(): Promise<ReasoningStatus> {
    if (!dependencies.reasoning) return { provider: 'none', configured: false, available: false, model: null, message: 'لا يُستخدم أي مزود ذكاء اصطناعي خارجي. وضع المساعدة معطّل حتى يصبح التفكير محليًا.' };
    try { return await dependencies.reasoning.status(); }
    catch { return { provider: 'unknown', configured: true, available: false, model: null, message: 'تعذرت قراءة حالة مزود التفكير.' }; }
  }

  async function status() {
    const [state, reasoning, ollama] = await Promise.all([
      checkpoint(),
      reasoningStatus(),
      ollamaInventory({ baseUrl: config.ollamaUrl, fetch: dependencies.fetch, timeoutMs: 1500 }).catch((): OllamaInventory => ({ status: 'unreachable', origin: config.ollamaUrl ?? 'http://127.0.0.1:11434' })),
    ]);
    const sandbox = dependencies.sandbox ? await dependencies.sandbox.available().catch(() => ({ available: false, provider: null, message: 'تعذر فحص بيئة العزل.' })) : { available: false, provider: null, message: 'لا توجد بيئة عزل مهيأة.' };
    return {
      experiment: { enabled: config.enabled, mode: config.enabled ? EXECUTOR_EXPERIMENT_MODE : null, contained: false as const },
      executor: { ...state, load: state.state === 'available' && lastLoad ? lastLoad : null, busy },
      reasoning, ollama, sandbox,
      tasks: (Object.keys(EXECUTOR_TASKS) as ExecutorCapability[]).map(capability => ({ capability, family: EXECUTOR_TASKS[capability].family, output: EXECUTOR_TASKS[capability].output, required: [...EXECUTOR_TASKS[capability].required] })),
    };
  }

  /** Loads the checkpoint through the worker's strict loader and returns its handshake. */
  async function check(signal: AbortSignal): Promise<LoadCheck> {
    const state = await checkpoint();
    if (state.state !== 'available') throw new ExecutorHttpError(409, state.state.toUpperCase(), 'message' in state ? state.message : 'المنفّذ غير متاح.');
    if (busy) throw new ExecutorHttpError(409, 'EXECUTOR_BUSY', 'المنفّذ مشغول بتجربة أخرى.');
    busy = true;
    const started = performance.now();
    try {
      const ready = await transportFor(state.checkpoint).discover(signal);
      lastLoad = { status: 'loaded', checkedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started), capabilities: [...ready.capabilities] };
    } catch (error) {
      lastLoad = { status: 'failed', checkedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started), capabilities: [], error: error instanceof ModelTransportError ? error.code : 'model_process_failure' };
    } finally { busy = false; }
    return lastLoad;
  }

  const RunInputSchema = z.object({
    runId: z.uuid(),
    mode: z.enum(['direct', 'assisted']),
    capability: z.string().min(1).max(120),
    fields: z.record(z.string(), z.unknown()).optional(),
    request: z.string().trim().min(3).max(1000).optional(),
  }).strict();

  async function run(body: unknown, outerSignal?: AbortSignal): Promise<ExecutorRun> {
    const input = RunInputSchema.parse(body);
    if (active.has(input.runId)) throw new ExecutorHttpError(409, 'DUPLICATE_RUN', 'هذا المعرف مستخدم لتجربة جارية.');
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const state = await checkpoint();
    const info = state.state === 'available' ? state.checkpoint : null;
    const result: ExecutorRun = {
      runId: input.runId, mode: input.mode, capability: input.capability, status: 'candidate', message: '',
      submitted: { capability: input.capability, fields: null },
      executor: { kind: 'local-custom-model', transport: 'ExperimentalUncontainedWorkerTransport', contained: false, modelVersion: info?.modelVersion ?? null,
        checkpointId: info?.checkpointId ?? null, tokenizerId: info?.tokenizerId ?? null, device: config.device, called: false },
      external: [], candidate: null, verification: null, timing: { totalMs: 0, executorMs: null }, startedAt,
    };
    const finish = (status: RunStatus, message: string) => { result.status = status; result.message = message; result.timing.totalMs = Math.round(performance.now() - started); return result; };
    if (state.state !== 'available') return finish(state.state === 'disabled' ? 'disabled' : state.state, state.message);
    if (!isCapability(input.capability)) return finish('unsupported', 'هذه القدرة غير معروضة في تجربة المنفّذ.');
    const task = EXECUTOR_TASKS[input.capability];
    if (busy) throw new ExecutorHttpError(409, 'EXECUTOR_BUSY', 'المنفّذ مشغول بتجربة أخرى.');
    busy = true;
    const controller = new AbortController();
    active.set(input.runId, controller);
    const signal = outerSignal ? AbortSignal.any([controller.signal, outerSignal]) : controller.signal;
    try {
      let fields: Record<string, unknown> = { ...(input.fields ?? {}) };
      if (input.mode === 'assisted') {
        const reasoning = await reasoningStatus();
        if (!reasoning.available || !dependencies.reasoning?.extract) return finish('reasoning_unavailable', `مزود التفكير غير متاح: ${reasoning.message}`);
        if (!input.request) return finish('missing_context', 'الوضع المساعد يحتاج نص الطلب.');
        const callStarted = performance.now();
        try {
          const extracted = await dependencies.reasoning.extract({
            goal: input.request, maxTokens: 300, signal,
            system: `Extract the typed input fields for the task "${task.family}" from the user's text. Return only JSON that matches the schema. Do not solve the task and do not add fields. If a value is not stated, omit that field.`,
            structured: { name: 'executor_fields', schema: { ...task.schema, required: [] } },
          });
          let parsed: unknown = null;
          try { parsed = JSON.parse(extracted.text); } catch { parsed = null; }
          const output = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
          result.external.push({ provider: reasoning.provider, model: extracted.model, purpose: 'field_extraction', inputTokens: extracted.usage?.inputTokens ?? 0,
            outputTokens: extracted.usage?.outputTokens ?? 0, durationMs: Math.round(performance.now() - callStarted), output });
          if (!output) return finish('reasoning_failed', 'لم يُرجع مزود التفكير حقولًا صالحة.');
          fields = output;
        } catch (error) {
          if (signal.aborted) return finish('cancelled', 'أُلغيت التجربة.');
          return finish('reasoning_failed', error instanceof ProviderError ? `فشل مزود التفكير (${error.code}).` : 'فشل مزود التفكير.');
        }
      }
      result.submitted.fields = fields;
      const missing = task.required.filter(key => fields[key] === undefined || fields[key] === null || fields[key] === '');
      if (missing.length) { result.missingContextKeys = missing; return finish('missing_context', 'حقول ناقصة؛ لم يُستدعَ النموذج.'); }
      const typed = task.fields.safeParse(fields);
      if (!typed.success) return finish('unsupported', 'أنواع الحقول لا تطابق عقد هذه القدرة؛ لم يُستدعَ النموذج.');
      const submitted = typed.data as Record<string, unknown>;
      result.submitted.fields = submitted;
      const executorStarted = performance.now();
      result.executor.called = true;
      let response;
      try {
        response = await transportFor(info!).submit({ requestId: randomUUID(), taskId: input.runId, capability: input.capability,
          contract: { fields: submitted as never }, context: {}, maxOutputTokens: WORKER_MAX_OUTPUT_TOKENS }, signal);
      } catch (error) {
        result.timing.executorMs = Math.round(performance.now() - executorStarted);
        const code = error instanceof ModelTransportError ? error.code : 'model_process_failure';
        if (code === 'cancelled' || signal.aborted) return finish('cancelled', 'أُلغيت التجربة وأُوقفت عملية النموذج.');
        if (code === 'timeout') return finish('timeout', 'انتهت مهلة النموذج المحلي.');
        if (code === 'unsupported_capability') return finish('unsupported', 'نقطة الحفظ لا تعلن دعم هذه القدرة.');
        if (code === 'model_identity_mismatch') { cached = null; return finish('checkpoint_incompatible', 'هوية النموذج لا تطابق نقطة الحفظ المثبتة.'); }
        return finish('process_failure', `فشلت عملية النموذج المحلي (${code}).`);
      }
      result.timing.executorMs = Math.round(performance.now() - executorStarted);
      if (response.status === 'unsupported') return finish('unsupported', 'القيم خارج النطاق الذي دُرّب عليه النموذج؛ رفضها المنفّذ دون توليد.');
      if (response.status === 'missing_context') { result.missingContextKeys = [...response.missingContextKeys]; return finish('missing_context', 'طلب المنفّذ حقولًا ناقصة.'); }
      const proposal = response.proposal as { text?: unknown; generationMs?: unknown; stopReason?: unknown } | null;
      if (!proposal || typeof proposal.text !== 'string') return finish('process_failure', 'رد المنفّذ لا يحتوي نصًا.');
      result.candidate = { text: proposal.text, outputTokens: response.outputTokens, generationMs: Number(proposal.generationMs ?? 0), stopReason: String(proposal.stopReason ?? 'unknown') };
      if (task.output === 'json') result.verification = verifyJsonCandidate(input.capability, submitted, proposal.text);
      else result.verification = await verifyTypescript(submitted as { function_name: string; increment: number }, proposal.text, signal);
      if (signal.aborted) return finish('cancelled', 'أُلغيت التجربة بعد التوليد.');
      return finish('candidate', result.verification.status === 'passed' ? 'اجتاز المرشح الفحص المستقل.' : result.verification.status === 'rejected' ? 'رفض الفحص المستقل المرشح.' : 'المرشح غير مُتحقق منه.');
    } finally {
      active.delete(input.runId);
      busy = false;
    }
  }

  async function verifyTypescript(fields: { function_name: string; increment: number }, text: string, signal: AbortSignal): Promise<Verification> {
    const method = 'appcontainer-node-test-v1';
    const sandbox = dependencies.sandbox;
    const availability = sandbox ? await sandbox.available().catch(() => ({ available: false, provider: null, message: '' })) : null;
    if (!sandbox || !availability?.available) return { status: 'unavailable', method, checks: [], reason: 'بيئة العزل غير متاحة؛ لم يُشغَّل المرشح.' };
    const receipt = await sandbox.run({ timeoutMs: 20_000, signal, testFiles: ['spec.test.mjs'], files: [
      { path: 'package.json', content: '{"type":"module","private":true}' },
      { path: 'candidate.ts', content: text },
      { path: 'spec.test.mjs', content: nullSafeDeltaSpec(fields.function_name, fields.increment) },
    ] });
    const sandboxInfo = { provider: receipt.provider, network: receipt.network, isolationVerified: receipt.isolationVerified, exitCode: receipt.exitCode, timedOut: receipt.timedOut, durationMs: receipt.durationMs };
    if (!receipt.isolationVerified) return { status: 'unavailable', method, checks: [], reason: 'لم تقدّم بيئة العزل دليل عزل.', sandbox: sandboxInfo };
    const passed = receipt.exitCode === 0 && !receipt.timedOut;
    const reason = passed ? undefined : receipt.stdout.split(/\r?\n/).find(line => /Error|actual|expected/.test(line))?.trim().slice(0, 300) ?? 'فشلت الاختبارات.';
    return { status: passed ? 'passed' : 'rejected', method, checks: ['null_returns_zero', 'undefined_returns_zero', 'numeric_boundaries'], ...(reason ? { reason } : {}), sandbox: sandboxInfo };
  }

  function cancel(runId: string): boolean {
    const controller = active.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  function shutdown() { for (const controller of active.values()) controller.abort(); }

  return { status, check, run, cancel, shutdown, checkpoint };
}
export type ExecutorControl = ReturnType<typeof createExecutorControl>;

export async function registerExecutorRoutes(app: FastifyInstance, options: { control: ExecutorControl; owner: (request: { headers: Record<string, unknown> }) => Promise<{ id: string }> }) {
  const { control, owner } = options;
  const send = (reply: { code(status: number): { send(body: unknown): unknown } }, error: unknown) => {
    if (error instanceof ExecutorHttpError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    throw error;
  };
  app.get('/api/executor/status', async request => { await owner(request); return control.status(); });
  app.post('/api/executor/check', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (request, reply) => {
    await owner(request);
    z.object({}).strict().parse(request.body ?? {});
    const controller = new AbortController();
    reply.raw.on('close', () => { if (!reply.sent) controller.abort(); });
    try { return await control.check(controller.signal); } catch (error) { return send(reply, error); }
  });
  app.post('/api/executor/runs', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    await owner(request);
    const controller = new AbortController();
    // A closed browser tab stops the worker; the result is never retried.
    reply.raw.on('close', () => { if (!reply.sent) controller.abort(); });
    try { return await control.run(request.body, controller.signal); } catch (error) { return send(reply, error); }
  });
  app.delete<{ Params: { id: string } }>('/api/executor/runs/:id', async request => {
    await owner(request);
    return { cancelled: control.cancel(z.uuid().parse(request.params.id)) };
  });
}
