import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ModelListSchema, ModelRunRequestSchema, ModelRunResponseSchema, type ModelInfo, type ModelInputKind, type ModelRunResponse, type ModelUse } from '@mohassan/contracts';
import { modelRegistry, resolveModelInRoots, type ModelEntry } from '../../../packages/model-relations/src/registry.js';
import type { ModelRunResult } from '../../../packages/model-relations/src/runtime.js';
import { readerPrompt } from './assistant/model-council.js';

/**
 * The owner's models page: lists every registered model with where it is used, and runs one on the owner's input.
 * Owner only: the routes are not in MEMBER_ROUTES, and each handler checks the owner role again.
 */

const OCR = new Set(['ocr', 'ocr-base', 'ocr-v2']);
const GENERATION = new Set(['chat-v5', 'chat-v4', 'google-ads-pointer-lm', 'ads-code-foundation', 'ads-bilingual-code-v1', 'ads-bilingual-code-v2']);
const READING = new Set(['reading-v3-last', 'reading-v4-hn-last']);
/** Asked by the council: the organizer's stage models (understanding) and the council's answering models. */
const COUNCIL = new Set(['chat-v5', 'chat-v4', 'reading-v3-last', 'arithmetic', 'refusal', 'scratch-refusal', 'scratch-speech-act',
  'scratch-route', 'scratch-follow-up', 'router-b0', 'router-b2', 'question-edit', 'head-sufficiency', 'head-answer-sentence']);
const MEASURED: Record<string, string> = {
  'chat-v5': 'لم يجتز Gate 3 (0 من 20 بكل لغة)',
  'chat-v4': 'لم يجتز اختبار الاستمرار الدلالي',
  'reading-v3-last': 'F1 ‏18٪ بالعربية و26٪ بالإنجليزية على XQuAD',
  ocr: 'صفحات مواقع لم يرها: 0.940 و0.802',
  'router-b0': '72.1٪ مقابل 45.9٪ للقواعد على المجموعة المختومة',
};
const MAX_OUTPUT = 20_000;

export interface ModelsRoutesOptions {
  owner(request: { headers: Record<string, unknown> }): Promise<{ id: string }>;
  isOwner(userId: string): Promise<boolean>;
  runner: { run(modelId: string, input: unknown): Promise<ModelRunResult> };
  /** The model store and the checkout, in lookup order (registry.ts modelRoots). */
  roots: readonly string[];
  /** The resident v5 worker: chat-v5 runs there, never in a second process. */
  v5?: (text: string, signal: AbortSignal) => Promise<string | undefined>;
  imageReaderLive: boolean;
  v5Live: boolean;
  councilLive: boolean;
}

export function inputOf(entry: ModelEntry): { input: ModelInputKind; unavailable?: string } {
  if (OCR.has(entry.id)) return { input: 'image' };
  if (GENERATION.has(entry.id)) return { input: 'text' };
  if (READING.has(entry.id)) return { input: 'reading' };
  if (entry.id.startsWith('execution')) return { input: 'none', unavailable: 'يحتاج صيغة مهام المنفّذ المحلي، والمنفّذ مقفل في الإنتاج.' };
  if (entry.id === 'monitor-context-head') return { input: 'none', unavailable: 'يحتاج خصائص المحادثة الرقمية، لا نصاً.' };
  if (entry.id === 'router-context-text' || entry.id === 'router-context-history') return { input: 'none', unavailable: 'تجربة بلا تصدير للتشغيل.' };
  if (entry.runtime === 'node-cpu' || entry.workerHead) return { input: 'text' };
  return { input: 'none', unavailable: 'يحتاج مشغّله الخاص خارج مشغّل النماذج.' };
}

function readable(id: string, output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return typeof output === 'string' ? output : undefined;
  const value = output as Record<string, unknown>;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.label === 'string') return value.label;
  if (typeof value.route === 'string') return value.route;
  if (typeof value.value === 'string') return `${typeof value.expression === 'string' ? `${value.expression} = ` : ''}${value.value}`;
  if (OCR.has(id) && Array.isArray(value.lines)) {
    return value.lines.map(line => line && typeof line === 'object' && typeof (line as { text?: unknown }).text === 'string' ? (line as { text: string }).text : '')
      .filter(Boolean).join('\n');
  }
  return undefined;
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export async function listModels(options: Pick<ModelsRoutesOptions, 'roots' | 'imageReaderLive' | 'v5Live' | 'councilLive'>): Promise<ModelInfo[]> {
  return Promise.all(modelRegistry.map(async entry => {
    const resolved = await resolveModelInRoots(entry, options.roots, process.env, false);
    const { input, unavailable } = inputOf(entry);
    const present = resolved.state !== 'absent';
    const uses: ModelUse[] = [];
    if ((entry.id === 'ocr' && options.imageReaderLive) || (entry.id === 'chat-v5' && options.v5Live)) uses.push('chat');
    if (options.councilLive && COUNCIL.has(entry.id) && present) uses.push('council');
    if (present && input !== 'none') uses.push('page');
    return {
      id: entry.id, version: entry.version, task: entry.task.slice(0, 240), runtime: entry.runtime, present, input,
      ...(unavailable ? { unavailable } : !present ? { unavailable: 'ملفاته غير موجودة على هذا الخادم (لم يُدرَّب أو لم يُرفع).' } : {}),
      gates: entry.gates.map(gate => gate.name.slice(0, 240)).slice(0, 8),
      ...(MEASURED[entry.id] ? { measured: MEASURED[entry.id] } : {}),
      uses,
    } satisfies ModelInfo;
  }));
}

