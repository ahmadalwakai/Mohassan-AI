import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BrowserError, SafeNetwork, type SearchProvider } from '@mohassan/browser';
import type { MonitorSpec } from '@mohassan/contracts';
import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { evaluateMonitor, type MonitorEvaluationState, type MonitorObservation } from '../apps/server/src/monitors/evaluation.js';
import { observePage } from '../apps/server/src/monitors/page.js';
import { createMonitorReader } from '../apps/server/src/monitors/sources.js';

const at = '2026-11-25T12:00:00.000Z';
const url = 'https://example.org/events';
const fixture = readFileSync(new URL('./fixtures/monitors/registration.html', import.meta.url), 'utf8');
const ecbXml = readFileSync(new URL('./fixtures/live-data/ecb-daily-2026-11-24.xml', import.meta.url), 'utf8');
const forecast = readFileSync(new URL('./fixtures/live-data/open-meteo-forecast.json', import.meta.url), 'utf8');
const db = {} as Kysely<any>;
const timing: MonitorSpec['timing'] = {
  urgency: 'normal', lifetimeMs: 86_400_000, initialIntervalMs: 900_000, maxChecks: 48, maxNotifications: 1,
};
function page(patch: Partial<MonitorSpec> = {}): MonitorSpec {
  return { source: { kind: 'page', url }, language: 'en', title: 'Festival', message: 'The festival changed.',
    timing, read: { kind: 'main' }, condition: { kind: 'change' }, ...patch };
}
function extract(spec: MonitorSpec, body = fixture) {
  if (spec.source.kind !== 'page') throw new Error('Page fixture required');
  return observePage(body, spec.source.url, 'text/html', { source: spec.source, read: spec.read }, at);
}
function value(observed: MonitorObservation['value']): MonitorObservation {
  return { value: observed, excerpt: String(observed), observedAt: at };
}

