import { describe, expect, it, vi } from 'vitest';
import { SafeNetwork, type SafeResponse } from '../../network.js';
import { compileQuery } from '../ranking.js';
import fixture from './fixtures/programming-mdn.json' with { type: 'json' };
import { programmingProviders } from './programming.js';

const clock = Date.parse(fixture.checked) + 24 * 60 * 60 * 1000;
const readDate = new Date(clock).toISOString().slice(0, 10);

function adapter(robots = fixture.robots.body) {
  const network = new SafeNetwork();
  const responses = new Map([fixture.index, ...fixture.metadata].map(({ url, body }) => [url, {
    url, status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)),
  }]));
  responses.set(fixture.robots.url, {
    url: fixture.robots.url, status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from(robots),
  });
  const request = vi.spyOn(network, 'request').mockImplementation(async (url, options): Promise<SafeResponse> => {
    options?.signal?.throwIfAborted();
    const response = responses.get(url);
    if (!response) throw new Error(`Unrecorded fixture route ${url}`);
    return response;
  });
  const provider = programmingProviders(network, () => clock).find(item => item.name === 'MDN Web Docs');
  if (!provider) throw new Error('Missing MDN Web Docs provider');
  return { provider, urls: () => request.mock.calls.map(([url]) => url) };
}

describe('MDN Web Docs programming provider', () => {
  it.each(['CSS grid layout', 'شرح CSS grid layout'])('returns one attributed MDN summary for %s', async question => {
    const { provider, urls } = adapter();
    const query = compileQuery(question);
    const grid = fixture.metadata.find(page => page.body.title === 'CSS grid layout')!;

    expect(provider.supports(query)).toBe(true);
    const hits = await provider.search(query, 1, new AbortController().signal);
    expect(urls()).toEqual([fixture.robots.url, fixture.index.url, grid.url]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ title: grid.body.title, url: new URL(grid.body.mdn_url, grid.url).href });
    for (const text of [grid.body.summary, 'Mozilla Contributors', fixture.license, readDate]) {
      expect(hits[0].snippet).toContain(text);
    }
  });

  it('supports site scopes and web documentation without taking generic package or repository queries', () => {
    const { provider } = adapter();
    expect(provider.supports(compileQuery('Array.prototype.map() site:developer.mozilla.org'))).toBe(true);
    expect(provider.supports(compileQuery('CSS site:github.com'))).toBe(false);
    expect(provider.supports(compileQuery('best JavaScript library for terminal colors'))).toBe(false);
    expect(provider.supports(compileQuery('repository for CSS grid'))).toBe(false);
  });

  it('identifies an excerpt whose original formatting was edited', async () => {
    const { provider } = adapter();
    const map = fixture.metadata.find(page => page.body.title === 'Array.prototype.map()')!;
    const query = compileQuery('Array.prototype.map() site:developer.mozilla.org');
    const [hit] = await provider.search(query, 1, new AbortController().signal);
    expect(hit?.snippet).toContain(map.body.summary.replace(/\n/g, ' '));
    expect(hit?.snippet).toContain('Edited excerpt');
  });

  it('checks robots before fetching a matched page’s metadata', async () => {
    const { provider, urls } = adapter(fixture.robots.body + '\nDisallow: /en-US/docs/Web/CSS/Guides/Grid_layout/metadata.json\n');
    await expect(provider.search(compileQuery('CSS grid layout'), 1, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'unavailable' });
    expect(urls()).toEqual([fixture.robots.url, fixture.index.url]);
  });
});