export async function registerModelsRoutes(app: FastifyInstance, options: ModelsRoutesOptions): Promise<void> {
  const ownerOnly = async (request: { headers: Record<string, unknown> }) => {
    const user = await options.owner(request);
    if (!await options.isOwner(user.id)) throw Object.assign(new Error('هذه الخدمة غير متاحة لحسابك.'), { statusCode: 403, code: 'MEMBER_FORBIDDEN' });
    return user;
  };

  app.get('/api/models', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async request => {
    await ownerOnly(request);
    return ModelListSchema.parse({ models: await listModels(options), council: options.councilLive });
  });

  app.post<{ Params: { id: string } }>('/api/models/:id/run', {
    bodyLimit: 7_600_000, config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    await ownerOnly(request);
    const id = z.string().regex(/^[a-z0-9-]{2,64}$/u).parse(request.params.id);
    const entry = modelRegistry.find(item => item.id === id);
    if (!entry) return reply.code(404).send({ error: { code: 'MODEL_UNKNOWN', message: 'لا يوجد نموذج بهذا المعرّف.' } });
    const body = ModelRunRequestSchema.parse(request.body ?? {});
    const { input, unavailable } = inputOf(entry);
    if (input === 'none') return reply.code(409).send({ error: { code: 'MODEL_NOT_RUNNABLE', message: unavailable ?? 'لا يمكن تشغيله من هذه الصفحة.' } });
    const started = performance.now();
    const respond = (result: ModelRunResult | { ok: true; output: unknown; elapsedMs: number }): ModelRunResponse => {
      const elapsedMs = Math.max(0, Math.round(result.elapsedMs ?? performance.now() - started));
      if (!result.ok) return ModelRunResponseSchema.parse({ ok: false, elapsedMs, reason: result.reason, ...(result.detail ? { detail: shorten(result.detail, 300) } : {}) });
      const text = readable(id, result.output);
      return ModelRunResponseSchema.parse({ ok: true, elapsedMs, output: shorten(JSON.stringify(result.output, null, 2) ?? 'null', MAX_OUTPUT),
        ...(text ? { text: shorten(text, 4_000) } : {}) });
    };

    if (input === 'image') {
      if (!body.image) return reply.code(400).send({ error: { code: 'MODEL_INPUT', message: 'أرفق صورة PNG أو JPEG أو WebP.' } });
      const directory = await mkdtemp(join(tmpdir(), 'mohassan-model-page-'));
      try {
        const extension = body.image.mimeType === 'image/png' ? 'png' : body.image.mimeType === 'image/jpeg' ? 'jpg' : 'webp';
        const path = join(directory, `input.${extension}`);
        await writeFile(path, Buffer.from(body.image.data, 'base64'), { mode: 0o600 });
        return respond(await options.runner.run(id, { path }));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    if (!body.text) return reply.code(400).send({ error: { code: 'MODEL_INPUT', message: 'اكتب نصاً للنموذج.' } });
    if (input === 'reading') {
      if (!body.passage) return reply.code(400).send({ error: { code: 'MODEL_INPUT', message: 'نموذج القراءة يحتاج فقرة وسؤالاً.' } });
      return respond(await options.runner.run(id, { prompt: readerPrompt(body.text, body.passage), maxNewTokens: 20 }));
    }
    if (id === 'chat-v5' && options.v5) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      try {
        const text = await options.v5(body.text, controller.signal);
        return text === undefined
          ? respond({ ok: false, reason: 'unhealthy', elapsedMs: performance.now() - started, detail: 'عامل v5 غير جاهز أو انتهى الوقت.' })
          : respond({ ok: true, output: { text }, elapsedMs: performance.now() - started });
      } finally {
        clearTimeout(timer);
      }
    }
    return respond(await options.runner.run(id, GENERATION.has(id) ? { text: body.text, maxNewTokens: 64 } : { text: body.text }));
  });
}