describe('monitor page extraction and condition evaluation', () => {
  it('previews the public number or date near its requested label, in the watched block', () => {
    const scope = { kind: 'page', url, anchor: 'Registration' } as const;
    expect(extract(page({ source: scope, read: { kind: 'number', label: 'السعر' } }))).toMatchObject({
      value: 3.75, excerpt: 'السعر: ٣٫٧٥ دولار', url, observedAt: at,
    });
    expect(extract(page({ source: scope, read: { kind: 'date', label: 'Opening date' } }))).toMatchObject({
      value: '2026-12-10', excerpt: 'Opening date 2026-12-10',
    });
    expect(extract(page({ source: scope, read: { kind: 'number', label: 'price' } }))?.value).toBe(3.75);
    expect(extract(page({ source: scope, read: { kind: 'date', label: 'Opening date' } }),
      fixture.replace('>2026-12-10<', '>١٠ كانون الأول ٢٠٢٦<'))?.value).toBe('2026-12-10');
    expect(extract(page({ source: scope, read: { kind: 'number', label: 'Missing price' } }))).toBeUndefined();
    expect(extract(page({ source: { ...scope, anchor: 'Unknown section' } }))).toBeUndefined();
  });

  it('reads the scoped registration status and avoids positive-looking negations', () => {
    const spec = page({ source: { kind: 'page', url, anchor: 'Registration' }, read: { kind: 'status', label: 'registration' },
      condition: { kind: 'contains', value: 'registration open' } });
    const baseline = extract(spec)!;
    expect(baseline).toMatchObject({ value: 'registration closed', excerpt: 'Registration is not open yet' });
    const opened = extract(spec, fixture.replace('Registration is not open yet', 'التسجيل مفتوح الآن'))!;
    expect(opened).toMatchObject({ value: 'registration open', excerpt: 'التسجيل مفتوح الآن' });
    expect(evaluateMonitor(spec, evaluateMonitor(spec, undefined, baseline).state, opened).trigger).toEqual(opened);

    const phrase = page({ source: spec.source, read: { kind: 'phrase', phrase: 'open' }, condition: { kind: 'appears' } });
    expect(extract(phrase)?.value).toBe(false);
    expect(extract(phrase, fixture.replace('Registration is not open yet', 'Registration is open'))?.value).toBe(true);
  });

  it('drops labelled and learned rotating noise while confirming one real change', () => {
    const spec = page();
    const watched = (rotating: string, registration: string, visits: number) => extract(spec, fixture
      .replace('A recommendation', rotating)
      .replace('Registration is not open yet', registration)
      .replace('162 people', `${visits} people`))!;
    const baseline = watched('A recommendation', 'Registration is not open yet', 162);
    let state = evaluateMonitor(spec, undefined, baseline).state;
    expect(baseline.blocks?.map(block => block.text).join(' ')).not.toMatch(/Last updated|162 people|another event|19:58:00/);
    const triggers: MonitorObservation[] = [];
    for (const sample of [
      watched('Other recommendation', 'Registration is not open yet', 163),
      watched('A recommendation', 'Registration is not open yet', 164),
      watched('Third recommendation', 'Registration is open', 165),
      watched('Other recommendation', 'Registration is open', 166),
      watched('A recommendation', 'Registration is open', 167),
    ]) {
      const evaluated = evaluateMonitor(spec, state, sample);
      if (evaluated.trigger) triggers.push(evaluated.trigger);
      state = evaluated.state;
    }
    expect(triggers.map(trigger => trigger.excerpt)).toEqual(['Registration is open']);
  });

  it('uses strict crossing and a re-arm margin to ignore repeated flaps', () => {
    const spec = page({ condition: { kind: 'crossing', direction: 'below', value: 3.7, hysteresis: 0.05 } });
    const values = [3.75, 3.7, 3.69, 3.71, 3.69, 3.72, 3.69, 3.76, 3.68, 3.7];
    let state: MonitorEvaluationState | undefined;
    expect(values.flatMap(sample => {
      const result = evaluateMonitor(spec, state, value(sample));
      state = result.state;
      return result.trigger ? [result.trigger.value] : [];
    })).toEqual([3.69, 3.68]);
    expect(evaluateMonitor(spec, evaluateMonitor(spec, undefined, value(3.6)).state, value(3.6)).trigger).toBeUndefined();
    const threshold = page({ condition: { kind: 'threshold', direction: 'below', value: 3.7, hysteresis: 0.05 } });
    expect(evaluateMonitor(threshold, evaluateMonitor(threshold, undefined, value(3.6)).state, value(3.6)).trigger?.value).toBe(3.6);
  });

  it('checks percent moves from the approved baseline and remembers previously seen items', () => {
    const percent = page({ condition: { kind: 'percent', direction: 'below', value: 10 } });
    const baseline = evaluateMonitor(percent, undefined, value(100)).state;
    expect(evaluateMonitor(percent, baseline, value(109)).trigger).toBeUndefined();
    expect(evaluateMonitor(percent, baseline, value(90)).trigger?.value).toBe(90);
    const spec = page({ condition: { kind: 'new-item' } });
    const start = evaluateMonitor(spec, undefined, value(['A', 'B']));
    const reorder = evaluateMonitor(spec, start.state, value(['B', 'A']));
    const removal = evaluateMonitor(spec, reorder.state, value(['B']));
    const returnOld = evaluateMonitor(spec, removal.state, value(['A', 'B']));
    const fresh = evaluateMonitor(spec, returnOld.state, value(['A', 'C']));
    expect([reorder.trigger, removal.trigger, returnOld.trigger]).toEqual([undefined, undefined, undefined]);
    expect(fresh.trigger?.excerpt).toBe('C');
  });

  it('checks literal dates and phrase disappearance', () => {
    const equals = page({ condition: { kind: 'equals', value: '2026-12-10' } });
    expect(evaluateMonitor(equals, evaluateMonitor(equals, undefined, value('2026-11-30')).state, value('2026-12-10')).trigger?.value).toBe('2026-12-10');
    const disappears = page({ condition: { kind: 'disappears' } });
    expect(evaluateMonitor(disappears, evaluateMonitor(disappears, undefined, value(true)).state, value(false)).trigger?.value).toBe(false);
  });
});

