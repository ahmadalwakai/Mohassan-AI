import { describe, expect, it, vi } from 'vitest';
import { SafeNetwork } from '../network.js';
import type { SearchHit } from '../research.js';
import { SearchEngine } from './engine.js';
import type { LocalIndexHit } from './local-index.js';
import { documentedProviders, SearchProviderFailure, type SearchProviderContext, type SearchQuery } from './providers.js';
import { planSources, type PlannedProvider, type SourceDomain, type SourcePlan } from './source-plan.js';
import type { SearchCacheStore } from './store.js';

const fixturePlan = (options: Partial<SourcePlan> = {}): SourcePlan => ({
  explicitSites: [], excludedSites: [], domains: [], language: 'en', fresh: false, reasons: [], ...options,
});

function fakeProvider(name: string, domain: SourceDomain, hosts: string[], hits: SearchHit[], languages: SourcePlan['language'][] = ['en'], access: PlannedProvider['planned']['access'] = 'documented_api') {
  return {
    name,
    coverage: 'web',
    accessBasis: 'documented_api',
    planned: { domains: [domain], languages, hosts, access, contract: { url: 'https://fixture.example/', checked: '2026-11-27' } },
    supports: vi.fn((_query: SearchQuery, _context?: SearchProviderContext) => true),
    search: vi.fn(async (_query: SearchQuery, _limit: number, _signal: AbortSignal, _context?: SearchProviderContext) => hits),
  } satisfies PlannedProvider;
}

const hit = (host: string, title: string): SearchHit => ({ title, url: `https://${host}/facts`, snippet: title });
const run = (engine: SearchEngine, question: string, plan: SourcePlan) => engine.execute(question, 5, undefined, { ownerId: 'owner', plan });

