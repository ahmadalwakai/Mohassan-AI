import { createServer } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createDatabase, migrate } from '@mohassan/database';
import { SafeNetwork } from '../network.js';
import { SearchEngine } from './engine.js';
import { documentedProviders, searchRetryAfter } from './providers.js';
import { compileQuery } from './ranking.js';
import { migrateSearch, SqlSearchStore } from './store.js';

const time = Date.UTC(2026, 10, 9, 12);
const cases = [
  { label: 'seconds', header: '40', delay: 40_000 },
  { label: 'HTTP date', header: new Date(time + 40_000).toUTCString(), delay: 40_000 },
  { label: 'invalid header', header: 'not-a-date', delay: 60_000 },
  { label: 'negative seconds', header: '-1', delay: 60_000 },
  { label: 'fractional seconds', header: '1.5', delay: 60_000 },
  { label: 'ISO date', header: '2027-01-01', delay: 60_000 },
  { label: 'invalid calendar date', header: 'Tue, 31 Nov 2026 12:00:40 GMT', delay: 60_000 },
];
const providers = [
  { name: 'Wikipedia', question: 'Node API', nextQuestion: 'React hooks' },
  { name: 'Stack Exchange', question: 'Node API', nextQuestion: 'React hooks' },
  { name: 'Crossref', question: 'quantum research paper', nextQuestion: 'electron research paper' },
  { name: 'Hacker News', question: 'Node API', nextQuestion: 'React hooks' },
  { name: 'arXiv', question: 'quantum research paper', nextQuestion: 'electron research paper' },
];
let database: Awaited<ReturnType<typeof createDatabase>>;
let origin = '', retryAfter: string | undefined, received = 0;
const server = createServer((_request, response) => {
  received++;
  response.writeHead(503, retryAfter === undefined ? {} : { 'retry-after': retryAfter });
  response.end('Temporarily unavailable');
});
beforeAll(async () => {
  database = await createDatabase();
  await migrate(database.db);
  await migrateSearch(database.db);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
  received = 0;
  retryAfter = undefined;
  await database.db.deleteFrom('search_provider_admission').execute();
  await database.db.deleteFrom('search_provider_queries').execute();
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await database.close();
});
function fixture(name: string, now: () => number) {
  const network = new SafeNetwork({ testOrigins: [origin] });
  const request = network.request.bind(network);
  vi.spyOn(network, 'request').mockImplementation((url, options) => {
    const target = new URL(url);
    return request(origin + target.pathname + target.search, options);
  });
  const provider = documentedProviders(network, now).find(item => item.name === name)!;
  const engine = new SearchEngine(network, { providers: [provider], now, admission: new SqlSearchStore(database.db, now) });
  return { provider, engine };
}

describe.each(providers)('$name HTTP 503 cooldown', ({ name, question, nextQuestion }) => {
  it.each(cases)('shares $label Retry-After across engines without retrying the transport', async ({ header, delay }) => {
    retryAfter = header;
    const first = fixture(name, () => time);
    // Separate factories and unrelated local clocks: only the SQL gate can block the second engine.
    const second = fixture(name, () => time + 86_400_000);
    expect((await first.engine.execute(question, 5)).failures).toEqual([{ provider: name, kind: 'unavailable' }]);
    const row = await database.db.selectFrom('search_provider_admission')
      .select(['active_token', sql<number>`extract(epoch from (next_allowed_at-clock_timestamp()))`.as('remaining')])
      .where('provider', '=', name).executeTakeFirstOrThrow();
    expect(row.active_token).toBeNull();
    expect(Number(row.remaining)).toBeGreaterThan(delay / 1000 - 2);
    expect(Number(row.remaining)).toBeLessThanOrEqual(delay / 1000);
    expect((await second.engine.execute(nextQuestion, 5)).failures).toEqual([{ provider: name, kind: 'rate_limited' }]);
    expect(received).toBe(1);
  });

  it('preserves generic unavailability without a Retry-After header', async () => {
    const { provider } = fixture(name, () => time);
    await expect(provider.search(compileQuery(question), 5, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'unavailable', retryAfterMs: 0 });
    expect(received).toBe(1);
  });
});

