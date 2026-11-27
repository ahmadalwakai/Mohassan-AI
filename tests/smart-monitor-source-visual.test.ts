import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserEngine, SafeNetwork } from '@mohassan/browser';
import type { MonitorSpec } from '@mohassan/contracts';
import { createDatabase, migrate } from '@mohassan/database';
import type { ImageReading, ReadLine } from '@mohassan/vision';
import type { Kysely } from 'kysely';
import type { Page } from 'playwright';
import { PNG } from 'pngjs';
import { describe, expect, it, vi } from 'vitest';
import { createMonitorReader } from '../apps/server/src/monitors/sources.js';
import { MONITOR_LIMITS, nextMonitorBudgetDay } from '../apps/server/src/monitors/schedule.js';
import { migrateMonitorVisualBudget } from '../apps/server/src/monitors/sources/migration.js';
import { renderMonitorRegions } from '../apps/server/src/monitors/sources/visual-browser.js';
import { MONITOR_VISUAL_DAILY_LIMIT, reserveMonitorVisualRead } from '../apps/server/src/monitors/sources/visual-budget.js';
import { createVisualMonitorReader, type VisualRenderResult } from '../apps/server/src/monitors/sources/visual.js';

const at = Date.UTC(2026, 10, 25, 12);
const url = 'https://scores.example/watch';
const options = { ownerId: 'visual-fixture', v2: true };
const timing: MonitorSpec['timing'] = { urgency: 'normal', lifetimeMs: 86_400_000, initialIntervalMs: 900_000, maxChecks: 28, maxNotifications: 1 };
const spec = (source: MonitorSpec['source'] = { kind: 'visual', url, anchor: 'Score' }): MonitorSpec => ({
  source, read: { kind: 'number', label: 'Score' }, condition: { kind: 'change' }, language: 'en',
  title: 'Watch the score', message: 'The score changed.', timing,
});

function reading(...input: [text: string, confidence: number][]): ImageReading {
  const lines: ReadLine[] = input.map(([text, confidence], row) => ({ text, visual: text, row, confidence,
    direction: /\p{Script=Arabic}/u.test(text) ? 'rtl' : 'ltr', box: { x: 0, y: row * 12, w: 24, h: 12 }, block: 0 }));
  return { lines, facts: { width: 24, height: 24, format: 'png', orientation: 'square', meanBrightness: 255,
    darkBackground: false, colorfulness: 0, distinctColors: 1, flatShare: 1, dominant: [], surface: 'graphic' },
    blocks: lines.map(line => line.text), text: lines.map(line => line.text).join('\n'), direction: 'mixed',
    kind: 'graphic', candidates: lines.length, dropped: 0, durationMs: 0, modelId: 'deterministic-fixture' };
}