describe('planned searches', () => {
  it('uses only providers for explicit sites and rejects off-site results', async () => {
    const who = fakeProvider('WHO', 'health', ['who.int'], [hit('www.who.int', 'Measles vaccination'), hit('elsewhere.example', 'Measles vaccination')]);
    const other = fakeProvider('Other health', 'health', ['elsewhere.example'], [hit('elsewhere.example', 'Measles vaccination')]);
    const engine = new SearchEngine(new SafeNetwork(), { providers: [other, who] });
    const result = await run(engine, 'Find measles vaccination from WHO', fixturePlan({ explicitSites: ['who.int'], domains: ['health'] }));
    expect(who.search).toHaveBeenCalledWith(expect.objectContaining({ sites: ['who.int'], retrievalQuestion: 'measles vaccination' }), expect.any(Number), expect.any(AbortSignal));
    expect(who.supports).toHaveBeenCalledWith(expect.objectContaining({ sites: ['who.int'] }), undefined);
    expect(other.search).not.toHaveBeenCalled();
    expect(result.hits.map(row => row.url)).toEqual(['https://www.who.int/facts']);
    expect(result.selection).toEqual({ searchedProviders: ['WHO'], unavailableSites: [], unavailableDomains: [] });
  });

  it('keeps explicit constraints and reports every requested site without a provider', async () => {
    const scoped = fakeProvider('Scoped', 'news', ['first.example'], [hit('second.example', 'Election headlines')]);
    const engine = new SearchEngine(new SafeNetwork(), { providers: [scoped] });
    const result = await run(engine, 'Election headlines site:first.example', fixturePlan({ explicitSites: ['second.example'] }));
    expect(scoped.search).toHaveBeenCalledWith(expect.objectContaining({ sites: ['first.example'] }), expect.any(Number), expect.any(AbortSignal));
    expect(result.hits).toEqual([]);
    expect(result.selection).toMatchObject({ searchedProviders: ['Scoped'], unavailableSites: ['second.example'] });
  });

  it('reports a failed explicit site alongside successful results from another requested site', async () => {
    const first = fakeProvider('First', 'news', ['first.example'], [hit('first.example', 'Election headlines')]);
    const second = fakeProvider('Second', 'news', ['second.example'], []);
    second.search.mockRejectedValue(new SearchProviderFailure('unavailable'));
    const engine = new SearchEngine(new SafeNetwork(), { providers: [first, second] });
    const result = await run(engine, 'Election headlines', fixturePlan({ explicitSites: ['first.example', 'second.example'] }));
    expect(result.hits.map(row => row.url)).toEqual(['https://first.example/facts']);
    expect(result.selection).toMatchObject({ searchedProviders: ['First', 'Second'], unavailableSites: ['second.example'] });
  });

  it('honors exclusions during selection and filters excluded output from other providers', async () => {
    const wiki = fakeProvider('Wikipedia', 'encyclopedia', ['en.wikipedia.org'], [hit('en.wikipedia.org', 'Mercury')]);
    const blocked = fakeProvider('Blocked', 'general_web', ['blocked.example'], [hit('blocked.example', 'Mercury')]);
    const web = fakeProvider('Web', 'general_web', ['general.example'], [
      hit('science.general.example', 'Mercury'), hit('video.blocked.example', 'Mercury'), hit('en.wikipedia.org', 'Mercury'),
    ]);
    const engine = new SearchEngine(new SafeNetwork(), { providers: [wiki, blocked, web] });
    const result = await run(engine, 'Mercury without Wikipedia', fixturePlan({ domains: ['encyclopedia', 'general_web'], excludedSites: ['wikipedia.org', 'blocked.example'] }));
    expect(wiki.search).not.toHaveBeenCalled();
    expect(blocked.search).not.toHaveBeenCalled();
    expect(result.hits.map(row => row.url)).toEqual(['https://science.general.example/facts']);
    const contradiction = await run(engine, 'Mercury site:en.wikipedia.org without Wikipedia', fixturePlan({ excludedSites: ['wikipedia.org'] }));
    expect(contradiction.hits).toEqual([]);
    expect(contradiction.selection?.searchedProviders).toEqual([]);
    expect(wiki.search).not.toHaveBeenCalled();
  });

  it.each(['news', 'health', 'official_statistics'] as const)('uses %s once a matching provider exists', async domain => {
    const wiki = fakeProvider('Wikipedia', 'encyclopedia', ['en.wikipedia.org'], [hit('en.wikipedia.org', 'Seasonal flu')]);
    const source = fakeProvider('Subject source', domain, ['source.example'], [hit('source.example', 'Seasonal flu')]);
    const engine = new SearchEngine(new SafeNetwork(), { providers: [wiki, source] });
    const result = await run(engine, 'Seasonal flu', fixturePlan({ domains: [domain] }));
    expect(wiki.search).not.toHaveBeenCalled();
    expect(result.hits.map(row => row.url)).toEqual(['https://source.example/facts']);
  });

  it('uses Wikipedia for encyclopedic topics and as a fallback for uncovered topics', async () => {
    const wiki = fakeProvider('Wikipedia', 'encyclopedia', ['en.wikipedia.org'], [hit('en.wikipedia.org', 'Mercury')]);
    let now = 0;
    const engine = new SearchEngine(new SafeNetwork(), { providers: [wiki], now: () => now });
    const encyclopedia = await run(engine, 'Mercury', fixturePlan({ domains: ['encyclopedia'] }));
    expect(encyclopedia.hits.map(row => row.url)).toEqual(['https://en.wikipedia.org/facts']);
    now += 2000;
    const fallback = await run(engine, 'Mercury', fixturePlan());
    expect(fallback.selection?.wikipediaFallback).toBe(true);
    now += 2000;
    const missing = await run(engine, 'Mercury', fixturePlan({ domains: ['health', 'general_web'] }));
    expect(missing.selection).toEqual({ searchedProviders: ['Wikipedia'], unavailableSites: [], unavailableDomains: ['health', 'general_web'], wikipediaFallback: true });
    expect(missing.hits.map(row => row.url)).toEqual(['https://en.wikipedia.org/facts']);
    expect(wiki.search).toHaveBeenCalledTimes(3);
  });

  it('uses the requested language first and the explicit Wikipedia host language for retrieval', async () => {
    const en = fakeProvider('English', 'news', ['english.example'], [hit('english.example', 'طقس طقس')], ['en']);
    const ar = fakeProvider('Arabic', 'news', ['arabic.example'], [hit('arabic.example', 'طقس')], ['ar']);
    const wiki = fakeProvider('Wikipedia', 'encyclopedia', ['ar.wikipedia.org', 'en.wikipedia.org'], [hit('en.wikipedia.org', 'طقس')], ['ar', 'en']);
    const engine = new SearchEngine(new SafeNetwork(), { providers: [en, ar, wiki] });
    const result = await run(engine, 'طقس', fixturePlan({ domains: ['news'], language: 'ar' }));
    expect(result.selection?.searchedProviders).toEqual(['Arabic', 'English']);
    expect(result.hits.map(row => row.url)).toEqual(['https://arabic.example/facts', 'https://english.example/facts']);
    await run(engine, 'طقس site:en.wikipedia.org', fixturePlan({ language: 'ar' }));
    expect(wiki.search).toHaveBeenCalledWith(expect.objectContaining({ language: 'en' }), expect.any(Number), expect.any(AbortSignal));
  });

  it('keeps old selection without a plan and separates incompatible cache entries', async () => {
    const provider = fakeProvider('Legacy', 'health', ['source.example'], [hit('source.example', 'Seasonal flu')]);
    provider.supports.mockReturnValue(true);
    const engine = new SearchEngine(new SafeNetwork(), { providers: [provider] });
    const legacy = await engine.execute('Seasonal flu', 5, undefined, { ownerId: 'owner' });
    expect(legacy.selection).toBeUndefined();
    expect(legacy.hits.map(row => row.url)).toEqual(['https://source.example/facts']);
    const planned = await run(engine, 'Seasonal flu', fixturePlan({ domains: ['news'] }));
    expect(planned.hits).toEqual([]);
    expect(planned.selection?.unavailableDomains).toEqual(['news']);
    const cached = await run(engine, 'Seasonal flu', fixturePlan({ domains: ['news'] }));
    expect(cached).toMatchObject({ freshness: 'cached', selection: planned.selection });
    expect(provider.search).toHaveBeenCalledTimes(1);
  });

  it('skips stale indexed sources for fresh plans and an unavailable specialty', async () => {
    const local = vi.fn(async (): Promise<LocalIndexHit[]> => []);
    const engine = new SearchEngine(new SafeNetwork(), { providers: [], localIndex: { name: 'Index', search: local } });
    await run(engine, 'Seasonal flu', fixturePlan({ fresh: true }));
    await run(engine, 'Seasonal flu', fixturePlan({ domains: ['health'] }));
    expect(local).not.toHaveBeenCalled();
    await engine.execute('Seasonal flu', 5, undefined, { ownerId: 'owner' });
    expect(local).toHaveBeenCalledOnce();
  });
});

