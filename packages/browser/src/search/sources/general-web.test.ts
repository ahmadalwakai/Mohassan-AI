import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SafeNetwork, type SafeResponse } from '../../network.js';
import { SearchProviderFailure } from '../providers.js';
import { compileQuery } from '../ranking.js';
import { arabicQuery, arabicResult, englishQuery, englishResult, rateLimitHeaders } from './fixtures/general-web.js';
import { generalWebProviders } from './general-web.js';

// The endpoint and bounds come from Brave's POST API reference, retrieved
// 2026-11-27. https://api-dashboard.search.brave.com/api-reference/web/search/post
const apiUrl = 'https://api.search.brave.com/res/v1/web/search';
const robotsUrl = 'https://api.search.brave.com/robots.txt';
const testKey = 'fixture-only-subscription-value';
const owner = { role: 'owner' } as const;
const member = { role: 'member' } as const;
const now = () => Date.parse('2026-11-27T00:00:00Z');
const signal = () => new AbortController().signal;
const responseBody = (...results: unknown[]) => JSON.stringify({ type: 'search', web: { type: 'search', results } });

function fakeNetwork(body = responseBody(englishResult), status = 200, headers: SafeResponse['headers'] = {}) {
  const network = new SafeNetwork();
  const request = vi.spyOn(network, 'request').mockImplementation(async url => {
    if (url === robotsUrl) {
      // Observed unauthenticated HTTP 403 on 2026-11-27. RobotsPolicy treats
      // this as unavailable under RFC 9309 §2.3.1.3.
      return { url, status: 403, headers: {}, body: Buffer.alloc(0) };
    }
    if (url !== apiUrl) throw new Error('Unexpected network destination');
    return { url, status, headers: { 'content-type': 'application/json', ...headers }, body: Buffer.from(body) };
  });
  return { network, request };
}

