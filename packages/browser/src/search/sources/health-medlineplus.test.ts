import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SafeNetwork } from '../../network.js';
import { compileQuery } from '../ranking.js';
import { healthProviders } from './health.js';

// NLM Web Service recordings retrieved 2026-11-27. The positive fixture
// retains its first summary paragraph and omits the transient search cursor.
// https://wsearch.nlm.nih.gov/ws/query?db=healthTopics&term=asthma&retmax=1&rettype=brief
// https://wsearch.nlm.nih.gov/ws/query?db=healthTopics&term=zyxqvzzqxj&retmax=1&rettype=brief
const asthma = readFileSync(new URL('./fixtures/health/medlineplus-asthma.xml', import.meta.url));
const empty = readFileSync(new URL('./fixtures/health/medlineplus-empty.xml', import.meta.url));

function service(body = asthma, status = 200, headers: Record<string, string> = {}) {
  let time = 10_000;
  const network = new SafeNetwork();
  const request = vi.spyOn(network, 'request').mockImplementation(async url => {
    const target = new URL(url);
    expect(target.hostname).toBe('wsearch.nlm.nih.gov');
    if (target.pathname === '/robots.txt') {
      // https://wsearch.nlm.nih.gov/robots.txt returned HTTP 404 on 2026-11-27.
      return { url, status: 404, headers: {}, body: Buffer.alloc(0) };
    }
    expect(target.pathname).toBe('/ws/query');
    return { url, status, headers: { 'content-type': 'text/xml; charset=UTF-8', ...headers }, body };
  });
  const provider = healthProviders(network, () => time).find(candidate => candidate.name === 'MedlinePlus')!;
  const queryRequests = () => request.mock.calls.filter(([url]) => new URL(url).pathname === '/ws/query');
  return { provider, request, queryRequests, advance: (duration: number) => { time += duration; } };
}

const signal = () => new AbortController().signal;

describe('MedlinePlus Web Service', () => {
  it('searches the English health topic collection and returns an attributed, plain-text summary', async () => {
    const { provider, request, queryRequests } = service();
    expect(provider.supports(compileQuery('What are the symptoms of asthma?'))).toBe(true);
    expect(provider.supports(compileQuery('JavaScript API programming'))).toBe(false);
    expect(provider.supports(compileQuery('asthma site:who.int'))).toBe(false);
    expect(provider.planned).toMatchObject({ domains: ['health'], languages: ['ar', 'en'], access: 'documented_api' });
    const hits = await provider.search(compileQuery('asthma'), 1, signal());
    expect(hits).toEqual([{
      title: 'Asthma',
      url: 'https://medlineplus.gov/asthma.html',
      snippet: expect.stringContaining('Asthma is a chronic (long-term) lung disease.'),
      sourceOrganization: 'MedlinePlus, National Library of Medicine',
    }]);
    expect(hits[0].snippet).not.toContain('<');
    expect(request.mock.calls[0][0]).toBe('https://wsearch.nlm.nih.gov/robots.txt');
    const [[target]] = queryRequests();
    expect(Object.fromEntries(new URL(target).searchParams)).toEqual({
      db: 'healthTopics', term: 'asthma', retmax: '1', rettype: 'brief', tool: 'MohassanAI',
    });
  });

  it('uses the WHO bilingual asthma topic for an Arabic question', async () => {
    // WHO topic titles checked 2026-11-27.
    // https://www.who.int/ar/news-room/fact-sheets/detail/asthma
    // https://www.who.int/news-room/fact-sheets/detail/asthma
    const { provider, queryRequests } = service();
    const query = compileQuery('ما أعراض الربو؟');
    expect(provider.supports(query)).toBe(true);
    await expect(provider.search(query, 1, signal())).resolves.toHaveLength(1);
    const [[target]] = queryRequests();
    expect(new URL(target).searchParams.get('term')?.toLowerCase()).toBe('asthma');
  });

  it('does not submit Arabic questions without a sourced topic mapping', async () => {
    const { provider, request } = service();
    const query = compileQuery('ما أعراض حالة مجهولة؟');
    expect(provider.supports(query)).toBe(false);
    await expect(provider.search(query, 1, signal())).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it('returns no hits for the recorded empty result', async () => {
    const { provider, queryRequests } = service(empty);
    await expect(provider.search(compileQuery('zyxqvzzqxj'), 1, signal())).resolves.toEqual([]);
    expect(queryRequests()).toHaveLength(1);
  });

  it('honors HTTP 429 Retry-After without querying again during the requested interval', async () => {
    const { provider, queryRequests, advance } = service(Buffer.alloc(0), 429, { 'retry-after': '7' });
    const search = () => provider.search(compileQuery('asthma'), 1, signal());
    await expect(search()).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 7000 });
    advance(4000);
    await expect(search()).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 3000 });
    expect(queryRequests()).toHaveLength(1);
    advance(3000);
    await expect(search()).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 7000 });
    expect(queryRequests()).toHaveLength(2);
  });

  it('rejects a malformed response in place of apparent search results', async () => {
    const truncated = Buffer.from(asthma.toString('utf8').replace('</nlmSearchResult>', ''));
    const { provider } = service(truncated);
    await expect(provider.search(compileQuery('asthma'), 1, signal())).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