describe.each(providers.filter(provider => ['Hacker News', 'arXiv'].includes(provider.name)))('$name process cooldown', ({ name, question, nextQuestion }) => {
  it('retains HTTP 503 Retry-After when the adapter is used without the engine', async () => {
    retryAfter = '40';
    const { provider } = fixture(name, () => time);
    await expect(provider.search(compileQuery(question), 5, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'unavailable', retryAfterMs: 40_000 });
    await expect(provider.search(compileQuery(nextQuestion), 5, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 40_000 });
    expect(received).toBe(1);
  });
});

describe('Retry-After HTTP grammar', () => {
  it.each([
    'Mon, 09 Nov 2026 12:00:40 GMT',
    'Monday, 09-Nov-26 12:00:40 GMT',
    'Mon Nov  9 12:00:40 2026',
  ])('accepts the required HTTP-date form %s', value => {
    expect(searchRetryAfter(value, time)).toBe(40_000);
  });

  it.each([
    '-1', '+1', '1.5', '1e3', '2027-01-01', '2026-11-09T12:00:40Z',
    'Mon, 09 Nov 2026 12:00:40 UTC', 'mon, 09 Nov 2026 12:00:40 GMT',
    'Tue, 09 Nov 2026 12:00:40 GMT', 'Mon, 09 Nov 2026 24:00:00 GMT',
    'Mon, 09 Nov 2026 12:60:00 GMT', 'Mon, 09 Nov 2026 12:00:61 GMT',
    'Mon, 09 Nov 2026 12:00:60 GMT', 'Fri, 29 Feb 2025 12:00:40 GMT',
    'Friday, 31-Apr-26 12:00:40 GMT', 'Fri Apr 31 12:00:40 2026',
  ])('uses the conservative fallback for malformed value %s', value => {
    expect(searchRetryAfter(value, time)).toBe(60_000);
  });

  it('retains zero, whitespace, past-date and maximum-delay behavior', () => {
    expect(searchRetryAfter('0', time)).toBe(0);
    expect(searchRetryAfter('\t 00040 \t', time)).toBe(40_000);
    expect(searchRetryAfter('9'.repeat(400), time)).toBe(86_400_000);
    expect(searchRetryAfter('Mon, 09 Nov 2026 11:59:59 GMT', time)).toBe(0);
    expect(searchRetryAfter('Tue, 10 Nov 2026 12:00:40 GMT', time)).toBe(86_400_000);
  });

  it('validates leap days and represents the permitted leap second without calendar rollover', () => {
    expect(searchRetryAfter('Thu, 29 Feb 2024 12:00:40 GMT', Date.UTC(2024, 1, 29, 12))).toBe(40_000);
    expect(searchRetryAfter('Sat, 31 Dec 2016 23:59:60 GMT', Date.UTC(2016, 11, 31, 23, 59, 59))).toBe(1000);
  });

  it('resolves obsolete two-digit years using the receipt date and the 50-year boundary', () => {
    const centuryTime = Date.UTC(2099, 11, 31, 23, 59, 30);
    expect(searchRetryAfter('Friday, 01-Jan-00 00:00:00 GMT', centuryTime)).toBe(30_000);
    const boundary = Date.UTC(2026, 10, 9, 12);
    const futureDate = new Date(Date.UTC(2076, 10, 9, 12));
    const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][futureDate.getUTCDay()];
    expect(searchRetryAfter(`${weekday}, 09-Nov-76 12:00:00 GMT`, boundary)).toBe(86_400_000);
    const pastWeekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(Date.UTC(1976, 10, 9)).getUTCDay()];
    expect(searchRetryAfter(`${pastWeekday}, 09-Nov-76 12:00:01 GMT`, boundary)).toBe(0);
  });
});
