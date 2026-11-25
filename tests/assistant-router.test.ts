import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ROUTES, createShadowRouter, foldForRouter, loadRouterModel, ngramIds, routeWithModel, routerLogits, rulesRoute } from '../apps/server/src/assistant/router.js';

/** A tiny model whose bias alone picks `route`; written in the exported format with its sha256 header. */
async function tinyModel(route: string, tamper = false) {
  const dir = await mkdtemp(path.join(tmpdir(), 'router-'));
  const buckets = 16, dim = 2;
  const floats = new Float32Array(buckets * dim + ROUTES.length * dim + ROUTES.length);
  floats[buckets * dim + ROUTES.length * dim + ROUTES.indexOf(route as never)] = 5;
  const bytes = Buffer.from(floats.buffer);
  await writeFile(path.join(dir, 'router-b0.bin'), bytes);
  const sha256 = createHash('sha256').update(tamper ? Buffer.from('other') : bytes).digest('hex');
  await writeFile(path.join(dir, 'router-b0.json'), JSON.stringify({ kind: 'b0', buckets, dim, routes: ROUTES, sha256 }));
  return dir;
}

describe('router model in TypeScript', () => {
  it('folds text exactly as the trainer does', () => {
    expect(foldForRouter('  أهلاً   ـــوسهلاً  ')).toBe('اهلا وسهلا');
    expect(foldForRouter('مدرسة على مستشفى')).toBe('مدرسه علي مستشفي');
    expect(foldForRouter('٢٥ × ٤ Hello')).toBe('25 × 4 hello');
  });

  it('builds n-gram ids inside the bucket range, words included', () => {
    const ids = ngramIds('hi you', 1 << 18);
    // «^hi you$» has 8 characters: 7 bigrams, 6 trigrams, 5 four-grams, then 2 words.
    expect(ids).toHaveLength(20);
    expect(ids.every(id => id >= 0 && id < 1 << 18)).toBe(true);
  });

  it('loads the exported format, checks its hash, and picks the highest logit', async () => {
    const model = await loadRouterModel(await tinyModel('ads'));
    expect(routeWithModel(model, 'anything').route).toBe('ads');
    await expect(loadRouterModel(await tinyModel('ads', true))).rejects.toThrow('ROUTER_MODEL_HASH_MISMATCH');
  });

  it.each([
    { buckets: 0 }, { buckets: -1 }, { buckets: 1.5 }, { dim: 0 }, { dim: 100000 },
    { kind: 'unknown' }, { routes: [...ROUTES].reverse() }, { routes: ROUTES.map(() => 'web_search') },
  ])('rejects an invalid export header before using its dimensions %j', async change => {
    const dir = await tinyModel('ads');
    const file = path.join(dir, 'router-b0.json');
    const header = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...header, ...change }));
    await expect(loadRouterModel(dir)).rejects.toThrow('ROUTER_MODEL_HEADER_INVALID');
  });

  it('rejects truncated and oversized binary exports even with a matching hash', async () => {
    for (const extra of [-1, 1]) {
      const dir = await tinyModel('ads');
      const bytes = await readFile(path.join(dir, 'router-b0.bin'));
      const changed = extra < 0 ? bytes.subarray(0, bytes.length - 1) : Buffer.concat([bytes, Buffer.from([0])]);
      const header = JSON.parse(await readFile(path.join(dir, 'router-b0.json'), 'utf8'));
      header.sha256 = createHash('sha256').update(changed).digest('hex');
      await writeFile(path.join(dir, 'router-b0.bin'), changed);
      await writeFile(path.join(dir, 'router-b0.json'), JSON.stringify(header));
      await expect(loadRouterModel(dir)).rejects.toThrow('ROUTER_MODEL_SIZE_MISMATCH');
    }
  });

  it.each([NaN, Infinity, -Infinity])('rejects nonfinite weights despite a valid export checksum: %s', async value => {
    const dir = await tinyModel('ads');
    const bytes = await readFile(path.join(dir, 'router-b0.bin'));
    bytes.writeFloatLE(value, 0);
    const header = JSON.parse(await readFile(path.join(dir, 'router-b0.json'), 'utf8'));
    header.sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(path.join(dir, 'router-b0.bin'), bytes);
    await writeFile(path.join(dir, 'router-b0.json'), JSON.stringify(header));
    await expect(loadRouterModel(dir)).rejects.toThrow('ROUTER_MODEL_NONFINITE');
  });

  it('bounds model and request sizes without truncating text into another classification', async () => {
    expect(() => ngramIds('x'.repeat(8001), 16)).toThrow('ROUTER_REQUEST_TOO_LARGE');
    expect(() => ngramIds('hello', 0)).toThrow('ROUTER_MODEL_HEADER_INVALID');
    const dir = await tinyModel('ads');
    await writeFile(path.join(dir, 'router-b0.json'), ' '.repeat(16385));
    await expect(loadRouterModel(dir)).rejects.toThrow('ROUTER_MODEL_SIZE_MISMATCH');
  });

  it.skipIf(!existsSync('artifacts/router/router-b0-parity.json'))('matches the Python logits of the trained model', async () => {
    const model = await loadRouterModel('artifacts/router');
    const rows = JSON.parse(await readFile('artifacts/router/router-b0-parity.json', 'utf8')) as { text: string; logits: number[] }[];
    for (const row of rows) routerLogits(model, row.text).forEach((value, index) => expect(Math.abs(value - row.logits[index])).toBeLessThan(1e-4));
  });
});

