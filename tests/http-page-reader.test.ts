import { afterEach, expect, it, vi } from 'vitest';
import { RobotsPolicy, SafeNetwork, type SafeResponse } from '@mohassan/browser';
import { createHttpPageReader } from '../apps/server/src/assistant/http-page-reader.js';

const wiki = 'https://en.wikipedia.org/wiki/';
const otherWiki = 'https://ar.wikipedia.org/wiki/';
const signal = () => new AbortController().signal;
const allowed = { assertAllowed: async () => {} };

function response(url: string, status = 200, retryAfter?: string): SafeResponse {
  return {
    url, status,
    headers: { 'content-type': 'text/html', ...(retryAfter === undefined ? {} : { 'retry-after': retryAfter }) },
    body: Buffer.from('<title>Article</title><p>Test article.</p>'),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => vi.restoreAllMocks());

it('waits for a short Retry-After and retries the page once', async () => {
  const calls: number[] = [];
  const request = vi.fn(async (url: string) => {
    calls.push(Date.now());
    return calls.length === 1 ? response(url, 429, '1') : response(url);
  });
  const read = createHttpPageReader({ request }, allowed);

  await expect(read(wiki + 'Article', signal())).resolves.toMatchObject({ status: 200, text: 'Test article.' });
  expect(request).toHaveBeenCalledTimes(2);
  expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(1000);
});

it.each([429, 404])('reports a rate limit when a single retry returns HTTP %i', async status => {
  const request = vi.fn<(url: string) => Promise<SafeResponse>>()
    .mockImplementationOnce(async url => response(url, 429, '0'))
    .mockImplementationOnce(async url => response(url, status, '0'));
  const read = createHttpPageReader({ request }, allowed);

  await expect(read(wiki + 'Article', signal())).resolves.toEqual({ kind: 'rate-limited', retryAfterMs: 0 });
  expect(request).toHaveBeenCalledTimes(2);
});

it('returns an HTTP-date Retry-After above the wait budget and defers other pages on that host', async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const retry = new Date(now + 30_000);
  retry.setUTCMilliseconds(0);
  const retryAfterMs = retry.getTime() - now;
  const first = wiki + 'Article';
  const second = wiki + 'Another';
  const request = vi.fn(async (url: string) => url === first ? response(url, 429, retry.toUTCString()) : response(url));
  const read = createHttpPageReader({ request }, allowed);

  await expect(read(first, signal())).resolves.toEqual({ kind: 'rate-limited', retryAfterMs });
  clock.mockReturnValue(now + 2000);
  await expect(read(second, signal())).resolves.toEqual({ kind: 'rate-limited', retryAfterMs: retryAfterMs - 2000 });
  expect(request).toHaveBeenCalledTimes(1);
  await expect(read(otherWiki + 'Article', signal())).resolves.toMatchObject({ status: 200 });
  clock.mockReturnValue(retry.getTime());
  await expect(read(second, signal())).resolves.toMatchObject({ status: 200 });
  expect(request.mock.calls.map(([url]) => url)).toEqual([first, otherWiki + 'Article', second]);
});

it('skips the article when robots.txt is rate-limited and carries the same retry delay', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  const network = new SafeNetwork();
  const request = vi.spyOn(network, 'request').mockImplementation(async url => response(url, 429, '30'));
  const read = createHttpPageReader(network, new RobotsPolicy(network));

  await expect(read(wiki + 'Article', signal())).resolves.toEqual({ kind: 'rate-limited', retryAfterMs: 30_000 });
  expect(request.mock.calls.map(([url]) => url)).toEqual(['https://en.wikipedia.org/robots.txt']);
});

it('serializes reads per Wikimedia host and allows another host to run in parallel', async () => {
  const first = wiki + 'Article';
  const second = wiki + 'Another';
  const started = deferred();
  const finish = deferred();
  const request = vi.fn(async (url: string) => {
    if (url === first) {
      started.resolve();
      await finish.promise;
    }
    return response(url);
  });
  const read = createHttpPageReader({ request }, allowed);

  const inFlight = read(first, signal());
  await started.promise;
  const queued = read(second, signal());
  await expect(read(otherWiki + 'Article', signal())).resolves.toMatchObject({ status: 200 });
  expect(request.mock.calls.map(([url]) => url)).toEqual([first, otherWiki + 'Article']);
  finish.resolve();
  await inFlight;
  await expect(queued).resolves.toMatchObject({ status: 200 });
  expect(request.mock.calls.map(([url]) => url)).toEqual([first, otherWiki + 'Article', second]);
});

it('honors cancellation while a Wikimedia read is queued', async () => {
  const first = wiki + 'Article';
  const started = deferred();
  const finish = deferred();
  const request = vi.fn(async (url: string) => {
    started.resolve();
    await finish.promise;
    return response(url);
  });
  const read = createHttpPageReader({ request }, allowed);
  const controller = new AbortController();
  const inFlight = read(first, signal());
  await started.promise;
  const queued = read(wiki + 'Cancelled', controller.signal);
  controller.abort();
  await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
  finish.resolve();
  await inFlight;
  expect(request).toHaveBeenCalledTimes(1);
});
