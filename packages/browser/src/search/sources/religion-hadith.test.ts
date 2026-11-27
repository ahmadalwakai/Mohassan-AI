import { describe, expect, it, vi } from 'vitest';
import { SafeNetwork } from '../../network.js';
import { compileQuery } from '../ranking.js';
import fixture from './fixtures/hadeethenc.json';
import { hadithProvider } from './religion-hadith.js';

function fakeNetwork() {
  const network = new SafeNetwork();
  let now = Date.parse(fixture.retrieved);
  const responses = new Map<string, { status: number; body: string; headers: Record<string, string> }>();
  const reply = (url: string, status: number, body: string, headers = {}) => responses.set(url, { status, body, headers });
  reply(fixture.robots.url, 200, fixture.robots.body);
  for (const recorded of [fixture.search, fixture.englishSearch, fixture.detail, fixture.empty,
    ...fixture.ruling.flatMap(item => [item.search, item.detail])]) {
    reply(recorded.url, 200, JSON.stringify(recorded.body));
  }
  const request = vi.spyOn(network, 'request').mockImplementation(async url => {
    const response = responses.get(url);
    if (!response) throw new Error(`Missing offline fixture for ${url}`);
    return { url, status: response.status, headers: response.headers, body: Buffer.from(response.body) };
  });
  return { provider: hadithProvider(network, () => now), request, reply, advance: (ms: number) => { now += ms; } };
}

const example = compileQuery('ما نص حديث إنما الأعمال بالنيات؟');
const signal = () => new AbortController().signal;

