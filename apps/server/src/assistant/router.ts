import { createHash } from 'node:crypto';
import { appendFile, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { directRoute } from './brain.js';
import { notWebReason, parseHands, tidy, webQuestion } from './hands.js';

/**
 * Mohassan's own request router (docs/ROUTER-MODEL-PLAN-2026-11-20.md).
 * B0: hashed character/word n-grams averaged into a vector, then one linear layer, trained from scratch in
 * scripts/router/train.py and exported by scripts/router/export.py. This file repeats the same math in TypeScript.
 * Today it runs only in shadow: the rules still decide, and both choices are logged side by side.
 */
export const ROUTES = ['web_search', 'browser_command', 'news', 'memory', 'reminder', 'compute', 'ads', 'pc', 'writing', 'chat', 'reply',
  'image', 'media', 'unsupported'] as const;
export type Route = typeof ROUTES[number];
const MAX_ROUTER_TEXT = 8000;
const MAX_MODEL_BYTES = 128 * 1024 * 1024;
const RouterHeader = z.object({
  kind: z.literal('b0'), buckets: z.number().int().min(1).max(1 << 20), dim: z.number().int().min(1).max(512),
  routes: z.array(z.enum(ROUTES)).length(ROUTES.length).refine(routes => routes.every((route, index) => route === ROUTES[index])),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Read a bounded immutable export; a growing or oversized file is rejected. */
async function readRouterBytes(file: string, limit: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    if (!Number.isSafeInteger(size) || size < 0 || size > limit) throw new Error('ROUTER_MODEL_SIZE_MISMATCH');
    const buffer = Buffer.alloc(size + 1);
    let at = 0;
    while (at < buffer.length) {
      const { bytesRead } = await handle.read(buffer, at, buffer.length - at, at);
      if (!bytesRead) break;
      at += bytesRead;
    }
    if (at !== size) throw new Error('ROUTER_MODEL_SIZE_MISMATCH');
    return buffer.subarray(0, at);
  } finally { await handle.close(); }
}

/** The same folding as train.py `fold`: marks and tatweel removed, letter forms unified, digits Latin, lower case. */
export function foldForRouter(text: string): string {
  return text.normalize('NFC')
    .replace(/[\u0640\u064b-\u065f\u0670]/gu, '')
    .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه')
    .replace(/[٠-٩]/gu, digit => String(digit.charCodeAt(0) - 0x0660))
    .toLowerCase().replace(/\s+/gu, ' ').trim();
}

const stable = (text: string) => parseInt(createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8), 16);

/** The bucket ids train.py `ngram_ids` produces: character 2-, 3- and 4-grams of «^text$», then whole words. */
export function ngramIds(text: string, buckets: number): number[] {
  if (typeof text !== 'string' || text.length > MAX_ROUTER_TEXT) throw new Error('ROUTER_REQUEST_TOO_LARGE');
  if (!Number.isSafeInteger(buckets) || buckets < 1 || buckets > 1 << 20) throw new Error('ROUTER_MODEL_HEADER_INVALID');
  const chars = Array.from(`^${foldForRouter(text)}$`);
  const ids: number[] = [];
  for (const size of [2, 3, 4]) for (let at = 0; at + size <= chars.length; at++) ids.push(stable(`c${size}:${chars.slice(at, at + size).join('')}`) % buckets);
  const inner = chars.join('').replace(/^[\^$]+|[\^$]+$/gu, '');
  for (const word of inner.split(/\s+/u).filter(Boolean)) ids.push(stable(`w:${word}`) % buckets);
  return ids.length ? ids : [0];
}

export interface RouterModel { buckets: number; dim: number; routes: readonly string[]; embedding: Float32Array; weight: Float32Array; bias: Float32Array }

export function routerLogits(model: RouterModel, text: string): number[] {
  const ids = ngramIds(text, model.buckets), mean = new Float64Array(model.dim);
  for (const id of ids) for (let d = 0, base = id * model.dim; d < model.dim; d++) mean[d] += model.embedding[base + d];
  for (let d = 0; d < model.dim; d++) mean[d] /= ids.length;
  return model.routes.map((_, row) => {
    let sum = model.bias[row];
    for (let d = 0, base = row * model.dim; d < model.dim; d++) sum += model.weight[base + d] * mean[d];
    return sum;
  });
}

export interface ShadowRouteCandidate { route: string; score: number }

export function rankRouterModelRoutes(model: RouterModel, text: string): ShadowRouteCandidate[] {
  const logits = routerLogits(model, text), top = Math.max(...logits);
  if (!logits.length || !logits.every(Number.isFinite)) throw new Error('ROUTER_MODEL_NONFINITE');
  const exps = logits.map(value => Math.exp(value - top)), total = exps.reduce((a, b) => a + b, 0);
  return model.routes.map((route, index) => ({ route, score: exps[index] / total })).sort((a, b) => b.score - a.score);
}

export function routeWithModel(model: RouterModel, text: string): { route: string; confidence: number } {
  const [best] = rankRouterModelRoutes(model, text);
  return { route: best.route, confidence: best.score };
}

/** Loads router-b0.bin and checks it against the sha256 in its JSON header. */
export async function loadRouterModel(dir: string): Promise<RouterModel> {
  const metadata = await readRouterBytes(path.join(dir, 'router-b0.json'), 16 * 1024);
  let header: z.infer<typeof RouterHeader>;
  try { header = RouterHeader.parse(JSON.parse(metadata.toString('utf8'))); }
  catch { throw new Error('ROUTER_MODEL_HEADER_INVALID'); }
  const embedded = header.buckets * header.dim, weights = header.routes.length * header.dim;
  const expectedBytes = (embedded + weights + header.routes.length) * Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes > MAX_MODEL_BYTES) throw new Error('ROUTER_MODEL_SIZE_MISMATCH');
  const bytes = await readRouterBytes(path.join(dir, 'router-b0.bin'), expectedBytes);
  if (bytes.byteLength !== expectedBytes) throw new Error('ROUTER_MODEL_SIZE_MISMATCH');
  if (createHash('sha256').update(bytes).digest('hex') !== header.sha256) throw new Error('ROUTER_MODEL_HASH_MISMATCH');
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  if (!floats.every(Number.isFinite)) throw new Error('ROUTER_MODEL_NONFINITE');
  return { buckets: header.buckets, dim: header.dim, routes: header.routes,
    embedding: floats.subarray(0, embedded), weight: floats.subarray(embedded, embedded + weights), bias: floats.subarray(embedded + weights) };
}