describe('monitor public source transport', () => {
  it('honours robots before reading, forwards validators, and blocks private redirects', async () => {
    const requests: string[] = [];
    const seenValidators: { etag?: string; date?: string }[] = [];
    const modified = 'Wed, 25 Nov 2026 08:00:00 GMT';
    const server = createServer((request, response) => {
      const path = request.url!;
      requests.push(path);
      if (path === '/robots.txt') return response.end('User-agent: *\nDisallow: /\nCrawl-delay: 600\nUser-agent: Monitor-Test\nDisallow: /denied\nCrawl-delay: 125\n');
      if (path === '/redirect') {
        response.writeHead(302, { location: 'https://127.0.0.2/internal' });
        return response.end();
      }
      if (path === '/events') {
        seenValidators.push({ etag: request.headers['if-none-match'], date: request.headers['if-modified-since'] });
        if (request.headers['if-none-match'] === '"festival1"') {
          response.writeHead(304);
          return response.end();
        }
      }
      if (path === '/gone') {
        response.writeHead(404);
        return response.end();
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=UTF-8', etag: '"festival1"', 'last-modified': modified });
      response.end(fixture);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const network = new SafeNetwork({ testOrigins: [origin], userAgent: 'Monitor-Test/1.0' });
      const reader = createMonitorReader({ db, network, clock: () => Date.parse(at) });
      const source = (path: string) => page({ source: { kind: 'page', url: origin + path } });
      const allow = vi.fn(async () => null);
      expect(await reader.read(source('/events'), { ownerId: 'owner', reserveHost: async () => 1_000_000 })).toEqual({ kind: 'deferred', at: 1_000_000 });
      expect(requests).toEqual([]);
      const extendHost = vi.fn(async () => undefined);
      const first = await reader.read(source('/events'), { ownerId: 'owner', reserveHost: allow, extendHost });
      expect(first).toMatchObject({ kind: 'value', cache: { url: origin + '/events', etag: '"festival1"', lastModified: modified } });
      expect(allow).toHaveBeenCalledExactlyOnceWith('127.0.0.1');
      expect(extendHost).toHaveBeenCalledExactlyOnceWith('127.0.0.1', 125_000);
      if (first.kind !== 'value') throw new Error('Missing test baseline');
      const cachedReserve = vi.fn(async () => null);
      const later = await reader.read(source('/events'), { ownerId: 'owner', cache: first.cache, reserveHost: cachedReserve });
      expect(cachedReserve).toHaveBeenCalledExactlyOnceWith('127.0.0.1', 125_000);
      expect(later).toMatchObject({ kind: 'unchanged', cache: first.cache });
      expect(seenValidators).toEqual([{ etag: undefined, date: undefined }, { etag: '"festival1"', date: modified }]);
      expect(await reader.read(source('/denied'), { ownerId: 'owner' })).toMatchObject({ kind: 'unreachable' });
      expect(await reader.read(source('/redirect'), { ownerId: 'owner' })).toMatchObject({ kind: 'unreachable' });
      expect(requests).toEqual(['/robots.txt', '/events', '/events', '/redirect']);
      const availability: MonitorSpec = { ...source('/gone'), read: { kind: 'status' }, condition: { kind: 'equals', value: 'reachable' } };
      expect(await reader.read(availability, { ownerId: 'owner', preview: true })).toMatchObject({
        kind: 'value', observation: { value: 'not published' },
      });
      expect(await reader.read({ ...availability, source: source('/events').source }, { ownerId: 'owner' })).toMatchObject({
        kind: 'value', observation: { value: 'reachable' },
      });
      expect(await reader.read({ ...availability, source: source('/denied').source }, { ownerId: 'owner', preview: true })).toMatchObject({ kind: 'unreachable' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('refuses private literal and mixed DNS addresses before dispatch', async () => {
    const resolver = vi.fn(async () => [{ address: '8.8.8.8', family: 4 as const }, { address: '10.1.2.3', family: 4 as const }]);
    const network = new SafeNetwork({ resolver });
    const reader = createMonitorReader({ db, network });
    const reserveHost = vi.fn(async () => null);
    await expect(network.pin('https://monitor.example.org')).rejects.toMatchObject({ code: 'BROWSER_NETWORK_DENIED' });
    for (const target of ['https://169.254.169.254/metadata', 'https://[::1]/', 'https://monitor.example.org']) {
      expect(await reader.read(page({ source: { kind: 'page', url: target } }), { ownerId: 'owner', reserveHost })).toMatchObject({ kind: 'unreachable' });
    }
    const availability = page({ source: { kind: 'page', url: 'https://monitor.example.org' },
      read: { kind: 'status' }, condition: { kind: 'equals', value: 'reachable' } });
    expect(await reader.read(availability, { ownerId: 'owner', reserveHost, preview: true })).toMatchObject({ kind: 'unreachable' });
    expect(reserveHost).not.toHaveBeenCalled();
  });

  it('offers an availability preview on verified transport failure and preserves running health checks', async () => {
    class UnreachableNetwork extends SafeNetwork {
      override async request(_target: string): Promise<never> {
        throw new BrowserError('BROWSER_FETCH_FAILED', 'Test site unavailable', 502);
      }
    }
    const reader = createMonitorReader({ db, network: new UnreachableNetwork(), clock: () => Date.parse(at) });
    const availability = page({ read: { kind: 'status' }, condition: { kind: 'equals', value: 'reachable' } });
    expect(await reader.read(availability, { ownerId: 'owner', preview: true })).toMatchObject({
      kind: 'value', observation: { value: 'unreachable' },
    });
    expect(await reader.read(availability, { ownerId: 'owner' })).toMatchObject({ kind: 'unreachable' });
  });

  it('reads a typed ECB quote from the real live-data parser', async () => {
    class FixtureNetwork extends SafeNetwork {
      override async request(target: string, options?: Parameters<SafeNetwork['request']>[1]) {
        await options?.beforeDispatch?.();
        if (new URL(target).pathname === '/robots.txt') {
          return { status: 404, headers: {}, body: Buffer.alloc(0), url: target };
        }
        expect(target).toBe('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml');
        return { status: 200, headers: {}, body: Buffer.from(ecbXml), url: target };
      }
    }
    const reader = createMonitorReader({ db, network: new FixtureNetwork(), clock: () => Date.parse(at) });
    const result = await reader.read(page({ source: { kind: 'currency', base: 'EUR', quote: 'USD' }, read: { kind: 'number' } }), { ownerId: 'owner' });
    expect(result).toMatchObject({ kind: 'value', observation: { value: 1.0963, excerpt: expect.stringContaining('2026-11-24'), observedAt: at } });
  });

  it('reads a typed weather field from the recorded Open-Meteo response', async () => {
    class FixtureNetwork extends SafeNetwork {
      override async request(target: string, options?: Parameters<SafeNetwork['request']>[1]) {
        await options?.beforeDispatch?.();
        const address = new URL(target);
        if (address.pathname === '/robots.txt') return { status: 404, headers: {}, body: Buffer.alloc(0), url: target };
        expect(address.origin).toBe('https://api.open-meteo.com');
        expect(address.pathname).toBe('/v1/forecast');
        return { status: 200, headers: {}, body: Buffer.from(forecast), url: target };
      }
    }
    const reader = createMonitorReader({ db, network: new FixtureNetwork(), clock: () => Date.parse(at) });
    const spec = page({ source: { kind: 'weather', location: 'London', latitude: 51.51, longitude: -0.13, metric: 'wind' },
      read: { kind: 'number' } });
    expect(await reader.read(spec, { ownerId: 'owner' })).toMatchObject({
      kind: 'value', observation: { value: 10.1, excerpt: expect.stringContaining('10.1 km/h'), observedAt: at },
    });
  });

  it('limits background status lookups to the owner’s own run', async () => {
    const runId = 'b3b66091-043d-4b4c-8af7-c26c4b4ff235';
    const selectFrom = vi.fn((_table: string) => {
      const filters = new Map<string, string>();
      const query = {
        select: () => query,
        where(column: string, _operator: string, expected: string) {
          filters.set(column, expected);
          return query;
        },
        async executeTakeFirst() {
          return filters.get('id') === runId && filters.get('owner_id') === 'owner'
            ? { status: 'completed', updated_at: new Date(at) } : undefined;
        },
      };
      return query;
    });
    const reader = createMonitorReader({ db: { selectFrom } as unknown as Kysely<any> });
    const spec = page({ source: { kind: 'run', runId }, read: { kind: 'status' } });
    expect(await reader.read(spec, { ownerId: 'other' })).toEqual({ kind: 'missing' });
    expect(await reader.read(spec, { ownerId: 'owner' })).toMatchObject({ kind: 'value', observation: { value: 'completed' } });
    expect(selectFrom).toHaveBeenNthCalledWith(1, 'chat_runs');
  });

  it('excludes unsafe search results and deduplicates tracked URL variants', async () => {
    const search = vi.fn(async () => [
      { title: 'Private', url: 'https://127.0.0.1', snippet: '' },
      { title: 'First', url: 'https://example.org/listing?utm_source=a', snippet: '' },
      { title: 'First', url: 'https://example.org/listing?utm_source=b', snippet: '' },
    ]);
    const provider: SearchProvider = { name: 'fixture', search };
    const reader = createMonitorReader({ db, searchProvider: provider });
    const result = await reader.read(page({ source: { kind: 'search', query: 'Festival listing' }, read: { kind: 'items' } }), { ownerId: 'owner' });
    expect(result).toMatchObject({ kind: 'value', observation: { value: ['First'], itemKeys: ['https://example.org/listing'] } });
    expect(search).toHaveBeenCalledExactlyOnceWith('Festival listing', 10, undefined);
  });
});
