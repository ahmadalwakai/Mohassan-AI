import { SafeNetwork, SearchEngine, type SearchProvider } from '@mohassan/browser';
import { afterEach, expect, it, vi } from 'vitest';
import type { WritingSource } from '../apps/server/src/assistant/writing/evidence.js';
import { gatherExplanationSources, sourceIdentity } from '../apps/server/src/assistant/writing/multisource/gather.js';

const source = (url: string, text = `Text observed on ${url}`): WritingSource => ({ url, text, title: 'Read fixture' });

function fixture(urls: readonly string[], read = async (url: string) => source(url)) {
  const provider: SearchProvider = { name: 'fixture', search: async () => [] };
  return { query: 'the tides', ownerId: 'owner-a', provider, signal: new AbortController().signal,
    search: vi.fn(async (_limit: number): Promise<readonly string[] | null> => urls),
    read: vi.fn<(url: string) => Promise<WritingSource | null>>(read) };
}

afterEach(() => vi.restoreAllMocks());

it('reads at most five successful or failed candidates, prioritizing distinct publishers over duplicate hits', async () => {
  const urls = Array.from({ length: 16 }, (_, index) => `https://publisher-${index}.test/article`);
  const ports = fixture([
    'javascript:void(0)', 'https://user:password@auth.test/doc', 'https://signed.test/doc?token=secret',
    `${urls[0]}#part`, urls[0], 'https://extra.publisher-0.test/nearby', ...urls.slice(1),
  ]);
  const result = await gatherExplanationSources(ports);
  expect(ports.search).toHaveBeenCalledExactlyOnceWith(12);
  expect(ports.read.mock.calls.map(([url]) => url)).toEqual(urls.slice(0, 5));
  expect(result.map(item => item.url)).toEqual(urls.slice(0, 5));
});

it('returns fewer sources after unreadable pages, final-URL duplicates and copied bodies', async () => {
  const first = 'https://primary.test/tides';
  const redirect = 'https://archive.test/tides';
  const mirror = 'https://mirror.test/tides';
  const empty = 'https://unreadable.test/tides';
  const corroborating = 'https://museum.test/tides';
  const sixth = 'https://school.test/tides';
  const body = 'The lunar cycle influences tides.';
  const ports = fixture([first, redirect, mirror, empty, corroborating, sixth]);
  ports.read.mockImplementation(async url => {
    if (url === first) return source(first, body);
    if (url === redirect) return source('https://data.primary.test/history', 'Another page from the same publisher.');
    if (url === mirror) return source(url, 'The lunar cycle\n influences tides.');
    if (url === empty) return null;
    return source(url);
  });
  const result = await gatherExplanationSources(ports);
  expect(ports.read).toHaveBeenCalledTimes(5);
  expect(result.map(item => item.url)).toEqual([first, corroborating]);
});

it('tries untouched publishers before alternate pages and excludes credential-bearing final URLs', async () => {
  const first = 'https://primary.test/tides';
  const alternate = 'https://archive.primary.test/tides';
  const others = ['https://museum.test/tides', 'https://school.test/tides', 'https://agency.test/tides'];
  const ports = fixture([first, alternate, ...others]);
  ports.read.mockImplementation(async url => {
    if (url === first) return null;
    if (url === others[0]) return source('https://closed.test/read?token=private');
    return source(url);
  });
  const result = await gatherExplanationSources(ports);
  expect(ports.read.mock.calls.map(([url]) => url)).toEqual([first, ...others, alternate]);
  expect(result.map(item => item.url)).toEqual([...others.slice(1), alternate]);
});

it('keeps publisher families together without grouping different publishers under a country suffix', () => {
  const id = (url: string) => sourceIdentity({ url });
  expect(id('https://en.wikipedia.org/A')).toBe(id('https://ar.wikipedia.org/A'));
  expect(id('https://www.bbc.co.uk/A')).toBe(id('https://bbc.com./B'));
  expect(id('https://docs.example.edu.au/A')).toBe(id('https://www.example.edu.au/B'));
  expect(id('https://docs.example.edu.au/A')).not.toBe(id('https://study.edu.au/B'));
  expect(sourceIdentity({})).toBeUndefined();
  expect(id('file:///tmp/local')).toBeUndefined();
});

it('caches only addresses by provider, owner and query, and returns to the read port every time', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100);
  const url = 'https://science.test/tides';
  const ports = fixture([url]);
  expect((await gatherExplanationSources(ports))[0].text).toBe(`Text observed on ${url}`);
  ports.read.mockResolvedValue(source(url, 'A new observation.'));
  expect((await gatherExplanationSources(ports))[0].text).toBe('A new observation.');
  expect(ports.search).toHaveBeenCalledTimes(1);
  expect(ports.read).toHaveBeenCalledTimes(2);

  await gatherExplanationSources({ ...ports, ownerId: 'owner-b' });
  await gatherExplanationSources({ ...ports, query: 'ocean tides' });
  await gatherExplanationSources({ ...ports, provider: { ...ports.provider } });
  expect(ports.search).toHaveBeenCalledTimes(4);

  clock.mockReturnValue(60_100);
  await gatherExplanationSources(ports);
  expect(ports.search).toHaveBeenCalledTimes(5);
});

it('leaves built-in search cache lookups in the provider and retries empty search results', async () => {
  const url = 'https://science.test/tides';
  const ports = fixture([url]);
  const builtIn = { ...ports, provider: new SearchEngine(new SafeNetwork(), { providers: [], publicWeb: false }) };
  await gatherExplanationSources(builtIn);
  await gatherExplanationSources(builtIn);
  expect(ports.search).toHaveBeenCalledTimes(2);

  ports.search.mockResolvedValueOnce(null);
  expect(await gatherExplanationSources(ports)).toEqual([]);
  expect((await gatherExplanationSources(ports)).map(item => item.url)).toEqual([url]);
  expect(ports.search).toHaveBeenCalledTimes(4);
});

it('propagates cancellation before search or after an empty search result', async () => {
  const controller = new AbortController();
  const ports = { ...fixture([]), signal: controller.signal };
  const cancelled = new Error('Run cancelled');
  ports.search.mockImplementation(async () => {
    controller.abort(cancelled);
    return [];
  });
  await expect(gatherExplanationSources(ports)).rejects.toBe(cancelled);
  await expect(gatherExplanationSources(ports)).rejects.toBe(cancelled);
  expect(ports.search).toHaveBeenCalledTimes(1);
  expect(ports.read).not.toHaveBeenCalled();
});

it('does not begin another batch after a read is cancelled', async () => {
  const controller = new AbortController();
  const urls = ['https://agency.test/tides', 'https://museum.test/tides', 'https://science.test/tides'];
  const ports = { ...fixture(urls), signal: controller.signal };
  const cancelled = new Error('Read cancelled');
  ports.read.mockImplementation(async url => {
    controller.abort(cancelled);
    return source(url);
  });
  await expect(gatherExplanationSources(ports)).rejects.toBe(cancelled);
  expect(ports.read.mock.calls.map(([url]) => url)).toEqual(urls.slice(0, 2));
});
