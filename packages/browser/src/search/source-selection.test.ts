import { describe, expect, it, vi } from 'vitest';
import { SafeNetwork } from '../network.js';
import type { SearchHit } from '../research.js';
import { SearchEngine } from './engine.js';
import type { LocalIndexHit } from './local-index.js';
import { SearchProviderFailure, type SearchQuery } from './providers.js';
import type { PlannedProvider, SourceDomain, SourcePlan } from './source-plan.js';

const fixturePlan = (options: Partial<SourcePlan> = {}): SourcePlan => ({
  explicitSites: [], excludedSites: [], domains: [], language: 'en', fresh: false, reasons: [], ...options,
});

function fakeProvider(name: string, domain: SourceDomain, hosts: string[], hits: SearchHit[], languages: SourcePlan['language'][] = ['en']) {
  return {
    name,
    coverage: 'web',
    accessBasis: 'documented_api',
    planned: { domains: [domain], languages, hosts, access: 'documented_api', contract: { url: 'https://fixture.example/', checked: '2026-11-27' } },
    supports: vi.fn(() => false),
    search: vi.fn(async (_query: SearchQuery) => hits),
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
    expect(who.supports).not.toHaveBeenCalled();
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

  it('uses Wikipedia for encyclopedic topics and neutral fallbacks only', async () => {
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
    expect(missing.selection).toEqual({ searchedProviders: [], unavailableSites: [], unavailableDomains: ['health', 'general_web'] });
    expect(missing.hits).toEqual([]);
    expect(wiki.search).toHaveBeenCalledTimes(2);
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
