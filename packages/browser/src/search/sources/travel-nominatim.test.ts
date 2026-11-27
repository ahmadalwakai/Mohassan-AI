import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SafeNetwork, type SafeResponse } from '../../network.js';
import { compileQuery } from '../ranking.js';
import { cairo, london, missing, publicRobots } from './travel-nominatim-fixtures.js';

const signal = () => new AbortController().signal;
const lookup = (place: string) => compileQuery(`Where is ${place}?`);
const english = lookup(london.address.city);
const arabic = compileQuery(`أين يقع ${cairo.address.city}؟`);
const absent = lookup(missing.query);
const ALLOW_SEARCH = 'User-agent: *\nAllow: /search\n';

function fixture(robots = ALLOW_SEARCH, userAgent?: string) {
  const network = new SafeNetwork({ userAgent });
  const dispatched: { url: URL; at: number }[] = [];
  const respond = (status: number, body = '', headers: Record<string, string> = {}) => ({
    status, headers, body: Buffer.from(body), url: dispatched.at(-1)!.url.href,
  });
  const result = (data: unknown) => respond(200, JSON.stringify(data), { 'content-type': 'application/json' });
  let search = (url: URL): SafeResponse => {
    const subject = url.searchParams.get('q');
    if (subject === london.address.city) return result([london]);
    if (subject === cairo.address.city) return result([cairo]);
    if (subject === missing.query) return result(missing.results);
    throw new Error(`Unexpected fixture query: ${subject}`);
  };
  let policy = () => respond(200, robots);
  vi.spyOn(network, 'request').mockImplementation(async (input, options) => {
    const url = network.validate(input, options?.allowedOrigins);
    await options?.beforeDispatch?.();
    options?.signal?.throwIfAborted();
    dispatched.push({ url, at: Date.now() });
    if (url.pathname === '/robots.txt') return policy();
    if (url.pathname === '/search') return search(url);
    throw new Error(`Unexpected fixture path: ${url.pathname}`);
  });
  return {
    network, dispatched, respond,
    setSearch(handler: typeof search) { search = handler; },
    setRobots(handler: typeof policy) { policy = handler; },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-27T00:00:00Z'));
  vi.resetModules();
});
afterEach(() => vi.useRealTimers());

