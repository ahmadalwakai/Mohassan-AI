import { createHash } from 'node:crypto';
import { access, open } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { PermanentModelWorker, type PermanentModelWorkerStatus } from '../../execution-integration/src/permanent-worker.js';
import { ModelTransportError } from '../../execution-integration/src/transport.js';
import { inputAs, requiredArtifact } from './adapters.js';
import type { ResolvedModel } from './registry.js';
import { ModelRuntimeError, type ModelAdapter, type ModelAdapterContext } from './runtime.js';

// Export format, feature order and inference math: scripts/router/train_context.py at 29448ae.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/scripts/router/train_context.py (retrieved 2026-11-27).
const routes = ['web_search', 'browser_command', 'news', 'memory', 'reminder', 'compute', 'ads', 'pc', 'writing',
  'planning', 'coding', 'chat', 'image', 'media', 'unsupported', 'clarify'] as const;
const priorRoutes = ['none', ...routes] as const;
const sources = ['none', 'public_lookup', 'prior_conversation', 'local_state', 'supplied_content', 'unresolved'] as const;
const scopes = ['none', 'public', 'private', 'unknown'] as const;
const fields = ['none', 'choice', 'place', 'budget', 'time', 'text'] as const;
const contextFeatures = [
  ...priorRoutes.map(route => `prior_route:${route}`),
  ...sources.map(source => `source:${source}`),
  ...scopes.map(scope => `scope:${scope}`),
  'pending:false', 'pending:true',
  ...fields.map(field => `field:${field}`),
];
const maxTextLength = 512;
const maxFeatures = 2_048;
const maxBuckets = 1 << 18;
const maxDimension = 64;
const maxHidden = 128;
// Python's str.split/re whitespace includes U+0085 and excludes U+FEFF.
const pythonSpace = /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu;
const headerSchema = z.object({
  format: z.literal('mohassan-context-b0-v1'),
  active: z.literal(false),
  routes: z.array(z.enum(routes)).length(routes.length).refine(values => values.every((value, index) => value === routes[index])),
  config: z.object({
    buckets: z.number().int().min(128).max(maxBuckets).refine(value => (value & (value - 1)) === 0),
    dim: z.number().int().min(4).max(maxDimension),
    hidden: z.number().int().min(8).max(maxHidden),
  }),
  withContext: z.boolean(),
  contextFeatures: z.array(z.string()).length(contextFeatures.length)
    .refine(values => values.every((value, index) => value === contextFeatures[index])),
  dtype: z.literal('float32-little-endian'),
  layout: z.array(z.object({
    name: z.string(),
    shape: z.array(z.number().int().positive()).min(1).max(2),
    offsetBytes: z.number().int().nonnegative(),
    lengthBytes: z.number().int().positive(),
  })).length(5),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const calibrationSchema = z.object({
  temperature: z.number().finite().positive(),
  // The trainer emits a threshold above 1 when no calibrated threshold qualifies.
  threshold: z.number().min(0).max(1.000001),
  partition: z.literal('calibration'),
  notProductionCalibrated: z.literal(true),
});
const routerInput = z.object({
  text: z.string().min(1).max(maxTextLength * 2),
  previousRoute: z.enum(priorRoutes).optional().default('none'),
  source: z.enum(sources).optional().default('none'),
  scope: z.enum(scopes).optional().default('none'),
  pendingReply: z.boolean().optional().default(false),
  requestedField: z.enum(fields).optional().default('none'),
}).strict().refine(input => input.pendingReply || input.requestedField === 'none')
  .refine(input => !['prior_conversation', 'local_state', 'supplied_content'].includes(input.source) || input.scope === 'private');

function fold(text: string): string {
  return text.normalize('NFC').replace(/[\u0640\u064b-\u065f\u0670]/gu, '')
    .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه')
    .replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) & 15))
    .toLowerCase().replace(pythonSpace, ' ').replace(/^ | $/gu, '');
}