describe('the production provider set with the empty factory registry', () => {
  const productionEngine = (question: string) => {
    const network = new SafeNetwork();
    // Echo the submitted topic in an offline API response so lexical relevance is independent of external content.
    const request = vi.spyOn(network, 'request').mockImplementation(async url => ({
      url, status: 200, headers: {},
      body: Buffer.from(JSON.stringify({ query: { search: [{ title: question, snippet: question }] } })),
    }));
    const engine = new SearchEngine(network, {
      publicWeb: false,
      providers: documentedProviders(network),
      admission: { acquireProvider: async () => ({ token: 'test' }), releaseProvider: async () => true },
    });
    expect(engine.name).toBe('Wikipedia / Stack Exchange / Crossref / Hacker News / arXiv');
    return { engine, request };
  };

  it.each([
    ['How many people live in Japan?', 'en', 'official_statistics'],
    ['What is the population of France?', 'en', 'official_statistics'],
    ['كم عدد سكان مصر؟', 'ar', 'official_statistics'],
    ['ما هي أعراض السكري؟', 'ar', 'health'],
    ['What are the symptoms of diabetes?', 'en', 'health'],
    ['How do vaccines work?', 'en', 'health'],
    ['كيف تعمل الطاقة الشمسية؟', 'ar', 'general_web'],
    ['ما معنى كلمة سراب؟', 'ar', 'language'],
    ['What is the GDP of Egypt?', 'en', 'official_statistics'],
  ] as const)('falls back to Wikipedia for %s', async (question, lang, domain) => {
    const { engine, request } = productionEngine(question);
    const result = await run(engine, question, planSources(question));
    expect(request).toHaveBeenCalledOnce();
    expect(new URL(request.mock.calls[0]![0]).hostname).toBe(`${lang}.wikipedia.org`);
    expect(result.hits.map(row => row.providers)).toEqual([['Wikipedia']]);
    expect(result.selection).toEqual({ searchedProviders: ['Wikipedia'], unavailableSites: [], unavailableDomains: [domain], wikipediaFallback: true });
  });

  it.each(['What is the GDP of Egypt, not from Wikipedia?', 'What is the GDP of Egypt site:data.example', 'What is the latest GDP of Egypt?'])('honors existing Wikipedia limits for %s', async question => {
    const { engine, request } = productionEngine(question);
    const result = await run(engine, question, planSources(question));
    expect(request).not.toHaveBeenCalled();
    expect(result.hits).toEqual([]);
    expect(result.selection?.wikipediaFallback).toBeUndefined();
  });
});