describe('HadeethEnc religion provider', () => {
  it('searches by the hadith words and retains the exact quoted bytes, narrator, grade and references', async () => {
    const { provider, request } = fakeNetwork();
    const [detail] = fixture.detail.body;
    expect(provider.planned.domains).toEqual(['religion']);
    expect(provider.supports(example)).toBe(true);
    expect(provider.supports(compileQuery('أحاديث عن النية'))).toBe(true);
    expect(provider.supports(compileQuery('ما تفسير آية الكرسي؟'))).toBe(false);
    expect(provider.supports(compileQuery('لَا تَأْخُذُهُ سِنَةٌ وَلَا نَوْمٌ'))).toBe(false);
    expect(provider.supports(compileQuery('PostgreSQL index performance'))).toBe(false);

    const hits = await provider.search(example, 1, signal());
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      title: `${fixture.search.body[0].title} — HadeethEnc.com`,
      url: `https://hadeethenc.com/ar/browse/hadith/${detail.id}`,
    });
    const [quote, narrator, grade, references] = hits[0].snippet.split('\n\n');
    expect(Buffer.from(quote)).toEqual(Buffer.from(detail.hadeeth));
    expect(narrator).toBe(`الراوي: ${detail.hadeeth_intro}`);
    expect(grade).toBe(`درجة الحديث: ${detail.grade}`);
    expect(references).toBe(`المراجع: ${detail.reference}`);
    expect(request.mock.calls.map(([url]) => url)).toEqual([fixture.robots.url, fixture.search.url, fixture.detail.url]);
  });

  it('searches English keywords and returns the record with its original text', async () => {
    const { provider, request } = fakeNetwork();
    const example = compileQuery('Find the hadith about reward of deeds depends on the intentions');
    const [detail] = fixture.detail.body;
    expect(provider.supports(example)).toBe(true);
    const [hit] = await provider.search(example, 1, signal());
    expect(hit).toMatchObject({
      title: `${fixture.englishSearch.body[0].title} — HadeethEnc.com`,
      url: `https://hadeethenc.com/ar/browse/hadith/${detail.id}`,
    });
    expect(hit.snippet.startsWith(detail.hadeeth)).toBe(true);
    expect(request.mock.calls.map(([url]) => url)).toEqual([fixture.robots.url, fixture.englishSearch.url, fixture.detail.url]);
  });

  it('treats search suggestions as an empty result without looking up details', async () => {
    const { provider, request } = fakeNetwork();
    const subject = new URL(fixture.empty.url).searchParams.get('phrase');
    await expect(provider.search(compileQuery(`ابحث عن حديث ${subject}`), 1, signal())).resolves.toEqual([]);
    expect(request.mock.calls.map(([url]) => url)).toEqual([fixture.robots.url, fixture.empty.url]);
  });

  it('skips requests explicitly about the Quran when selected by a religion plan', async () => {
    const { provider, request } = fakeNetwork();
    await expect(provider.search(compileQuery('what does verse 2:255 say'), 1, signal())).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['مَا حُكْمُ الرِّبَا؟', fixture.ruling[0]],
    ['What is the Islamic ruling on usury?', fixture.ruling[1]],
    ['Is usury haram?', fixture.ruling[1]],
  ] as const)('looks up source material for the ruling topic in %s', async (question, recorded) => {
    const { provider, request } = fakeNetwork();
    const query = compileQuery(question);
    const [detail] = recorded.detail.body;
    expect(provider.supports(query)).toBe(true);
    const [hit] = await provider.search(query, 1, signal());
    expect(hit.url).toBe(`https://hadeethenc.com/ar/browse/hadith/${detail.id}`);
    expect(Buffer.from(hit.snippet.slice(0, detail.hadeeth.length))).toEqual(Buffer.from(detail.hadeeth));
    if (!('hadeeth_intro' in detail)) expect(hit.snippet).not.toContain('Narrator:');
    expect(request.mock.calls.map(([url]) => url)).toEqual([fixture.robots.url, recorded.search.url, recorded.detail.url]);
  });

  it('bounds the detail batch for an oversized caller limit', async () => {
    const { provider, request, reply } = fakeNetwork();
    const candidates = Array.from({ length: 30 }, (_, index) => ({ ...fixture.search.body[0], id: String(index + 1) }));
    const detail = new URL(fixture.detail.url);
    detail.searchParams.set('ids', candidates.slice(0, 20).map(candidate => candidate.id).join(','));
    reply(fixture.search.url, 200, JSON.stringify(candidates));
    reply(detail.href, 200, '[]');
    await expect(provider.search(example, 900, signal())).resolves.toEqual([]);
    expect(request.mock.calls.map(([url]) => url)).toEqual([fixture.robots.url, fixture.search.url, detail.href]);
  });

  it('keeps one search in flight and accepts a new search after it completes', async () => {
    const { provider, request } = fakeNetwork();
    const offlineDispatch = request.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    request.mockImplementation(async (url, options) => {
      if (url === fixture.search.url) await held;
      return offlineDispatch(url, options);
    });
    const pending = provider.search(example, 1, signal());
    await expect(provider.search(example, 1, signal())).rejects.toMatchObject({ kind: 'rate_limited' });
    release();
    await expect(pending).resolves.toHaveLength(1);
    await expect(provider.search(example, 1, signal())).resolves.toHaveLength(1);
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      fixture.robots.url, fixture.search.url, fixture.detail.url, fixture.search.url, fixture.detail.url,
    ]);
  });

  it('honors Retry-After and resumes once the cooldown expires', async () => {
    const { provider, request, reply, advance } = fakeNetwork();
    reply(fixture.search.url, 429, '', { 'retry-after': '30' });
    await expect(provider.search(example, 1, signal())).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    expect(provider.cooldownMs?.()).toBe(30_000);
    advance(1_000);
    await expect(provider.search(example, 1, signal())).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 29_000 });
    expect(request).toHaveBeenCalledTimes(2);

    reply(fixture.search.url, 200, JSON.stringify(fixture.search.body));
    advance(29_000);
    await expect(provider.search(example, 1, signal())).resolves.toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('does not request a search endpoint disallowed by robots.txt', async () => {
    const { provider, request, reply } = fakeNetwork();
    reply(fixture.robots.url, 200, 'User-agent: *\nDisallow: /api/v1/hadeeths/search/');
    await expect(provider.search(example, 1, signal())).rejects.toMatchObject({ code: 'RESEARCH_ROBOTS_DENIED' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