describe('OpenStreetMap Nominatim', () => {
  it('honors the recorded public robots policy and never reaches search', async () => {
    const { nominatimProvider } = await import('./travel-nominatim.js');
    const fake = fixture(publicRobots);
    const provider = nominatimProvider(fake.network, Date.now);
    expect(provider.supports(english)).toBe(true);
    await expect(provider.search(english, 1, signal())).rejects.toMatchObject({ code: 'RESEARCH_ROBOTS_DENIED' });
    expect(fake.dispatched.map(({ url }) => url.pathname)).toEqual(['/robots.txt']);
  });

  it('checks the robots group for the identifying product actually configured', async () => {
    const { nominatimProvider } = await import('./travel-nominatim.js');
    const fake = fixture(`${ALLOW_SEARCH}\nUser-agent: Mohassan-Test\nDisallow: /search`, 'Mohassan-Test/1.0 (test)');
    const provider = nominatimProvider(fake.network, Date.now);
    await expect(provider.search(english, 1, signal())).rejects.toMatchObject({ code: 'RESEARCH_ROBOTS_DENIED' });
    expect(fake.dispatched.map(({ url }) => url.pathname)).toEqual(['/robots.txt']);
  });

  it.each([403, 302])('keeps search unavailable when the robots request returns %i without a usable policy', async status => {
    const { nominatimProvider } = await import('./travel-nominatim.js');
    const fake = fixture();
    fake.setRobots(() => fake.respond(status, '', { location: '/search' }));
    const provider = nominatimProvider(fake.network, Date.now);
    await expect(provider.search(english, 1, signal())).rejects.toMatchObject({ kind: 'unavailable' });
    expect(fake.dispatched.map(({ url }) => url.pathname)).toEqual(['/robots.txt']);
  });

  it('emits the English and Arabic display names, administrative areas, coordinates, map links and ODbL attribution', async () => {
    const { nominatimProvider } = await import('./travel-nominatim.js');
    const fake = fixture();
    const provider = nominatimProvider(fake.network, Date.now);
    expect(provider.planned.domains).toEqual(['travel']);
    expect(provider.supports(arabic)).toBe(true);
    const first = provider.search(english, 1, signal());
    await vi.advanceTimersByTimeAsync(1000);
    const [en] = await first;
    expect(en).toMatchObject({ title: london.display_name, url: `https://www.openstreetmap.org/node/${london.osm_id}` });
    const hierarchy = [london.address.city, london.address.state_district, london.address.state, london.address.country].join(', ');
    expect(en.snippet).toContain(`Administrative hierarchy: ${hierarchy}`);
    expect(en.snippet).toContain(`${london.lat}, ${london.lon}`);
    await vi.advanceTimersByTimeAsync(1000);
    const [ar] = await provider.search(arabic, 1, signal());
    expect(ar.title).toBe(cairo.display_name);
    expect(ar.snippet).toContain(`التسلسل الإداري: ${cairo.address.city}، ${cairo.address.country}`);
    expect(ar.snippet).toContain(`${cairo.lat}, ${cairo.lon}`);
    expect(new URL(ar.url).hostname).toBe('www.openstreetmap.org');
    expect(new URL(ar.url).searchParams.get('mlat')).toBe(cairo.lat);
    expect(new URL(ar.url).searchParams.get('mlon')).toBe(cairo.lon);
    for (const hit of [en, ar]) {
      expect(hit.snippet).toContain('© OpenStreetMap contributors (ODbL 1.0)');
      expect(hit.snippet).toContain('https://www.openstreetmap.org/copyright');
    }
    expect(fake.dispatched.slice(1).map(({ url }) => Object.fromEntries(url.searchParams))).toEqual([
      { q: london.address.city, format: 'jsonv2', addressdetails: '1', limit: '5', 'accept-language': 'en' },
      { q: cairo.address.city, format: 'jsonv2', addressdetails: '1', limit: '5', 'accept-language': 'ar' },
    ]);
  });

  it('gates every request across factories, allows cache hits during the gate and caches a missing place', async () => {
    const { nominatimProvider } = await import('./travel-nominatim.js');
    const first = fixture(), second = fixture();
    const one = nominatimProvider(first.network, Date.now), two = nominatimProvider(second.network, () => Date.now());
    const pending = one.search(english, 1, signal());
    await vi.advanceTimersByTimeAsync(999);
    await expect(two.search(absent, 1, signal())).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 1 });
    expect(first.dispatched).toHaveLength(1);
    expect(second.dispatched).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    const hits = await pending;
    expect(first.dispatched[1].at - first.dispatched[0].at).toBe(1000);
    await expect(two.search(lookup(`  ${london.address.city} `), 5, signal())).resolves.toEqual(hits);
    expect(second.dispatched).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(999);
    await expect(two.search(absent, 1, signal())).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 1 });
    await vi.advanceTimersByTimeAsync(1);
    const empty = two.search(absent, 1, signal());
    await vi.advanceTimersByTimeAsync(1000);
    await expect(empty).resolves.toEqual([]);
    expect(second.dispatched[0].at - first.dispatched[1].at).toBe(1000);
    expect(second.dispatched[1].at - second.dispatched[0].at).toBe(1000);
    await expect(one.search(absent, 1, signal())).resolves.toEqual([]);
    expect(first.dispatched).toHaveLength(2);
    expect(second.dispatched).toHaveLength(2);
  });

  it('refreshes a cached miss after its local retention period', async () => {
    const { nominatimProvider } = await import('./travel-nominatim.js');
    const fake = fixture();
    const provider = nominatimProvider(fake.network, Date.now);
    const initial = provider.search(absent, 1, signal());
    await vi.advanceTimersByTimeAsync(1000);
    await expect(initial).resolves.toEqual([]);
    await vi.advanceTimersByTimeAsync(59_999);
    await expect(provider.search(absent, 1, signal())).resolves.toEqual([]);
    expect(fake.dispatched).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(provider.search(absent, 1, signal())).resolves.toEqual([]);
    expect(fake.dispatched).toHaveLength(3);
  });

  it.each(['/robots.txt', '/search'])('honors a 429 Retry-After from %s across factories', async path => {
    const { nominatimProvider } = await import('./travel-nominatim.js');
    const fake = fixture();
    const provider = nominatimProvider(fake.network, Date.now);
    // A deterministic throttle scenario based on RFC 6585 section 4. Checked 2026-11-27.
    // https://www.rfc-editor.org/rfc/rfc6585#section-4
    const seconds = 12;
    const tooMany = () => fake.respond(429, '', { 'retry-after': String(seconds) });
    if (path === '/robots.txt') fake.setRobots(tooMany);
    else fake.setSearch(tooMany);
    const rejected = expect(provider.search(english, 1, signal())).rejects.toMatchObject({
      kind: 'rate_limited', retryAfterMs: seconds * 1000,
    });
    await vi.advanceTimersByTimeAsync(path === '/search' ? 1000 : 0);
    await rejected;
    const repeat = nominatimProvider(fake.network, Date.now);
    const attempts = fake.dispatched.length;
    await vi.advanceTimersByTimeAsync(seconds * 1000 - 1);
    await expect(repeat.search(absent, 1, signal())).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 1 });
    expect(fake.dispatched).toHaveLength(attempts);
    fake.setRobots(() => fake.respond(200, ALLOW_SEARCH));
    fake.setSearch(() => fake.respond(200, '[]', { 'content-type': 'application/json' }));
    await vi.advanceTimersByTimeAsync(1);
    const retry = repeat.search(absent, 1, signal());
    await vi.advanceTimersByTimeAsync(1000);
    await expect(retry).resolves.toEqual([]);
    expect(fake.dispatched).toHaveLength(attempts + 2);
  });

  it('releases an aborted request between the policy check and search without dispatching the lookup', async () => {
    const { nominatimProvider } = await import('./travel-nominatim.js');
    const fake = fixture();
    const controller = new AbortController();
    const provider = nominatimProvider(fake.network, Date.now);
    const rejected = expect(provider.search(english, 1, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await rejected;
    expect(fake.dispatched.map(({ url }) => url.pathname)).toEqual(['/robots.txt']);
    await vi.advanceTimersByTimeAsync(500);
    await expect(provider.search(english, 1, signal())).resolves.toHaveLength(1);
    expect(fake.dispatched.map(({ url }) => url.pathname)).toEqual(['/robots.txt', '/search']);
  });

  it('never geocodes a guide or directions request even if selected by a travel plan', async () => {
    const { nominatimProvider } = await import('./travel-nominatim.js');
    const fake = fixture();
    const provider = nominatimProvider(fake.network, Date.now);
    for (const question of ['Things to do in London', 'How do I get to London from the airport?']) {
      const query = compileQuery(question);
      expect(provider.supports(query)).toBe(false);
      await expect(provider.search(query, 1, signal())).resolves.toEqual([]);
    }
    expect(fake.dispatched).toEqual([]);
  });
});
