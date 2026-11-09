import { describe, expect, it, vi } from 'vitest';
import { SafeNetwork } from '../network.js';
import { SearchEngine } from './engine.js';
import { compileQuery, rankResults, searchTokens } from './ranking.js';
import { documentedProviders, searchRetryAfter, type DocumentedProvider } from './providers.js';
import { robotsAllows } from './robots.js';

const hit = { title: 'Node API documentation', url: 'https://nodejs.org/docs', snippet: 'Reference for the Node API' };
const provider = (search: DocumentedProvider['search']): DocumentedProvider => ({ name: 'fixture', coverage: 'programming', accessBasis: 'documented_api', supports: () => true, search });

describe('independent search review regressions', () => {
  it('keeps a provider busy after caller cancellation until the ignored-signal request settles',async()=>{
    let now=1000,release!:()=>void,began!:()=>void;
    const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{began=resolve;});
    const search=vi.fn(async()=>{began();await held;return [hit];}),controller=new AbortController();
    const engine=new SearchEngine(new SafeNetwork(),{now:()=>now,providers:[provider(search)]});
    const pending=engine.execute('Node API',5,controller.signal,{ownerId:'cancel-owner'});await started;controller.abort();
    await expect(pending).rejects.toMatchObject({name:'AbortError'});now+=5000;
    expect((await engine.execute('Node API',5,undefined,{ownerId:'other-owner'})).failures).toEqual([{provider:'fixture',kind:'rate_limited'}]);expect(search).toHaveBeenCalledTimes(1);
    release();await held;await Promise.resolve();await Promise.resolve();now+=1000;
    expect((await engine.execute('Node API',5,undefined,{ownerId:'fresh-owner'})).hits).toHaveLength(1);expect(search).toHaveBeenCalledTimes(2);
  });
  it('rejects recognized credentials in queries before calling an external provider',async()=>{
    const search=vi.fn(async()=>[hit]),engine=new SearchEngine(new SafeNetwork(),{providers:[provider(search)]});
    await expect(engine.execute('Node API password=private-value',5)).rejects.toMatchObject({code:'RESEARCH_QUERY_SECRET'});
    await expect(engine.execute('Node API https://example.com/?token=private-value',5)).rejects.toMatchObject({code:'RESEARCH_QUERY_SECRET'});
    await expect(engine.execute('Node API password%3Dprivate-value',5)).rejects.toMatchObject({code:'RESEARCH_QUERY_SECRET'});
    await expect(engine.execute('Node API password%3Dprivate-value 50%',5)).rejects.toMatchObject({code:'RESEARCH_QUERY_SECRET'});
    await expect(engine.execute('Node API https://example.com/?token%3Dprivate-value 50%',5)).rejects.toMatchObject({code:'RESEARCH_QUERY_SECRET'});
    expect(search).not.toHaveBeenCalled();
  });
  it('does not overlap a slow provider across different owners after the nominal rate interval', async () => {
    let now = 1000, release!: () => void, began!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { began = resolve; });
    const search = vi.fn(async () => { began(); await held; return [hit]; });
    const engine = new SearchEngine(new SafeNetwork(), { now: () => now, providers: [provider(search)] });
    const first = engine.execute('Node API', 5, undefined, { ownerId: 'owner-a' }); await started;
    now += 5000;
    expect((await engine.execute('Node API', 5, undefined, { ownerId: 'owner-b' })).failures).toEqual([{ provider: 'fixture', kind: 'rate_limited' }]);
    expect(search).toHaveBeenCalledTimes(1);
    release(); expect((await first).hits).toHaveLength(1);
    now += 1100;
    expect((await engine.execute('Node API', 5, undefined, { ownerId: 'owner-c' })).hits).toHaveLength(1);
    expect(search).toHaveBeenCalledTimes(2);
  });
  it('cancels an in-flight provider without caching a fabricated empty success', async () => {
    let now = 1000, began!: () => void, calls = 0;
    const started = new Promise<void>(resolve => { began = resolve; }), controller = new AbortController();
    const engine = new SearchEngine(new SafeNetwork(), { now: () => now, providers: [provider(async (_query, _limit, signal) => {
      calls++; if (calls > 1) return [hit];
      return new Promise<never>((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); began(); });
    })] });
    const pending = engine.execute('Node API', 5, controller.signal, { ownerId: 'owner' }); await started; controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    now += 2000;
    expect((await engine.execute('Node API', 5, undefined, { ownerId: 'owner' })).hits).toHaveLength(1);
    expect(calls).toBe(2);
  });
  it('respects HTTP-date Retry-After, rejects scalar JSON, and stops after daily quota exhaustion', async () => {
    const now = Date.UTC(2026, 10, 8, 12);
    expect(searchRetryAfter(new Date(now + 120000).toUTCString(), now)).toBe(120000);
    expect(searchRetryAfter('30', now)).toBe(30000);
    let requestCount = 0, body = 'null';
    const network = { request: async () => { requestCount++; return { status: 200, headers: {}, body: Buffer.from(body) }; } } as unknown as SafeNetwork;
    const providers = documentedProviders(network, () => now), signal = new AbortController().signal;
    await expect(providers[0].search(compileQuery('Node API'), 5, signal)).rejects.toMatchObject({ kind: 'invalid_response' });
    body = JSON.stringify({ items: [{ title: hit.title, link: hit.url, tags: ['node', 'api'] }], quota_remaining: 0 });
    await providers[1].search(compileQuery('Node API'), 5, signal);
    await expect(providers[1].search(compileQuery('React hooks'), 5, signal)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 86400000 });
    expect(requestCount).toBe(2);
  });
  it('does not broaden an invalid site restriction or invent lexical relevance for an empty topic', async () => {
    const search = vi.fn(async () => [hit]), engine = new SearchEngine(new SafeNetwork(), { providers: [provider(search)] });
    await expect(engine.execute('Node API site:example.org/private', 5)).rejects.toMatchObject({ code: 'RESEARCH_QUERY_INVALID' });
    await expect(engine.execute('ما هو أحدث البحث', 5)).rejects.toMatchObject({ code: 'RESEARCH_QUERY_INVALID' });
    expect(search).not.toHaveBeenCalled();
    expect(searchTokens('أَحْدَث البرمجـة')).toEqual(['برمجة']);
    expect(rankResults(compileQuery('C API'), [{ provider: 'fixture', hits: [hit] }], 5)).toEqual([]);
  });
  it('uses the relevant description of a duplicate URL rather than whichever provider sorts first', () => {
    const rows = [{ provider: 'a', hits: [{ ...hit, title: 'Home', snippet: '' }] }, { provider: 'b', hits: [hit] }];
    const result = rankResults(compileQuery('Node API'), rows, 5);
    expect(result).toHaveLength(1); expect(result[0].title).toBe(hit.title); expect(result[0].providers).toEqual(['a','b']);
    expect(rankResults(compileQuery('Node API'), [...rows].reverse(), 5)).toEqual(result);
  });
  it('parses valid CR-only robots files and keeps empty-rule groups separate', () => {
    expect(robotsAllows('User-agent: *\rDisallow: /private', 'https://example.org/private')).toBe(false);
    const groups = 'User-agent: MohassanAI-Research\nDisallow:\nUser-agent: *\nDisallow: /';
    expect(robotsAllows(groups, 'https://example.org/public')).toBe(true);
    expect(robotsAllows(groups, 'https://example.org/public', 'OtherBot')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /', 'https://example.org/robots.txt')).toBe(true);
  });
  it('matches encoded literal wildcard characters without interpreting them as request-side operators', () => {
    const rules = 'User-agent: *\nDisallow: /star%2Apath\nDisallow: /dollar%24path';
    expect(robotsAllows(rules, 'https://example.org/star*path')).toBe(false);
    expect(robotsAllows(rules, 'https://example.org/dollar$path')).toBe(false);
    expect(robotsAllows(rules, 'https://example.org/starotherpath')).toBe(true);
  });
  it('fails closed on adversarial robots complexity and oversized direct parser input', () => {
    const rules = 'User-agent: *\n' + `Disallow: /*${'a'.repeat(100)}b$\n`.repeat(1000);
    expect(() => robotsAllows(rules, `https://example.org/${'a'.repeat(1200)}`)).toThrowError(expect.objectContaining({ code: 'RESEARCH_ROBOTS_LIMIT' }));
    expect(() => robotsAllows(' '.repeat(512001), 'https://example.org/')).toThrowError(expect.objectContaining({ code: 'RESEARCH_ROBOTS_LIMIT' }));
  });
});