/**
 * Rules v0 as one route: what today's hand-written code would pick, without any model.
 * `memory_ads_pc` is one rule bucket; the rules cannot tell those three apart.
 */
export function rulesRoute(text: string, previous: string | null): string {
  const steps = parseHands(text);
  if (steps) return steps.some(step => step.kind === 'news') ? 'news' : 'browser_command';
  if (directRoute(text)) return 'browser_command';
  if (webQuestion(text, previous ? [previous] : [])) return 'web_search';
  const reason = notWebReason(tidy(text));
  return ({ reminder: 'reminder', arithmetic: 'compute', writing: 'writing', chat: 'chat', address: 'browser_command', memory_ads_pc: 'memory_ads_pc', empty: 'none' } as Record<string, string>)[reason ?? ''] ?? 'none';
}

export interface ShadowRouter {
  observe(entry: { conversationId: string; text: string; previous: string | null; pendingQuestion: boolean }): void;
  /** Only reads the already configured shadow head; results have no routing authority. */
  candidates?(text: string): readonly ShadowRouteCandidate[];
}

/**
 * Shadow mode: never changes what the chat does. The model loads once in the background; until then, or if it
 * is missing or broken, requests are not logged. Each line of the log holds the request, the rules route and the
 * model route, for later comparison with what the owner meant.
 */
export function createShadowRouter(options: { modelDir: string; logFile: string; now?: () => Date }): ShadowRouter {
  let model: RouterModel | null = null, failed = false;
  const loading = loadRouterModel(options.modelDir).then(loaded => { model = loaded; }).catch(() => { failed = true; });
  let writing: Promise<unknown> = mkdir(path.dirname(options.logFile), { recursive: true }).catch(() => undefined);
  let cached: { text: string; candidates: ShadowRouteCandidate[] } | undefined;
  function ranked(text: string): readonly ShadowRouteCandidate[] {
    if (!model || text.length > MAX_ROUTER_TEXT) return [];
    if (cached?.text !== text) cached = { text, candidates: rankRouterModelRoutes(model, text) };
    return cached.candidates;
  }
  return {
    candidates: text => ranked(text).slice(0, 4).map(candidate => ({ ...candidate })),
    observe(entry) {
      if (failed) return;
      writing = writing.then(async () => {
        await loading;
        if (!model) return;
        const started = performance.now();
        const [choice] = ranked(entry.text);
        if (!choice) return;
        const line = { at: (options.now?.() ?? new Date()).toISOString(), conversation: entry.conversationId, text: entry.text.slice(0, 500),
          previous: entry.previous?.slice(0, 200) ?? null, pendingQuestion: entry.pendingQuestion, rules: rulesRoute(entry.text, entry.previous),
          model: choice.route, confidence: Number(choice.score.toFixed(3)), ms: Number((performance.now() - started).toFixed(2)) };
        await appendFile(options.logFile, `${JSON.stringify(line)}\n`, 'utf8');
      }).catch(() => undefined);
    },
  };
}
