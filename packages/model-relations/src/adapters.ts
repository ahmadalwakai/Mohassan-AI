import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { ResolvedModel } from './registry.js';
import { ModelRuntimeError, type ModelAdapter, type ModelAdapterContext } from './runtime.js';
import {
  isRecord, loadMonitorDecisionHead, monitorArtifactSha256, monitorDecisionModelId, MonitorDecisionPromotion, readMonitorArtifact,
} from './monitor-decision.js';

const textInput = z.object({ text: z.string().min(1).max(8_000) }).strict();
const scratchInput = textInput.extend({ previousText: z.string().max(8_000).optional(), topK: z.number().int().min(0).max(16).optional() });
const localPath = z.object({ path: z.string().min(1).max(4_096) }).strict();

export function inputAs<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ModelRuntimeError('invalid-input');
  return result.data;
}

export function modelArtifact(model: ResolvedModel, role: string) {
  return model.artifacts.find(item => item.role === role && item.present);
}

export function requiredArtifact(model: ResolvedModel, role: string) {
  const artifact = modelArtifact(model, role);
  if (!artifact) throw new ModelRuntimeError('absent', `Missing ${role}`);
  return artifact;
}

function withText(run: (text: string) => unknown, probe?: string): ModelAdapter {
  return {
    warmup: () => { if (probe) run(probe); },
    health: () => true,
    run: input => run(inputAs(textInput, input).text),
  };
}

const probe = 'What time is it?';
const scratchHeads = { 'scratch-route': 'route', 'scratch-speech-act': 'speechAct', 'scratch-refusal': 'refusal', 'scratch-follow-up': 'followUp' } as const;

async function loadScratch(model: ResolvedModel, head: typeof scratchHeads[keyof typeof scratchHeads]): Promise<ModelAdapter> {
  const { loadScratchClassifiers, ScratchClassifierPinMismatch } = await import('../../scratch-classifiers/src/index.js');
  const directory = dirname(requiredArtifact(model, 'manifest').path);
  try {
    const classifier = loadScratchClassifiers(pathToFileURL(directory + sep));
    return {
      warmup: () => { classifier.predict(head, probe); },
      health: () => true,
      run: input => {
        const { text, ...options } = inputAs(scratchInput, input);
        return classifier.predict(head, text, options);
      },
    };
  } catch (error) {
    if (error instanceof ScratchClassifierPinMismatch) throw new ModelRuntimeError('unhealthy', undefined, 'pin-mismatch');
    throw error;
  }
}

async function loadMonitorHead(model: ResolvedModel): Promise<ModelAdapter> {
  const manifestPin = requiredArtifact(model, 'manifest');
  const weightsPin = requiredArtifact(model, 'weights');
  const manifest: unknown = JSON.parse((await readMonitorArtifact(manifestPin.path)).toString('utf8'));
  const weights = await readMonitorArtifact(weightsPin.path);
  const weightsSha256 = monitorArtifactSha256(weights);
  if (!isRecord(manifest) || manifest.trainingSource !== 'human' || manifest.weightsSha256 !== weightsSha256
    || weightsPin.matchesPin !== true || weightsPin.sha256 !== weightsSha256) {
    throw new ModelRuntimeError('incompatible', 'Unverified monitor head training manifest');
  }
  const head = loadMonitorDecisionHead(JSON.parse(weights.toString('utf8')));
  const promotionPath = modelArtifact(model, 'promotion')?.path;
  const promotion = promotionPath ? await readMonitorArtifact(promotionPath)
    .then(content => MonitorDecisionPromotion.fromArtifact(JSON.parse(content.toString('utf8')), weightsSha256))
    .catch(() => undefined) : undefined;
  return {
    health: () => true,
    run: input => {
      try {
        return { ...head.predict(input), ...(promotion ? { promotion } : {}) };
      } catch {
        throw new ModelRuntimeError('invalid-input');
      }
    },
  };
}

async function readImageInput(path: string): Promise<Uint8Array> {
  try {
    const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size < 1 || info.size > 16 * 1024 * 1024) throw new ModelRuntimeError('invalid-input');
      const buffer = Buffer.alloc(info.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== info.size) throw new ModelRuntimeError('invalid-input');
      return buffer.subarray(0, offset);
    } finally {
      await file.close();
    }
  } catch {
    throw new ModelRuntimeError('invalid-input', 'Unreadable or oversized local image');
  }
}

