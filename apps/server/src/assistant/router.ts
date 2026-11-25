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
 * B2 exports direct route coefficients for offline comparisons. The shadow loader still uses B0.
 */
export const ROUTES = ['web_search', 'browser_command', 'news', 'memory', 'reminder', 'compute', 'ads', 'pc', 'writing', 'chat', 'reply',
  'image', 'media', 'unsupported'] as const;
export type Route = typeof ROUTES[number];
const MAX_ROUTER_TEXT = 8000;
const MAX_MODEL_BYTES = 128 * 1024 * 1024;
const RouterHeader = z.object({
  buckets: z.number().int().min(1).max(1 << 20),
  routes: z.array(z.enum(ROUTES)).length(ROUTES.length).refine(routes => routes.every((route, index) => route === ROUTES[index])),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const B0Header = RouterHeader.extend({ kind: z.literal('b0'), dim: z.number().int().min(1).max(512) });
const B2FeatureVersion = z.enum(['b0', 'extended']);
const B2Header = RouterHeader.extend({ kind: z.literal('b2'), featureVersion: B2FeatureVersion });
type B2FeatureVersion = z.infer<typeof B2FeatureVersion>;

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

function foldRouterLetters(text: string): string {
  return text.normalize('NFC')
    .replace(/[\u0640\u064b-\u065f\u0670]/gu, '')
    .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه')
    .replace(/[٠-٩]/gu, digit => String(digit.charCodeAt(0) - 0x0660))
    .toLowerCase();
}

/** The B0 folding: marks and tatweel removed, letter forms unified, digits Latin, lower case. */
export function foldForRouter(text: string): string {
  return foldRouterLetters(text).replace(/\s+/gu, ' ').trim();
}

const stable = (text: string) => parseInt(createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8), 16);
// Matches Python's whitespace recognition, including U+0085 and excluding U+FEFF.
const PYTHON_SPACE = /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu;

/** The bucket ids train.py `ngram_ids` produces: character 2-, 3- and 4-grams of «^text$», then whole words. */
export function ngramIds(text: string, buckets: number): number[] {
  return featureIds(text, buckets);
}

function featureIds(text: string, buckets: number, featureVersion?: B2FeatureVersion): number[] {
  if (typeof text !== 'string' || text.length > MAX_ROUTER_TEXT) throw new Error('ROUTER_REQUEST_TOO_LARGE');
  if (!Number.isSafeInteger(buckets) || buckets < 1 || buckets > 1 << 20) throw new Error('ROUTER_MODEL_HEADER_INVALID');
  const folded = featureVersion ? foldRouterLetters(text).replace(PYTHON_SPACE, ' ').replace(/^ | $/gu, '') : foldForRouter(text);
  const marked = `^${folded}$`, chars = Array.from(marked);
  const ids: number[] = [];
  const maxSize = featureVersion === 'extended' ? 5 : 4;
  for (let size = 2; size <= maxSize; size++) {
    for (let at = 0; at + size <= chars.length; at++) ids.push(stable(`c${size}:${chars.slice(at, at + size).join('')}`) % buckets);
  }
  const inner = marked.replace(/^[\^$]+|[\^$]+$/gu, '');
  const words = inner.split(' ').filter(Boolean);
  for (const word of words) ids.push(stable(`w:${word}`) % buckets);
  if (featureVersion === 'extended') {
    for (let at = 1; at < words.length; at++) ids.push(stable(`w2:${words[at - 1]} ${words[at]}`) % buckets);
  }
  return ids.length ? ids : [0];
}

export interface RouterModel { buckets: number; dim: number; routes: readonly string[]; embedding: Float32Array; weight: Float32Array; bias: Float32Array }
export interface RouterB2Model { buckets: number; routes: readonly string[]; featureVersion: B2FeatureVersion; coefficients: Float32Array; bias: Float32Array }

export function routerLogits(model: RouterModel | RouterB2Model, text: string): number[] {
  if ('coefficients' in model) {
    const ids = featureIds(text, model.buckets, model.featureVersion);
    const scores = new Float64Array(model.routes.length);
    for (const id of ids) {
      const offset = id * scores.length;
      for (let route = 0; route < scores.length; route++) scores[route] += model.coefficients[offset + route];
    }
    return Array.from(scores, (score, route) => score / ids.length + model.bias[route]);
  }
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

export function rankRouterModelRoutes(model: RouterModel | RouterB2Model, text: string): ShadowRouteCandidate[] {
  const logits = routerLogits(model, text), top = Math.max(...logits);
  if (!logits.length || !logits.every(Number.isFinite)) throw new Error('ROUTER_MODEL_NONFINITE');
  const exps = logits.map(value => Math.exp(value - top)), total = exps.reduce((a, b) => a + b, 0);
  return model.routes.map((route, index) => ({ route, score: exps[index] / total })).sort((a, b) => b.score - a.score);
}

export function routeWithModel(model: RouterModel | RouterB2Model, text: string): { route: string; confidence: number } {
  const [best] = rankRouterModelRoutes(model, text);
  return { route: best.route, confidence: best.score };
}

async function readRouterHeader<T>(file: string, schema: z.ZodType<T>): Promise<{ header: T; headerSha256: string }> {
  const metadata = await readRouterBytes(file, 16 * 1024);
  try { return { header: schema.parse(JSON.parse(metadata.toString('utf8'))), headerSha256: createHash('sha256').update(metadata).digest('hex') }; }
  catch { throw new Error('ROUTER_MODEL_HEADER_INVALID'); }
}

async function readRouterFloats(file: string, count: number, sha256: string): Promise<Float32Array> {
  const expectedBytes = count * Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes > MAX_MODEL_BYTES) throw new Error('ROUTER_MODEL_SIZE_MISMATCH');
  const bytes = await readRouterBytes(file, expectedBytes);
  if (bytes.byteLength !== expectedBytes) throw new Error('ROUTER_MODEL_SIZE_MISMATCH');
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('ROUTER_MODEL_HASH_MISMATCH');
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  if (!floats.every(Number.isFinite)) throw new Error('ROUTER_MODEL_NONFINITE');
  return floats;
}

/** Loads router-b0.bin and checks it against the sha256 in its JSON header. */
export async function loadRouterModel(dir: string): Promise<RouterModel & { headerSha256: string }> {
  const { header, headerSha256 } = await readRouterHeader(path.join(dir, 'router-b0.json'), B0Header);
  const embedded = header.buckets * header.dim, weights = header.routes.length * header.dim;
  const floats = await readRouterFloats(path.join(dir, 'router-b0.bin'), embedded + weights + header.routes.length, header.sha256);
  return { buckets: header.buckets, dim: header.dim, routes: header.routes,
    headerSha256,
    embedding: floats.subarray(0, embedded), weight: floats.subarray(embedded, embedded + weights), bias: floats.subarray(embedded + weights) };
}

/** Explicit offline B2 loader. B0 and B2 artifacts can share a directory. */
export async function loadRouterB2Model(dir: string): Promise<RouterB2Model & { headerSha256: string }> {
  const { header, headerSha256 } = await readRouterHeader(path.join(dir, 'router-b2.json'), B2Header);
  const weights = header.buckets * header.routes.length;
  const floats = await readRouterFloats(path.join(dir, 'router-b2.bin'), weights + header.routes.length, header.sha256);
  return { buckets: header.buckets, routes: header.routes, featureVersion: header.featureVersion, headerSha256,
    coefficients: floats.subarray(0, weights), bias: floats.subarray(weights) };
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