describe('provider contracts', () => {
  it('requires both a registered provider’s domain and its query support', async () => {
    const wiki = fakeProvider('Wikipedia', 'encyclopedia', ['en.wikipedia.org'], [hit('en.wikipedia.org', 'Seasonal flu')]);
    const health = fakeProvider('Health', 'health', ['health.example'], [hit('health.example', 'Seasonal flu')]);
    health.supports.mockImplementation(query => query.question.includes('vaccine'));
    const unrelated = fakeProvider('Unrelated', 'news', ['news.example'], []);
    const engine = new SearchEngine(new SafeNetwork(), { providers: [wiki, health, unrelated] });
    const symptoms = await run(engine, 'Seasonal flu symptoms', fixturePlan({ domains: ['health'] }));
    expect(health.supports).toHaveBeenCalledOnce();
    expect(health.search).not.toHaveBeenCalled();
    expect(unrelated.supports).not.toHaveBeenCalled();
    expect(wiki.search).not.toHaveBeenCalled();
    expect(symptoms.selection).toMatchObject({ searchedProviders: [], unavailableDomains: ['health'] });
    const vaccine = await run(engine, 'Seasonal flu vaccine', fixturePlan({ domains: ['health'] }));
    expect(vaccine.selection?.searchedProviders).toEqual(['Health']);
  });

  it('passes only allowed explicit sites to OpenSearch discovery before checking support', async () => {
    const discovery = {
      ...fakeProvider('Site discovery', 'general_web', [], [
        hit('first.example', 'Mercury'), hit('second.example', 'Mercury'), hit('third.example', 'Mercury'),
      ], ['en'], 'opensearch'),
      accessBasis: 'public_search',
    } satisfies PlannedProvider;
    discovery.supports.mockImplementation(query => query.sites.length > 0);
    const engine = new SearchEngine(new SafeNetwork(), { providers: [discovery] });
    await run(engine, 'Mercury', fixturePlan({ domains: ['general_web'] }));
    expect(discovery.supports).not.toHaveBeenCalled();
    const explicit = await run(engine, 'Mercury site:first.example', fixturePlan({
      explicitSites: ['second.example', 'third.example'], excludedSites: ['third.example'], domains: ['encyclopedia'],
    }));
    const scoped = expect.objectContaining({ sites: ['first.example', 'second.example'] });
    expect(discovery.supports).toHaveBeenCalledWith(scoped, undefined);
    expect(discovery.search).toHaveBeenCalledWith(scoped, expect.any(Number), expect.any(AbortSignal));
    expect(explicit.hits.map(row => row.url).sort()).toEqual(['https://first.example/facts', 'https://second.example/facts']);
    expect(explicit.selection?.unavailableSites).toEqual([]);
    await run(engine, 'Mercury', fixturePlan({ explicitSites: ['third.example'], excludedSites: ['third.example'] }));
    expect(discovery.supports).toHaveBeenCalledOnce();
    expect(discovery.search).toHaveBeenCalledOnce();
  });

  it.each(['SQL cache', 'memory cache'])('authorizes account providers before selection and bypasses the %s for eligible requests', async cache => {
    const wiki = fakeProvider('Wikipedia', 'encyclopedia', ['en.wikipedia.org'], [hit('en.wikipedia.org', 'Mercury')]);
    const web = {
      ...fakeProvider('Account web', 'general_web', [], [hit('web.example', 'Mercury')]),
      allowsAccount: vi.fn((context?: SearchProviderContext) => context?.role === 'owner'),
      cacheResults: false,
    } satisfies PlannedProvider;
    const store = {
      revision: vi.fn(async () => 0), get: vi.fn(async () => null), put: vi.fn(async () => {}), clear: vi.fn(async () => {}),
    } satisfies SearchCacheStore;
    let role: SearchProviderContext['role'] = 'member';
    let now = 0;
    const resolveAccountRole = vi.fn(async () => role);
    const engine = new SearchEngine(new SafeNetwork(), {
      providers: [wiki, web], resolveAccountRole, now: () => now, ...(cache === 'SQL cache' ? { store } : {}),
    });
    const plan = fixturePlan({ domains: ['general_web'] });
    const member = await engine.execute('Mercury', 5, undefined, { ownerId: 'account', plan });
    expect(member.selection).toMatchObject({ searchedProviders: ['Wikipedia'], wikipediaFallback: true });
    expect(web.supports).not.toHaveBeenCalled();
    expect(web.search).not.toHaveBeenCalled();
    if (cache === 'SQL cache') {
      expect(store.get).toHaveBeenCalledOnce();
      expect(store.put).toHaveBeenCalledOnce();
      vi.clearAllMocks();
    }
    role = 'owner';
    for (let i = 0; i < 2; i++) {
      now += 2_000;
      const owner = await engine.execute('Mercury', 5, undefined, { ownerId: 'account', plan });
      expect(owner.selection).toEqual({ searchedProviders: ['Account web'], unavailableDomains: [], unavailableSites: [] });
      expect(owner.freshness).toBe('fresh');
    }
    expect(resolveAccountRole).toHaveBeenLastCalledWith('account');
    expect(web.supports).toHaveBeenLastCalledWith(expect.objectContaining({ sites: [] }), { role: 'owner' });
    expect(web.search).toHaveBeenCalledTimes(2);
    expect(web.search).toHaveBeenLastCalledWith(expect.objectContaining({ sites: [] }), expect.any(Number), expect.any(AbortSignal), { role: 'owner' });
    expect(store.revision).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  });
});
