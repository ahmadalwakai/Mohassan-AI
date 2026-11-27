import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SafeNetwork } from '../../network.js';
import { compileQuery } from '../ranking.js';
import { createHealthRequester } from './health-network.js';
import { createWhoGhoProvider } from './health-who.js';

// Recorded 2026-11-27 from the documented WHO OData catalog:
// https://ghoapi.azureedge.net/api/Indicator?$filter=contains(tolower(IndicatorName),'life')%20and%20contains(tolower(IndicatorName),'expectancy')&$top=3
// https://ghoapi.azureedge.net/api/Indicator?$filter=contains(tolower(IndicatorName),'zzqtest951')&$top=3
// https://ghoapi.azureedge.net/api/Indicator?$filter=contains(tolower(IndicatorName),'diabetes')%20and%20contains(tolower(IndicatorName),'prevalence')&$top=3
const life = readFileSync(new URL('./fixtures/health/who-gho-indicators-life.json', import.meta.url));
const empty = readFileSync(new URL('./fixtures/health/who-gho-indicators-empty.json', import.meta.url));
const diabetes = readFileSync(new URL('./fixtures/health/who-gho-indicators-diabetes-prevalence.json', import.meta.url));
const clock = Date.UTC(2026, 10, 27);

function service(body = life, status = 200, headers: Record<string, string> = {}) {
  let time = clock;
  const network = new SafeNetwork();
  const request = vi.spyOn(network, 'request').mockImplementation(async url => {
    const target = new URL(url);
    expect(target.hostname).toBe('ghoapi.azureedge.net');
    if (target.pathname === '/robots.txt') {
      // This service origin returned HTTP 404 for robots.txt on 2026-11-27.
      return { url, status: 404, headers: {}, body: Buffer.alloc(0) };
    }
    expect(target.pathname).toBe('/api/Indicator');
    return { url, status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body };
  });
  const now = () => time;
  const provider = createWhoGhoProvider(createHealthRequester(network, now), now);
  const apiRequests = () => request.mock.calls.filter(([url]) => new URL(url).pathname === '/api/Indicator');
  return { provider, request, apiRequests, advance: (duration: number) => { time += duration; } };
}

const signal = () => new AbortController().signal;
const question = compileQuery('What is the life expectancy data?');

describe('WHO Global Health Observatory OData', () => {
  it('supports health-statistics requests and returns attributed indicator dataset links', async () => {
    const { provider, request, apiRequests } = service();
    expect(provider.supports(question)).toBe(true);
    expect(provider.supports(compileQuery('What are the symptoms of asthma?'))).toBe(false);
    expect(provider.supports(compileQuery('life expectancy site:example.com'))).toBe(false);
    expect(provider.planned).toMatchObject({ domains: ['health'], access: 'documented_api', hosts: ['ghoapi.azureedge.net'] });
    const hits = await provider.search(question, 3, signal());
    expect(hits).toHaveLength(3);
    expect(hits[0]).toEqual({
      title: 'Life expectancy at birth (years)',
      url: 'https://ghoapi.azureedge.net/api/WHOSIS_000001',
      snippet: 'WHO Global Health Observatory indicator WHOSIS_000001. Accessed 2026-11-27.',
      sourceOrganization: 'World Health Organization',
    });
    expect(request.mock.calls[0][0]).toBe('https://ghoapi.azureedge.net/robots.txt');
    const [[target]] = apiRequests();
    expect(Object.fromEntries(new URL(target).searchParams)).toEqual({
      $filter: "contains(tolower(IndicatorName),'life') and contains(tolower(IndicatorName),'expectancy')",
      $top: '3',
    });
  });

  it('returns the empty result from the catalog', async () => {
    const { provider, apiRequests } = service(empty);
    await expect(provider.search(compileQuery('zzqtest951 site:ghoapi.azureedge.net'), 3, signal())).resolves.toEqual([]);
    const [[target]] = apiRequests();
    expect(new URL(target).searchParams.get('$filter')).toBe("contains(tolower(IndicatorName),'zzqtest951')");
  });

  it('uses the verified WHO topic and prevalence terms for an Arabic statistics question', async () => {
    const { provider, apiRequests } = service(diabetes);
    const query = compileQuery('ما معدل انتشار السكري؟');
    expect(provider.supports(query)).toBe(true);
    const hits = await provider.search(query, 3, signal());
    expect(hits.map(hit => hit.title)).toEqual(['Prevalence of diabetes, age-standardized', 'Prevalence of diabetes, crude']);
    const [[target]] = apiRequests();
    expect(new URL(target).searchParams.get('$filter')).toBe(
      "contains(tolower(IndicatorName),'diabetes') and contains(tolower(IndicatorName),'prevalence')",
    );
  });

  it('blocks another request during the 429 Retry-After window', async () => {
    const { provider, apiRequests, advance } = service(Buffer.alloc(0), 429, { 'retry-after': '7' });
    const search = () => provider.search(question, 3, signal());
    await expect(search()).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 7000 });
    advance(4000);
    await expect(search()).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 3000 });
    expect(apiRequests()).toHaveLength(1);
    advance(3000);
    await expect(search()).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 7000 });
    expect(apiRequests()).toHaveLength(2);
  });

  it('rejects an invalid indicator code instead of following an off-contract URL', async () => {
    const invalid = Buffer.from(life.toString('utf8').replace('"WHOSIS_000001"', '"../robots.txt"'));
    const { provider } = service(invalid);
    await expect(provider.search(question, 3, signal())).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