async function withServer(serve: (request: IncomingMessage, response: ServerResponse) => void, check: (origin: string) => Promise<void>) {
  const server = createServer(serve);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await check(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

const region = { key: 'score', label: 'Score', image: new Uint8Array([1]) };
const renderRegions = async (): Promise<VisualRenderResult> => ({ kind: 'regions', regions: [region] });

describe('visual monitor safety and admission', () => {
  it('accepts a single legible Arabic number and returns no reusable HTML validator', async () => {
    const read = vi.fn(async () => reading(['النتيجة ١٢٣٫٥', 0.9]));
    const visual = createVisualMonitorReader({ network: new SafeNetwork(), imageReader: { available: true, read },
      reserveDaily: async () => null, render: renderRegions, clock: () => at });
    expect(await visual(spec(), url, options)).toEqual({ kind: 'value',
      observation: { value: 123.5, excerpt: 'النتيجة ١٢٣٫٥', url, observedAt: new Date(at).toISOString() },
      cache: { url, anchor: { origin: 'visual', key: 'score', label: 'Score', context: 'score', pattern: { kind: 'number' } } },
    });
    expect(read).toHaveBeenCalledExactlyOnceWith(region.image, expect.any(AbortSignal));
  });

  it('returns no observation for weak, ambiguous, or contradictory number evidence', async () => {
    const read = vi.fn<() => Promise<ImageReading>>();
    const visual = createVisualMonitorReader({ network: new SafeNetwork(), imageReader: { available: true, read },
      reserveDaily: async () => null, render: renderRegions });
    const ambiguous = [reading(['145', 0.899]), reading(['145', 0.98], ['192', 0.72]), reading(['145 192', 0.98]), reading(['145x 192', 0.98]),
      reading(['145', Number.NaN]), reading(['145', 1.2]), reading()];
    for (const result of ambiguous) {
      read.mockResolvedValueOnce(result);
      expect(await visual(spec(), url, options)).toMatchObject({ kind: 'unsafe-target', reason: 'visual-unreadable' });
    }
    read.mockResolvedValueOnce(reading(['15 kg', 0.98]));
    expect(await visual({ ...spec(), v2: { freshnessMs: 60_000, target: { unit: 'pound' } } }, url, options))
      .toMatchObject({ kind: 'unsafe-target', reason: 'visual-unreadable' });
  });

  it('defers without rendering under a spent allowance and refuses missing OCR weights', async () => {
    const render = vi.fn(renderRegions);
    const reserveDaily = vi.fn(async () => nextMonitorBudgetDay(new Date(at)).getTime());
    const read = vi.fn(async () => reading(['15', 0.98]));
    const args = { network: new SafeNetwork(), reserveDaily, render, clock: () => at };
    expect(await createVisualMonitorReader(args)(spec(), url, options)).toMatchObject({ kind: 'unsafe-target', reason: 'visual-unreadable' });
    expect(reserveDaily).not.toHaveBeenCalled();
    expect(await createVisualMonitorReader({ ...args, imageReader: { available: true, read } })(spec(), url, options))
      .toEqual({ kind: 'deferred', at: nextMonitorBudgetDay(new Date(at)).getTime() });
    expect(render).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('shares in-flight render slots between scheduled and preview visual reads', async () => {
    const limit = MONITOR_LIMITS.concurrentReads;
    let releaseRender!: (result: VisualRenderResult) => void;
    let notifyReadersReady!: () => void;
    const renderReady = new Promise<VisualRenderResult>(resolve => { releaseRender = resolve; });
    const readersReady = new Promise<void>(resolve => { notifyReadersReady = resolve; });
    const render = vi.fn(() => {
      if (render.mock.calls.length === limit) notifyReadersReady();
      return renderReady;
    });
    const reserve = vi.fn(async () => null);
    const read = vi.fn(async () => reading(['15', 0.98]));
    const visual = createVisualMonitorReader({ network: new SafeNetwork(), imageReader: { available: true, read },
      reserveDaily: reserve, render, clock: () => at });
    const scheduled = Array.from({ length: limit }, () => visual(spec(), url, options));
    await readersReady;
    const preview = visual(spec(), url, { ...options, preview: true });
    releaseRender({ kind: 'regions', regions: [region] });
    await Promise.all(scheduled);
    expect(await preview).toEqual({ kind: 'deferred', at: at + MONITOR_LIMITS.pollMs });
    expect(render).toHaveBeenCalledTimes(limit);
    expect(reserve).toHaveBeenCalledTimes(limit);
    expect(await visual(spec(), url, options)).toMatchObject({ kind: 'value' });
  });

  it('shares the daily browser allowance and restarts it at the next UTC day', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'monitor-visual-budget-'));
    const database = await createDatabase({ dataDir: directory });
    try {
      await migrate(database.db);
      await database.db.transaction().execute(migrateMonitorVisualBudget);
      const attempts = await Promise.all(Array.from({ length: MONITOR_VISUAL_DAILY_LIMIT + 6 }, () => reserveMonitorVisualRead(database.db, at)));
      expect(attempts.filter(wait => wait === null)).toHaveLength(MONITOR_VISUAL_DAILY_LIMIT);
      const tomorrow = nextMonitorBudgetDay(new Date(at)).getTime();
      expect(attempts.filter(wait => wait !== null)).toEqual(Array(6).fill(tomorrow));
      expect(await reserveMonitorVisualRead(database.db, tomorrow)).toBeNull();
      expect(await reserveMonitorVisualRead(database.db, at)).toBe(tomorrow);
    } finally {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('passes the checked region dimensions directly to the browser capture', async () => {
    const clip = { x: 12, y: 18, width: 120, height: 50 };
    const screenshot = vi.fn(async () => Buffer.from('fixture'));
    const element = { boundingBox: async () => clip, scrollIntoViewIfNeeded: async () => {},
      evaluate: async () => true, screenshot: vi.fn(async () => Buffer.from('fixture')) };
    const page = { evaluate: async () => '<main><canvas id="score"></canvas></main>', url: () => url,
      viewportSize: () => ({ width: 1100, height: 760 }), screenshot,
      evaluateHandle: async () => ({ async getProperty(name: string) {
        if (name === 'descriptions') return { jsonValue: async () => [{ tag: 'canvas', domId: 'score', name: 'Score', context: '' }] };
        return { getProperties: async () => new Map([['0', { asElement: () => element }]]) };
      } }) } as unknown as Page;
    const open = vi.spyOn(BrowserEngine.prototype, 'open').mockResolvedValueOnce(undefined);
    const inspect = vi.spyOn(BrowserEngine.prototype, 'inspect').mockImplementationOnce(async (_id, _url, read) => read(page, 200));
    try {
      const result = await renderMonitorRegions({ spec: spec(), url, network: new SafeNetwork(),
        signal: new AbortController().signal, at: new Date(at).toISOString() });
      expect(result.kind).toBe('regions');
      expect(screenshot).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ clip }));
    } finally {
      open.mockRestore();
      inspect.mockRestore();
    }
  });
});

describe('visual fallback through the existing browser', () => {
  const flags = { visual: true, github: false, pdf: false };

  it('gates ordinary page fallback and does not revalidate a visual value against HTML alone', async () => {
    const conditionals: string[] = [];
    await withServer((request, response) => {
      if (request.url === '/robots.txt') return response.end('User-agent: *\nAllow: /');
      if (request.headers['if-none-match']) conditionals.push(request.headers['if-none-match']);
      response.writeHead(200, { 'content-type': 'text/html', etag: '"same-markup"' });
      response.end('<main><h2>Score</h2><canvas id="score" aria-label="Score"></canvas></main>');
    }, async origin => {
      const render = vi.fn(renderRegions);
      const ocr = vi.fn<() => Promise<ImageReading>>().mockResolvedValueOnce(reading(['15', 0.97]))
        .mockResolvedValueOnce(reading(['26', 0.97]));
      const config = { db: {} as Kysely<any>, network: new SafeNetwork({ testOrigins: [origin] }),
        visual: { reserveDaily: async () => null, imageReader: { available: true, read: ocr }, render } };
      const watch = spec({ kind: 'page', url: origin + '/score', anchor: 'Score' });
      const disabled = createMonitorReader({ ...config, flags: { ...flags, visual: false } });
      expect(await disabled.read(watch, options)).toMatchObject({ kind: 'missing' });
      expect(render).not.toHaveBeenCalled();

      const enabled = createMonitorReader({ ...config, flags });
      const first = await enabled.read(watch, options);
      expect(first).toMatchObject({ kind: 'value', observation: { value: 15 } });
      if (first.kind !== 'value') throw new Error('Expected an OCR baseline');
      expect(await enabled.read(watch, { ...options, cache: first.cache })).toMatchObject({ kind: 'value', observation: { value: 26 } });
      expect(conditionals).toEqual([]);
    });
  });

  it('reads structured and rendered text instead of invoking OCR when data is available', async () => {
    await withServer((request, response) => {
      if (request.url === '/robots.txt') return response.end('User-agent: *\nAllow: /');
      response.setHeader('content-type', 'text/html; charset=utf-8');
      return response.end(request.url === '/structured' ? `<main><h2>Price</h2><canvas id="price"></canvas></main>
        <script type="application/ld+json">{"@context":"https://schema.org","@type":"Offer","price":17,"priceCurrency":"USD"}</script>` :
        `<main><p id="score-version"></p><canvas id="score" aria-label="Score" width="120" height="50"></canvas></main>
        <script>document.getElementById('score-version').textContent = 'Score: 42';</script>`);
    }, async origin => {
      const read = vi.fn(async () => reading(['45', 0.98]));
      const reserveDaily = vi.fn(async () => null);
      const reader = createMonitorReader({ db: {} as Kysely<any>, network: new SafeNetwork({ testOrigins: [origin] }), flags,
        visual: { reserveDaily, imageReader: { available: true, read } } });
      const price = { ...spec({ kind: 'visual', url: origin + '/structured' }), read: { kind: 'number', label: 'Price' } } as const;
      expect(await reader.read(price, options)).toMatchObject({ kind: 'value', observation: { value: 17 }, cache: { anchor: { origin: 'structured' } } });
      expect(reserveDaily).not.toHaveBeenCalled();
      expect(await reader.read(spec({ kind: 'visual', url: origin + '/dynamic', anchor: 'Score' }), options))
        .toMatchObject({ kind: 'value', observation: { value: 42 }, cache: { anchor: { origin: 'visible' } } });
      expect(reserveDaily).toHaveBeenCalledTimes(1);
      expect(read).not.toHaveBeenCalled();
    });
  });

  it('offers bounded canvas crops as choices and keeps the selected identity after reordering', async () => {
    const requests: { path: string; method?: string; cookies?: string; authorization?: string }[] = [];
    let reordered = false;
    let crossOriginReads = 0;
    await withServer((_request, response) => { crossOriginReads++; response.end(); }, async otherOrigin => {
      await withServer((request, response) => {
        const path = request.url!;
        requests.push({ path, method: request.method, cookies: request.headers.cookie, authorization: request.headers.authorization });
        if (path === '/robots.txt') return response.end('User-agent: *\nAllow: /');
        if (path === '/redirect-image') return response.writeHead(302, { location: otherOrigin + '/external' }).end();
        if (path !== '/canvas') return response.end();
        response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'fixture-canary=read-only' });
        const draws = [['one', '#c00000', 11, 'Home'], ['two', '#0000c0', 22, 'Away']] as const;
        const sections = (reordered ? [...draws].reverse() : draws).map(([id, color, value, label]) => `
          <section><h2>${label}</h2><canvas id="${id}" aria-label="Score" width="120" height="50"></canvas></section>
          <script>const ${id} = document.getElementById('${id}').getContext('2d');
          ${id}.fillStyle='${color}'; ${id}.fillRect(0,0,120,50); ${id}.fillStyle='white';
          ${id}.font='24px sans-serif'; ${id}.fillText('${value}',20,28);</script>`).join('');
        response.end(`<main>${sections}<img src="/redirect-image"><iframe name="hidden"></iframe>
          <form action="/submit" method="get" target="hidden" id="autofill"></form></main>
          <script>document.cookie='fixture-canary=read-only';
          fetch('/read', {headers:{Authorization:'Bearer fixture-only'}}).catch(() => {});
          fetch('/write', {method:'POST', body:'fixture'}).catch(() => {});
          document.getElementById('autofill').submit();</script>`);
      }, async origin => {
        const read = vi.fn(async (bytes: Uint8Array) => {
          const image = PNG.sync.read(Buffer.from(bytes));
          expect(Math.abs(image.width - 120)).toBeLessThanOrEqual(1);
          expect(Math.abs(image.height - 50)).toBeLessThanOrEqual(1);
          const index = (Math.floor(image.height / 2) * image.width + 5) * 4;
          if (image.data[index] === 192) return reading(['11', 0.97]);
          expect(image.data[index + 2]).toBe(192);
          return reading(['22', 0.97]);
        });
        const address = origin + '/canvas';
        const reader = createMonitorReader({ db: {} as Kysely<any>, network: new SafeNetwork({ testOrigins: [origin, otherOrigin] }), flags,
          visual: { reserveDaily: async () => null, imageReader: { available: true, read } } });
        const watch = spec({ kind: 'visual', url: address, anchor: 'Score' });
        const preview = await reader.read(watch, options);
        expect(preview).toMatchObject({ kind: 'clarify', candidates: [
          { label: 'Score · Home', observation: { value: 11 } }, { label: 'Score · Away', observation: { value: 22 } },
        ] });
        if (preview.kind !== 'clarify') throw new Error('Expected a choice card');
        const chosen = preview.candidates[1];
        reordered = true;
        expect(await reader.read(watch, { ...options, cache: { url: address, anchor: chosen.anchor } }))
          .toMatchObject({ kind: 'value', observation: { value: 22 }, cache: { anchor: chosen.anchor } });
        expect(read).toHaveBeenCalledTimes(3);
        expect(requests.some(item => item.path === '/read')).toBe(true);
        expect(requests.every(item => item.method === 'GET' && !item.cookies && !item.authorization)).toBe(true);
        expect(requests.map(item => item.path)).not.toContain('/submit');
        expect(requests.map(item => item.path)).not.toContain('/write');
        expect(crossOriginReads).toBe(0);
      });
    });
  });
});
