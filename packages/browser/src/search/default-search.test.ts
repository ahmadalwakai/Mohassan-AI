import { describe, expect, it, vi } from 'vitest';
import { SafeNetwork } from '../network.js';
import { SearchEngine } from './engine.js';
import type { SearchHit } from '../research.js';

const rss = (hits: SearchHit[]) => `<rss><channel>${hits.map(hit => `<item><title>${hit.title}</title><link>${hit.url}</link><description>${hit.snippet}</description></item>`).join('')}</channel></rss>`;
const html = (hits: SearchHit[]) => hits.map(hit => `<div class="result"><h2><a class="result__a" href="${hit.url}">${hit.title}</a></h2><a class="result__snippet">${hit.snippet}</a></div>`).join('');
const wiki = { title: 'مواعيد المتحف الوطني', url: 'https://ar.wikipedia.org/wiki/مواعيد_المتحف_الوطني', snippet: 'مواعيد المتحف الوطني مواعيد المتحف الوطني' };
const museum = { title: 'المتحف الوطني', url: 'https://museum.example.org/visit', snippet: 'مواعيد الزيارة وحجز تذاكر المتحف الوطني' };

function fixture(bing: SearchHit[], duck: SearchHit[], options: { bingStatus?: number; duckStatus?: number } = {}) {
  const request = vi.fn(async (url: string) => {
    const target = new URL(url);
    const bingRequest = target.hostname === 'www.bing.com', duckRequest = target.hostname === 'html.duckduckgo.com';
    const body = bingRequest ? rss(bing) : duckRequest ? html(duck)
      : JSON.stringify({ query: { search: [{ title: wiki.title, snippet: wiki.snippet }] } });
    return { url, status: bingRequest ? options.bingStatus ?? 200 : duckRequest ? options.duckStatus ?? 200 : 200,
      headers: { 'content-type': bingRequest ? 'application/xml' : duckRequest ? 'text/html' : 'application/json' }, body: Buffer.from(body) };
  });
  return { request, network: Object.assign(new SafeNetwork(), { request }) };
}

describe('default public web search', () => {
  it('searches the web for ordinary Arabic questions and prefers the relevant service page over Wikipedia', async () => {
    const f = fixture([wiki, museum], [museum]);
    const result = await new SearchEngine(f.network).execute('المتحف الوطني', 5, undefined, { ownerId: 'owner' });
    expect(result.coverage).toBe('web_sources');
    expect(result.hits[0]).toMatchObject({ url: museum.url, providers: ['Bing RSS', 'DuckDuckGo HTML'] });
    expect(result.hits.at(-1)?.url).toBe(new URL(wiki.url).href);
    expect(f.request.mock.calls.map(([url]) => new URL(url).hostname)).toEqual(expect.arrayContaining(['www.bing.com', 'html.duckduckgo.com']));
  });

  it('still discovers the relevant site when Bing is blocked and DuckDuckGo needs its snippet to match the question', async () => {
    const f = fixture([], [museum], { bingStatus: 403 });
    const result = await new SearchEngine(f.network).execute('المتحف الوطني', 5);
    expect(result.hits[0]).toMatchObject({ url: museum.url, snippet: museum.snippet, providers: ['DuckDuckGo HTML'] });
    expect(result.failures).toContainEqual({ provider: 'Bing RSS', kind: 'unavailable' });
  });

  it('forwards site restrictions to both engines and filters results from other sites', async () => {
    const f = fixture([wiki, museum], [wiki, museum]);
    const result = await new SearchEngine(f.network).execute('مواعيد المتحف الوطني site:museum.example.org', 5);
    expect(result.hits.map(hit => hit.url)).toEqual([museum.url]);
    for (const [url] of f.request.mock.calls.filter(([url]) => !url.includes('wikipedia.org'))) {
      expect(new URL(url).searchParams.get('q')).toBe('مواعيد المتحف الوطني site:museum.example.org');
    }
  });

  it('keeps explicit Wikipedia requests scoped to Wikipedia', async () => {
    const f = fixture([museum, wiki], [wiki]);
    const result = await new SearchEngine(f.network).execute('مواعيد المتحف الوطني site:ar.wikipedia.org', 5);
    expect(result.hits.map(hit => hit.url)).toEqual([new URL(wiki.url).href]);
  });

  it('keeps multiple allowed sites as alternatives in the public query', async () => {
    const f = fixture([museum], [museum]);
    const result = await new SearchEngine(f.network).execute('المتحف الوطني site:museum.example.org site:other.example.org', 5);
    expect(result.hits.map(hit => hit.url)).toEqual([museum.url]);
    for (const [url] of f.request.mock.calls) {
      expect(new URL(url).searchParams.get('q')).toBe('المتحف الوطني (site:museum.example.org OR site:other.example.org)');
    }
  });

  it('does not call the encyclopedia API when the user excludes Wikipedia', async () => {
    const f = fixture([wiki, museum], [museum]);
    const result = await new SearchEngine(f.network).execute('المتحف الوطني بدون ويكيبيديا', 5);
    expect(result.hits.map(hit => hit.url)).toEqual([museum.url]);
    expect(f.request.mock.calls.some(([url]) => url.includes('wikipedia.org'))).toBe(false);
  });

  it('reports limited specialized coverage when both web engines are unavailable', async () => {
    const f = fixture([], [], { bingStatus: 403, duckStatus: 202 });
    const result = await new SearchEngine(f.network).execute('المتحف الوطني', 5);
    expect(result.coverage).toBe('specialized_sources');
    expect(result.hits).toHaveLength(1);
    expect(result.limitations[0]).toContain('لم تتوفر نتائج من الويب العام');
    expect(result.failures.map(failure => failure.provider)).toEqual(['Bing RSS', 'DuckDuckGo HTML']);
  });

  it('does not substitute encyclopedic search for current service fees when the web engines fail', async () => {
    const f = fixture([], [], { bingStatus: 403, duckStatus: 202 });
    const result = await new SearchEngine(f.network).execute('UK passport renewal fees', 5);
    expect(result.hits).toEqual([]);
    expect(f.request.mock.calls.some(([url]) => url.includes('wikipedia.org'))).toBe(false);
  });

  it('does not send credentials to the new public engines', async () => {
    const f = fixture([museum], []);
    await expect(new SearchEngine(f.network).execute('مواعيد المتحف password=private-value', 5)).rejects.toMatchObject({ code: 'RESEARCH_QUERY_SECRET' });
    expect(f.request).not.toHaveBeenCalled();
  });
});