function featureIds(text: string, buckets: number): number[] {
  if (!text.replace(pythonSpace, '').length || Array.from(text).length > maxTextLength) throw new ModelRuntimeError('invalid-input');
  const folded = fold(text);
  const chars = Array.from(`^${folded}$`);
  const id = (feature: string) => createHash('sha256').update(`current:${feature}`).digest().readUInt32BE() % buckets;
  const ids: number[] = [];
  for (const size of [2, 3, 4]) {
    for (let index = 0; index + size <= chars.length; index++) ids.push(id(`c${size}:${chars.slice(index, index + size).join('')}`));
  }
  for (const word of folded.replace(/^[\^$]+|[\^$]+$/gu, '').split(' ').filter(Boolean)) ids.push(id(`w:${word}`));
  if (ids.length > maxFeatures) throw new ModelRuntimeError('invalid-input');
  return ids;
}

async function readBytes(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > maximum) throw new ModelRuntimeError('incompatible', 'Invalid context router artifact size');
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw new ModelRuntimeError('incompatible', 'Context router artifact size changed');
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}

function layoutOf(header: z.infer<typeof headerSchema>) {
  const { buckets, dim, hidden } = header.config;
  const sizes: readonly [name: string, shape: readonly number[]][] = [
    ['embedding.weight', [buckets, dim]],
    ['projection.weight', [hidden, dim + contextFeatures.length]],
    ['projection.bias', [hidden]],
    ['classifier.weight', [routes.length, hidden]],
    ['classifier.bias', [routes.length]],
  ];
  let end = 0;
  const offsets = sizes.map(([name, shape], index) => {
    const field = header.layout[index];
    const length = shape.reduce((product, dimension) => product * dimension, Float32Array.BYTES_PER_ELEMENT);
    if (field.name !== name || field.offsetBytes !== end || field.lengthBytes !== length
      || field.shape.length !== shape.length || field.shape.some((value, axis) => value !== shape[axis])) {
      throw new ModelRuntimeError('incompatible', 'Invalid context router weight layout');
    }
    const offset = end;
    end += length;
    return offset;
  });
  return { offsets, size: end };
}

/** Runs just the exported classifier. The application's own pending-reply and public search guards keep authority. */
async function loadContextRouter(model: ResolvedModel): Promise<ModelAdapter> {
  const metadataBytes = 16 * 1_024;
  const [manifest, calibrationBytes] = await Promise.all([
    readBytes(requiredArtifact(model, 'manifest').path, metadataBytes),
    readBytes(requiredArtifact(model, 'calibration').path, metadataBytes),
  ]);
  const header = headerSchema.safeParse(JSON.parse(manifest.toString('utf8')));
  const calibration = calibrationSchema.safeParse(JSON.parse(calibrationBytes.toString('utf8')));
  if (!header.success || !calibration.success || header.data.withContext !== (model.entry.id === 'router-context-history')) {
    throw new ModelRuntimeError('incompatible', 'Invalid context router metadata');
  }
  const { offsets: [embedding, projection, projectionBias, classifier, classifierBias], size } = layoutOf(header.data);
  const bytes = await readBytes(requiredArtifact(model, 'weights').path, size);
  if (bytes.length !== size || createHash('sha256').update(bytes).digest('hex') !== header.data.sha256) {
    throw new ModelRuntimeError('incompatible', 'Context router weight SHA-256 mismatch');
  }
  const { buckets, dim, hidden } = header.data.config;
  const { withContext } = header.data;
  const { temperature, threshold } = calibration.data;
  const weight = (offset: number, index: number) => bytes.readFloatLE(offset + Float32Array.BYTES_PER_ELEMENT * index);
  return {
    health: () => true,
    run(value, signal) {
      signal.throwIfAborted();
      const input = inputAs(routerInput, value);
      const ids = featureIds(input.text, buckets);
      const features = new Float64Array(dim + contextFeatures.length);
      for (const id of ids) for (let d = 0; d < dim; d++) features[d] += weight(embedding, id * dim + d);
      for (let d = 0; d < dim; d++) features[d] /= ids.length;
      if (withContext) {
        const active = new Set([`prior_route:${input.previousRoute}`, `source:${input.source}`, `scope:${input.scope}`,
          `pending:${input.pendingReply}`, `field:${input.requestedField}`]);
        contextFeatures.forEach((feature, index) => { features[dim + index] = Number(active.has(feature)); });
      }
      const projected = Array.from({ length: hidden }, (_, row) => {
        let sum = weight(projectionBias, row);
        for (let d = 0; d < features.length; d++) sum += features[d] * weight(projection, row * features.length + d);
        return Math.max(0, sum);
      });
      const logits = routes.map((_, row) => {
        let sum = weight(classifierBias, row);
        for (let d = 0; d < hidden; d++) sum += projected[d] * weight(classifier, row * hidden + d);
        return sum;
      });
      const top = Math.max(...logits);
      if (!Number.isFinite(top)) throw new ModelRuntimeError('incompatible', 'Nonfinite context router logits');
      const confidence = Math.fround(1 / logits.reduce((total, logit) => total + Math.exp((logit - top) / temperature), 0));
      return { route: routes[logits.indexOf(top)], confidence, abstained: confidence < threshold };
    },
  };
}