describe('rules v0 as a route', () => {
  it('names the route today\'s code takes', () => {
    expect(rulesRoute('افتح يوتيوب وابحث عن كبسة', null)).toBe('browser_command');
    expect(rulesRoute('لخّص لي أهم أخبار اليوم', null)).toBe('news');
    expect(rulesRoute('كم سعر الذهب اليوم؟', null)).toBe('web_search');
    expect(rulesRoute('ذكرني بموعد الطبيب بكرة', null)).toBe('reminder');
    expect(rulesRoute('كم 5 ضرب 3', null)).toBe('compute');
    expect(rulesRoute('شكرا', null)).toBe('chat');
    expect(rulesRoute('هل تتذكر اسم شركتي', null)).toBe('memory_ads_pc');
  });
});

describe('shadow router', () => {
  it('logs the rules route and the model route side by side', async () => {
    const dir = await tinyModel('ads');
    const logFile = path.join(dir, 'log', 'shadow.jsonl');
    const shadow = createShadowRouter({ modelDir: dir, logFile, now: () => new Date('2026-11-20T12:00:00Z') });
    shadow.observe({ conversationId: 'c1', text: 'I run a barbershop and want more bookings', previous: null, pendingQuestion: false });
    await vi.waitFor(async () => expect(existsSync(logFile)).toBe(true));
    const line = JSON.parse((await readFile(logFile, 'utf8')).trim());
    expect(line).toMatchObject({ at: '2026-11-20T12:00:00.000Z', conversation: 'c1', rules: 'web_search', model: 'ads', pendingQuestion: false });
    const candidates = shadow.candidates?.('I run a barbershop and want more bookings') ?? [];
    expect(candidates).toHaveLength(4);
    expect(candidates[0]).toEqual({ route: 'ads', score: expect.closeTo(line.confidence, 3) });
    expect(candidates.map(candidate => candidate.score)).toEqual(candidates.map(candidate => candidate.score).sort((a, b) => b - a));
  });

  it('stays silent when the model files are missing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'router-missing-'));
    const logFile = path.join(dir, 'shadow.jsonl');
    const shadow = createShadowRouter({ modelDir: dir, logFile });
    shadow.observe({ conversationId: 'c1', text: 'hi', previous: null, pendingQuestion: false });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(existsSync(logFile)).toBe(false);
  });
});
