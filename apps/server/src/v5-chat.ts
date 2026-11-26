import { randomInt } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { redactSecrets } from '@mohassan/providers';
import type { FastifyInstance } from 'fastify';
import { ModelTransportError } from '../../../packages/execution-integration/src/transport.js';
import { getServerModelWorker } from './model-worker.js';
import { recordV5ChatMetrics } from './ops/metrics/index.js';

export const V5_CHAT_LABEL = '— نموذج v5 تجريبي (لم يجتز اختبار الجودة)';

const head = 'chat-v5';
const identity = {
  modelId: 'mohassan-chat-v5',
  checkpointId: 'sha256:246983b5a42a9a14de7379c6da7f74a599c3131d58c848ed4b5ad0922aa14c39',
  tokenizerId: 'sha256:297eaad3d1cd08b822fa1b7f215112633873d1603b83846dbf5bf7c48b49cbb7',
};
const maxNewTokens = 192;
const totalTimeoutMs = 60_000;
const maxWaiting = 2;

type ChatMessage = { role: 'user' | 'assistant'; content: string };
type Slot = 'ready' | 'timeout' | 'unavailable';
type Queue = { active: boolean; waiting: Array<() => void> };
const queues = new WeakMap<FastifyInstance, Queue>();

function readyWorker(app: FastifyInstance) {
  const worker = getServerModelWorker(app);
  const status = worker?.status;
  if (!worker || status?.state !== 'ready') return;
  const { ready } = status;
  if (ready.text !== true || ready.heads[head] !== 'generate' || ready.device !== 'cpu'
    || ready.identity.modelId !== identity.modelId || ready.identity.checkpointId !== identity.checkpointId
    || ready.identity.tokenizerId !== identity.tokenizerId || ready.limits.maxOutputTokens < maxNewTokens) return;
  return { worker, limits: ready.limits };
}

export function isV5ChatReady(app: FastifyInstance): boolean {
  return readyWorker(app) !== undefined;
}

async function acquire(queue: Queue, deadline: number, signal?: AbortSignal): Promise<Slot> {
  if (signal?.aborted) return 'unavailable';
  if (!queue.active) {
    queue.active = true;
    return 'ready';
  }
  if (queue.waiting.length >= maxWaiting) return 'unavailable';
  return new Promise(resolve => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const start = () => { cleanup(); resolve('ready'); };
    const remove = (outcome: Slot) => {
      queue.waiting.splice(queue.waiting.indexOf(start), 1);
      cleanup();
      resolve(outcome);
    };
    const abort = () => remove('unavailable');
    const timer = setTimeout(() => remove('timeout'), Math.max(0, Math.ceil(deadline - performance.now())));
    queue.waiting.push(start);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

// Generated prose carries no execution receipt. Withhold direct completion claims.
const englishAction = /\b(?:i|we)(?:\s+(?:have|already|just|successfully)|['’]ve){0,4}\s+(?:sent|e-?mailed|forwarded|posted|published|deployed|uploaded|downloaded|submitted|saved|deleted|scheduled|booked|installed|clicked|executed|ran|opened|closed|created|updated|changed|cancelled|canceled|completed|ordered|bought)\b|\b(?:done|completed)\s*[.!]?\s*$/iu;
const englishReceipt = /\b(?:file|document|e-?mail|message|post|website|site|order|request|alert|monitor|reminder|campaign)\s+(?:(?:has been|was|is)\s+)?(?:sent|saved|deleted|published|placed|created|updated|scheduled|cancelled|canceled)\b/iu;
const arabicAction = /(?:^|[^\p{L}])(?:[وف]?(?:ارسلت|حفظت|نشرت|رفعت|حملت|حذفت|جدولت|حجزت|ثبتت|نفذت|فتحت|اغلقت|انشات|حدثت|عدلت|لغيت|اكملت|اشتريت|ضغطت)|[وف]?(?:تم\s+(?:ال)?|قمت\s+ب(?:ال)?)(?:ارسال|حفظ|نشر|رفع|تحميل|حذف|جدولة|حجز|تثبيت|تنفيذ|فتح|اغلاق|انشاء|تحديث|تعديل|الغاء|شراء))(?=$|[^\p{L}])/u;

function actionClaim(text: string): boolean {
  const arabic = text.replace(/[\p{M}\p{Cf}ـ]/gu, '').replace(/[أإآٱ]/gu, 'ا');
  return englishAction.test(text) || englishReceipt.test(text) || arabicAction.test(arabic);
}

function fitTransport(messages: readonly ChatMessage[], maxInputBytes: number): ChatMessage[] {
  // Reserve space for the request envelope, ID, decoding fields, and line ending.
  let remaining = maxInputBytes - 512;
  const selected: ChatMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const { role, content } = messages[index];
    const message = { role, content };
    remaining -= Buffer.byteLength(JSON.stringify(message)) + 1;
    if (remaining < 0) break;
    selected.push(message);
  }
  return selected.reverse();
}

export async function generateV5ChatReply(
  app: FastifyInstance, messages: readonly ChatMessage[], signal?: AbortSignal,
): Promise<string | undefined> {
  const started = performance.now();
  const deadline = started + totalTimeoutMs;
  if (!isV5ChatReady(app) || messages.at(-1)?.role !== 'user') {
    recordV5ChatMetrics(app, { fallback: true });
    return;
  }
  let queue = queues.get(app);
  if (!queue) {
    queue = { active: false, waiting: [] };
    queues.set(app, queue);
  }
  const slot = await acquire(queue, deadline, signal);
  if (slot !== 'ready') {
    recordV5ChatMetrics(app, { fallback: true, ...(slot === 'timeout' && { timeout: true, latencyMs: performance.now() - started }) });
    return;
  }

  let generation = false;
  let timeout = false;
  let loopCut = false;
  let stopReason: 'eos' | 'length' | undefined;
  let reply: string | undefined;
  try {
    const ready = readyWorker(app);
    if (!ready || signal?.aborted) return;
    const inputMessages = fitTransport(messages, ready.limits.maxInputBytes);
    if (!inputMessages.length) return;
    const remainingMs = Math.floor(deadline - performance.now());
    if (remainingMs < 1) { timeout = true; return; }
    generation = true;
    const result = await ready.worker.request({
      operation: 'generate', head, signal,
      timeoutMs: Math.min(remainingMs, ready.limits.maxTimeoutMs),
      input: {
        messages: inputMessages,
        temperature: 0.7, topP: 0.9, topK: 0, maxNewTokens, seed: randomInt(2 ** 47),
      },
    });
    if (performance.now() >= deadline) { timeout = true; return; }
    if (result.stopReason === 'eos' || result.stopReason === 'length') stopReason = result.stopReason;
    loopCut = result.loopCut === true;
    const text = typeof result.text === 'string' ? redactSecrets(result.text.trim()) : '';
    if (!signal?.aborted && stopReason && text && !actionClaim(text) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\uFFFD]/u.test(text)) reply = text;
    return reply;
  } catch (error) {
    timeout = error instanceof ModelTransportError && error.code === 'timeout';
  } finally {
    const next = queue.waiting.shift();
    if (next) next();
    else queue.active = false;
    recordV5ChatMetrics(app, {
      generation, stopReason, loopCut, timeout, fallback: reply === undefined,
      ...((generation || timeout) && { latencyMs: performance.now() - started }),
    });
  }
}