const b1Text = z.object({ text: z.string().min(1).max(8_000) }).strict();
const b1Result = z.object({ route: z.union([z.enum(routes), z.literal('reply')]), confidence: z.number().min(0).max(1) });

async function loadB1Router(model: ResolvedModel, context: ModelAdapterContext): Promise<ModelAdapter> {
  const checkpoint = requiredArtifact(model, 'checkpoint');
  if (!checkpoint.sha256) throw new ModelRuntimeError('incompatible', 'Historical router checkpoint digest is unavailable');
  const windows = process.platform === 'win32';
  const executable = resolve(context.root, context.env.EXECUTOR_PYTHON?.trim()
    || (windows ? '.venv-execution/Scripts/python.exe' : '.venv-execution/bin/python'));
  await access(executable).catch(() => { throw new ModelRuntimeError('unhealthy', 'The local Python runtime is unavailable'); });
  context.signal.throwIfAborted();
  const checkpointId = `sha256:${checkpoint.sha256}`;
  let observer: ((status: PermanentModelWorkerStatus) => void) | undefined;
  const system = windows ? context.env.SystemRoot : undefined;
  const worker = new PermanentModelWorker({
    executable,
    args: ['-I', '-B', resolve(context.root, 'packages/model-relations/src/council-b1-worker.py'),
      checkpoint.path, checkpoint.sha256, String(process.pid), String(context.memoryBudgetMiB * 1024 * 1024)],
    cwd: context.root,
    environment: system ? { SystemRoot: system, PATH: [dirname(executable), join(system, 'System32'), system].join(delimiter) } : {},
    identity: { modelId: model.entry.id, tokenizerId: checkpointId, checkpointId }, startupTimeoutMs: context.startupMs,
    onState: status => observer?.(status),
  });
  const ready = () => worker.status.state === 'ready' && worker.status.ready.device === 'cpu'
    && worker.status.ready.heads.route === 'classify';
  return {
    warmup: signal => new Promise<void>((accept, reject) => {
      const settle = (error?: ModelRuntimeError) => {
        observer = undefined;
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else accept();
      };
      const abort = () => settle(new ModelRuntimeError('timeout'));
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      observer = status => {
        if (status.state === 'ready') settle(ready() ? undefined : new ModelRuntimeError('incompatible'));
        if (status.state === 'degraded') settle(new ModelRuntimeError(status.code === 'timeout' ? 'timeout'
          : status.code === 'checkpoint_pin_mismatch' || status.code === 'invalid_checkpoint' ? 'incompatible' : 'unhealthy', status.code));
      };
      worker.start();
    }),
    health: ready,
    run: async (input, signal, timeoutMs) => {
      const payload = inputAs(b1Text, input);
      try {
        const raw = await worker.request({ head: 'route', operation: 'classify', input: payload, signal, timeoutMs });
        const result = b1Result.safeParse(raw);
        if (!result.success) throw new ModelRuntimeError('incompatible', 'Invalid historical router prediction');
        return result.data;
      } catch (error) {
        if (error instanceof ModelTransportError && (error.code === 'timeout' || error.code === 'invalid_request')) {
          throw new ModelRuntimeError(error.code === 'timeout' ? 'timeout' : 'invalid-input');
        }
        throw error;
      }
    },
    close: () => worker.stop(),
  };
}

export async function loadCouncilRouterAdapter(model: ResolvedModel, context: ModelAdapterContext): Promise<ModelAdapter> {
  return model.entry.id === 'router-b1' ? loadB1Router(model, context) : loadContextRouter(model);
}