beforeEach(() => {
  vi.stubEnv('SEARCH_GENERAL_WEB_PROVIDER', 'brave');
  vi.stubEnv('BRAVE_SEARCH_API_KEY', testKey);
  vi.stubEnv('SEARCH_GENERAL_WEB_ROLES', undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Brave general web search provider', () => {
  it.each([
    { variable: 'SEARCH_GENERAL_WEB_PROVIDER', value: undefined },
    { variable: 'SEARCH_GENERAL_WEB_PROVIDER', value: 'off' },
    { variable: 'SEARCH_GENERAL_WEB_PROVIDER', value: 'unknown' },
    { variable: 'BRAVE_SEARCH_API_KEY', value: undefined },
    { variable: 'BRAVE_SEARCH_API_KEY', value: '  ' },
    { variable: 'SEARCH_GENERAL_WEB_ROLES', value: 'member' },
  ])('stays disabled without valid $variable configuration', ({ variable, value }) => {
    vi.stubEnv(variable, value);
    const { network, request } = fakeNetwork();
    expect(generalWebProviders(network, now)).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it('requires a verified owner by default and only supports unscoped general questions without a source plan', async () => {
    const { network, request } = fakeNetwork();
    const [provider] = generalWebProviders(network, now);
    const query = compileQuery(englishQuery);
    expect(provider.planned).toMatchObject({
      domains: ['general_web'], hosts: [], languages: expect.arrayContaining(['ar', 'en']), access: 'documented_api',
    });
    expect(provider.supports(query)).toBe(false);
    expect(provider.supports(query, member)).toBe(false);
    expect(provider.supports(query, owner)).toBe(true);
    expect(provider.supports(compileQuery('learn Python programming'), owner)).toBe(false);
    expect(provider.supports(compileQuery('solar energy research paper'), owner)).toBe(false);
    expect(provider.supports(compileQuery(`${englishQuery} site:tripadvisor.com`), owner)).toBe(false);
    await expect(provider.search(query, 5, signal())).resolves.toEqual([]);
    await expect(provider.search(query, 5, signal(), member)).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it('permits verified members when the owner selects all accounts', async () => {
    vi.stubEnv('SEARCH_GENERAL_WEB_ROLES', 'all');
    const { network, request } = fakeNetwork();
    const [provider] = generalWebProviders(network, now);
    const query = compileQuery(englishQuery);
    expect(provider.supports(query, owner)).toBe(true);
    expect(provider.supports(query, member)).toBe(true);
    expect(provider.supports(query)).toBe(false);
    await expect(provider.search(query, 5, signal())).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
    await expect(provider.search(query, 5, signal(), member)).resolves.toHaveLength(1);
    expect(request.mock.calls.map(([url]) => url)).toEqual([robotsUrl, apiUrl]);
  });

  it.each([
    {
      text: englishQuery,
      result: englishResult,
      search_lang: 'en',
      country: 'US',
      snippet: 'Best Greek Restaurants in San Francisco , California: Find Tripadvisor traveller reviews of San Francisco',
    },
    { text: arabicQuery, result: arabicResult, search_lang: 'ar', country: 'ALL', snippet: arabicResult.description },
  ])('maps $search_lang content and sends only the query and search options', async ({ text, result, search_lang, country, snippet }) => {
    const { network, request } = fakeNetwork(responseBody(result));
    const [provider] = generalWebProviders(network, now);
    const query = compileQuery(text);
    expect(provider.supports(query, owner)).toBe(true);
    await expect(provider.search(query, 100, signal(), owner)).resolves.toEqual([{
      title: result.title, url: result.url, snippet, ...('page_age' in result ? { pageAge: result.page_age } : {}),
    }]);
    expect(request.mock.calls.map(([url]) => url)).toEqual([robotsUrl, apiUrl]);
    const robots = request.mock.calls[0]?.[1];
    expect(robots?.headers).toBeUndefined();
    expect(robots?.body).toBeUndefined();
    const options = request.mock.calls[1]?.[1];
    expect(options?.method).toBe('POST');
    const requestHeaders = new Headers(options?.headers);
    expect(requestHeaders.get('x-subscription-token') === testKey).toBe(true);
    requestHeaders.delete('x-subscription-token');
    expect(Object.fromEntries(requestHeaders)).toEqual({ accept: 'application/json', 'content-type': 'application/json' });
    const body = options?.body?.toString() ?? '';
    expect(body.includes(testKey)).toBe(false);
    expect(JSON.parse(body)).toEqual({
      q: query.retrievalQuestion, count: 20, search_lang, country, result_filter: ['web'], text_decorations: false,
    });
  });

  it('does not contact the endpoint when robots disallows it', async () => {
    const { network, request } = fakeNetwork();
    request.mockResolvedValueOnce({
      url: robotsUrl, status: 200, headers: {}, body: Buffer.from('User-agent: *\nDisallow: /res/v1/web/search'),
    });
    const [provider] = generalWebProviders(network, now);
    await expect(provider.search(compileQuery(englishQuery), 5, signal(), owner)).rejects.toBeInstanceOf(Error);
    expect(request.mock.calls.map(([url]) => url)).toEqual([robotsUrl]);
  });

  it('honors the depleted 429 window and the longer Retry-After without reissuing a request', async () => {
    let clock = now();
    const { network, request } = fakeNetwork('', 429, { ...rateLimitHeaders, 'retry-after': '8' });
    const [provider] = generalWebProviders(network, () => clock);
    const query = compileQuery(englishQuery);
    await expect(provider.search(query, 5, signal(), owner)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 8000 });
    expect(provider.cooldownMs?.()).toBe(8000);
    clock += 7999;
    await expect(provider.search(query, 5, signal(), owner)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(provider.cooldownMs?.()).toBe(1);
    expect(request.mock.calls.map(([url]) => url)).toEqual([robotsUrl, apiUrl]);
  });

  it('honors the longest exhausted window even if Retry-After is shorter', async () => {
    const quotaResetSeconds = Number(rateLimitHeaders['x-ratelimit-reset'].split(',')[1]);
    const { network } = fakeNetwork('', 429, { ...rateLimitHeaders, 'x-ratelimit-remaining': '0, 0', 'retry-after': '8' });
    const [provider] = generalWebProviders(network, now);
    await expect(provider.search(compileQuery(englishQuery), 5, signal(), owner)).rejects.toMatchObject({
      kind: 'rate_limited', retryAfterMs: quotaResetSeconds * 1000,
    });
  });

  it('also records primary quota cooldown after a successful response', async () => {
    const { network, request } = fakeNetwork(responseBody(englishResult), 200, rateLimitHeaders);
    const [provider] = generalWebProviders(network, now);
    const query = compileQuery(englishQuery);
    await expect(provider.search(query, 5, signal(), owner)).resolves.toHaveLength(1);
    expect(provider.cooldownMs?.()).toBe(1000);
    await expect(provider.search(query, 5, signal(), owner)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(request.mock.calls.map(([url]) => url)).toEqual([robotsUrl, apiUrl]);
  });

  it('ignores the monthly reset when the plan declares an unlimited monthly quota', async () => {
    // Brave's rate-limit guide documents 0 as the unlimited monthly limit.
    // https://api-dashboard.search.brave.com/documentation/guides/rate-limiting#x-ratelimit-limit
    // Checked 2026-11-27.
    const { 'x-ratelimit-limit': _limit, ...headers } = rateLimitHeaders;
    const { network } = fakeNetwork('', 429, {
      ...headers, 'x-ratelimit-policy': '1;w=1, 0;w=2592000', 'x-ratelimit-remaining': '0, 0',
    });
    const [provider] = generalWebProviders(network, now);
    await expect(provider.search(compileQuery(englishQuery), 5, signal(), owner)).rejects.toMatchObject({
      kind: 'rate_limited', retryAfterMs: 1000,
    });
  });

  it('keeps key echoes out of every log, exposed error, result, and outbound URL', async () => {
    const logs = (['debug', 'info', 'log', 'warn', 'error', 'trace'] as const).map(method =>
      vi.spyOn(console, method).mockImplementation(() => {}));
    const { network, request } = fakeNetwork();
    const query = compileQuery(englishQuery);
    const [provider] = generalWebProviders(network, now);
    request.mockResolvedValueOnce({ url: robotsUrl, status: 403, headers: {}, body: Buffer.alloc(0) });
    request.mockResolvedValueOnce({
      url: apiUrl,
      status: 401,
      headers: {},
      body: Buffer.from(JSON.stringify({ error: { message: testKey } })),
    });
    const errorResponse: unknown = await provider.search(query, 5, signal(), owner).catch(error => error);
    request.mockRejectedValueOnce(new Error(testKey));
    const transportError: unknown = await provider.search(query, 5, signal(), owner).catch(error => error);
    const escapedKey = [...testKey].map(char => `%${char.charCodeAt(0).toString(16)}`).join('');
    request.mockResolvedValueOnce({
      url: apiUrl,
      status: 200,
      headers: {},
      body: Buffer.from(responseBody(
        englishResult,
        { ...englishResult, url: `https://www.tripadvisor.com/${escapedKey}` },
        { ...englishResult, title: testKey, description: testKey, page_age: testKey },
      )),
    });
    const hits = await provider.search(query, 5, signal(), owner);
    expect(hits.length).toBeGreaterThan(0);
    expect(errorResponse).toBeInstanceOf(SearchProviderFailure);
    expect(transportError).toBeInstanceOf(SearchProviderFailure);
    await provider.search(compileQuery(`${englishQuery} ${testKey}`), 5, signal(), owner).catch(() => undefined);
    expect(request.mock.calls.map(([url]) => url)).toEqual([robotsUrl, apiUrl, apiUrl, apiUrl]);
    const exposed = [errorResponse, transportError, hits, ...logs.flatMap(log => log.mock.calls), ...request.mock.calls.map(([url]) => url)];
    expect(exposed.every(value => !inspect(value, { depth: null }).includes(testKey))).toBe(true);
    expect(hits.every(({ url }) => !url.includes(escapedKey))).toBe(true);
    expect(request.mock.calls.every(([, options]) => !options?.body?.toString().includes(testKey))).toBe(true);
  });
});

it('scopes the secret header and returned quota headers to the exact Brave Web Search POST', async () => {
  const braveOrigin = new URL(apiUrl).origin;
  const otherOrigin = 'https://api-dashboard.search.brave.com';
  const network = new SafeNetwork({ testOrigins: [braveOrigin, otherOrigin] });
  const sentToken: boolean[] = [];
  const request = vi.spyOn(https, 'request').mockImplementation(((
    _url: URL, options: https.RequestOptions, onResponse: (response: IncomingMessage) => void,
  ) => {
    const headers = options.headers as Record<string, string>;
    sentToken.push(headers['x-subscription-token'] === testKey);
    const socket = new EventEmitter();
    return Object.assign(socket, {
      end() {
        const response = Object.assign(new EventEmitter(), {
          headers: { ...rateLimitHeaders, 'x-subscription-token': testKey },
          statusCode: 429,
        });
        onResponse(response as unknown as IncomingMessage);
        response.emit('end');
        socket.emit('close');
      },
    });
  }) as unknown as typeof https.request);

  const headers = { 'X-Subscription-Token': testKey };
  const matched = await network.request(apiUrl, { method: 'POST', headers });
  const unmatched = await Promise.all([
    network.request(apiUrl, { headers }),
    network.request(`${apiUrl}/other`, { method: 'POST', headers }),
    network.request(`${apiUrl}?q=other`, { method: 'POST', headers }),
    network.request(new URL(new URL(apiUrl).pathname, otherOrigin).href, { method: 'POST', headers }),
  ]);
  expect(sentToken).toEqual([true, false, false, false, false]);
  expect(matched.headers['x-subscription-token'] === undefined).toBe(true);
  expect(matched.headers).toEqual(rateLimitHeaders);
  expect(unmatched.map(response => response.headers)).toEqual([{}, {}, {}, {}]);
  expect(request.mock.calls.every(([url]) => !String(url).includes(testKey))).toBe(true);
});