async function loadOcr(model: ResolvedModel, context: ModelAdapterContext): Promise<ModelAdapter> {
  const { createOcrPool, loadOcrModelFromBytes, readImage } = await import('../../vision/src/index.js');
  const { ImageDecodeError } = await import('../../vision/src/image.js');
  const [manifestBytes, weightsBytes] = await Promise.all([
    readFile(requiredArtifact(model, 'manifest').path), readFile(requiredArtifact(model, 'weights').path),
  ]);
  const ocr = loadOcrModelFromBytes(manifestBytes, weightsBytes);
  const pool = createOcrPool({ manifestBytes, weightsBytes, size: 1, timeoutMs: model.entry.resources.latencyMs, startupTimeoutMs: context.startupMs });
  return {
    warmup: async signal => {
      if (!await pool.ready()) throw new ModelRuntimeError('unhealthy');
      await pool.recognize([{ width: 32, pixels: new Uint8Array(32 * 32).fill(255) }], signal);
    },
    health: () => pool.ready(),
    run: async (input, signal) => {
      const path = inputAs(localPath, input).path;
      const bytes = await readImageInput(resolve(context.root, path));
      try {
        return await readImage(bytes, { model: ocr, signal, recognize: crops => pool.recognize(crops, signal) });
      } catch (error) {
        if (error instanceof ImageDecodeError) throw new ModelRuntimeError('invalid-input');
        throw error;
      }
    },
    close: () => pool.close(),
  };
}

async function loadSlot(model: ResolvedModel, datePlace: boolean): Promise<ModelAdapter> {
  const [manifest, weights] = await Promise.all([
    readFile(requiredArtifact(model, 'manifest').path), readFile(requiredArtifact(model, 'weights').path),
  ]);
  if (datePlace) {
    const { loadDatePlaceSlotTagger } = await import('../../../apps/server/src/assistant/slot-date-place-tagger.js');
    const expectedModelId = model.entry.modelIdentity;
    if (!expectedModelId) throw new ModelRuntimeError('unsupported', 'A trusted date/place model identity is required');
    const tagger = loadDatePlaceSlotTagger(manifest, weights, { expectedModelId, cacheEmbeddings: false });
    return withText(text => tagger.infer(text), probe);
  }
  const { loadSlotTagger } = await import('../../../apps/server/src/assistant/slot-tagger.js');
  const tagger = loadSlotTagger(manifest, weights, { cacheEmbeddings: false, expectedModelId: model.entry.modelIdentity });
  return withText(text => tagger.infer(text), probe);
}

export async function loadModelAdapter(model: ResolvedModel, context: ModelAdapterContext): Promise<ModelAdapter> {
  const { id } = model.entry;
  if (Object.hasOwn(scratchHeads, id)) return loadScratch(model, scratchHeads[id as keyof typeof scratchHeads]);
  switch (id) {
    case monitorDecisionModelId: return loadMonitorHead(model);
    case 'refusal': {
      const { classifyLearnedRefusal, scoreLearnedRefusal } = await import('../../../apps/server/src/assistant/refusal/learned-classifier.js');
      return withText(text => {
        const score = scoreLearnedRefusal(text);
        return { ...score, abstained: score.label !== 'allow' && classifyLearnedRefusal(text) === null };
      }, probe);
    }
    case 'router-b0':
    case 'router-b2': {
      const { loadRouterModel, loadRouterB2Model, routeWithModel } = await import('../../../apps/server/src/assistant/router.js');
      const directory = dirname(requiredArtifact(model, 'manifest').path);
      const router = await (id === 'router-b0' ? loadRouterModel(directory) : loadRouterB2Model(directory));
      return withText(text => routeWithModel(router, text), probe);
    }
    case 'arithmetic': {
      const { createArithmeticAdapter } = await import('./arithmetic-runtime.js');
      return createArithmeticAdapter();
    }
    case 'ocr':
    case 'ocr-v2':
    case 'ocr-base': return loadOcr(model, context);
    case 'slot-tagger': return loadSlot(model, false);
    case 'slot-date-place-tagger': return loadSlot(model, true);
    default: {
      if (id === 'router-context-text' || id === 'router-context-history') {
        throw new ModelRuntimeError('unsupported', 'This offline router architecture has no runtime export');
      }
      if (model.entry.runtime === 'node-cpu' || (!model.entry.workerHead && id !== 'execution' && !id.startsWith('execution-'))) {
        throw new ModelRuntimeError('unsupported', 'This experiment uses its native runner');
      }
      const { loadWorkerAdapter } = await import('./worker-adapter.js');
      return loadWorkerAdapter(model, context);
    }
  }
}
