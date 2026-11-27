import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SafeNetwork, type SafeResponse } from '../../network.js';
import { compileQuery } from '../ranking.js';
import { quranProvider } from './religion-quran.js';

const origin = 'https://api.alquran.cloud';
const versePath = '/v1/ayah/2:255/quran-uthmani';
const editionsPath = '/v1/ayah/2:255/editions/quran-uthmani,en.sahih';
const tafsirPath = '/v1/ayah/2:255/editions/quran-uthmani,ar.muyassar';
const longEditionsPath = '/v1/ayah/2:282/editions/quran-uthmani,en.sahih';
const longTafsirPath = '/v1/ayah/2:282/editions/quran-uthmani,ar.muyassar';
const chapterPath = '/v1/surah/1/editions/quran-uthmani,en.sahih?offset=0&limit=7';
const englishSearchPath = '/v1/search/the%20Ever-Living/all/en.sahih?limit=3';
const emptyPath = '/v1/search/qftqftzx/all/en.sahih?limit=3';
const corpusPath = '/v1/quran/quran-simple';
const tanzilAttribution = 'Tanzil Project (https://tanzil.net)';

const read = (file: string) => readFileSync(new URL(`./fixtures/quran-${file}.json`, import.meta.url));
const expected = <T>(file: string): T => JSON.parse(read(file).toString('utf8')).data;
type Quote = { text: string };

const recordings = new Map([
  ['/robots.txt', 'robots-404'],
  ['/v1/surah', 'surahs'],
  [versePath, 'verse-uthmani'],
  [editionsPath, 'verse-editions'],
  [tafsirPath, 'tafsir-editions'],
  [longEditionsPath, '2-282-verse-editions'],
  [longTafsirPath, '2-282-tafsir-editions'],
  [chapterPath, 'chapter-editions'],
  [englishSearchPath, 'english-search'],
  [emptyPath, 'empty-search'],
  [corpusPath, 'simple-excerpt'],
]);

function setup() {
  const network = new SafeNetwork();
  let time = Date.UTC(2026, 10, 27);
  let limited = false;
  let robotsDenied = false;
  const request = vi.spyOn(network, 'request').mockImplementation(async (input, options): Promise<SafeResponse> => {
    options?.signal?.throwIfAborted();
    const url = new URL(input);
    expect(url.origin).toBe(origin);
    const path = url.pathname + url.search;
    const recording = recordings.get(path);
    if (recording === undefined) throw new Error(`Unexpected request ${path}`);
    if (robotsDenied && path === '/robots.txt') {
      return { url: input, status: 200, headers: {}, body: Buffer.from('User-agent: *\nDisallow: /v1/') };
    }
    if (limited && path !== '/robots.txt') {
      return { url: input, status: 429, headers: { 'retry-after': '12' }, body: Buffer.alloc(0) };
    }
    return { url: input, status: path === '/robots.txt' || path === emptyPath ? 404 : 200,
      headers: { 'content-type': 'application/json; charset=utf-8' }, body: read(recording) };
  });
  const provider = quranProvider(network, () => time);
  return {
    provider, requestedPaths: () => request.mock.calls.map(([url]) => url.slice(origin.length)),
    search: (question: string, limit = 3) => provider.search(compileQuery(question), limit, new AbortController().signal),
    limitRequests: (value: boolean) => { limited = value; },
    disallowRobots: () => { robotsDenied = true; },
    advance: (ms: number) => { time += ms; },
  };
}

describe('AlQuran Cloud provider', () => {
  it('uses religious wording and verse references to determine standalone support', () => {
    const { provider } = setup();
    for (const question of ['what does verse 2:255 say', 'ما تفسير آية الكرسي؟', 'في أي سورة وردت آية', 'Surah Al-Baqara']) {
      expect(provider.supports(compileQuery(question))).toBe(true);
    }
    for (const question of ['weather in Cairo', 'ما نص حديث إنما الأعمال بالنيات؟', 'meet at 2:55 tomorrow']) {
      expect(provider.supports(compileQuery(question))).toBe(false);
    }
    expect(provider.planned.domains).toEqual(['religion']);
  });

  it('looks up a numerical reference and returns Arabic and attributed English translation', async () => {
    const { search, requestedPaths } = setup();
    const [arabic, english] = expected<Quote[]>('verse-editions');
    const [hit] = await search('what does verse 2:255 say');
    expect(hit.url).toBe(origin + editionsPath);
    expect(hit.title).toContain('Al-Baqara (2:255) · English translation · Saheeh International');
    expect(hit.title).toContain(tanzilAttribution);
    expect(hit.snippet).toBe(`Qur’an text\n${arabic.text}\n\nEnglish translation · Saheeh International\n${english.text}`);
    expect(requestedPaths()).toEqual(['/robots.txt', editionsPath]);
  });

  it('looks up Arabic-Indic numbers and returns the original bytes in the hit snippet', async () => {
    const { search } = setup();
    const [hit] = await search('ما نص الآية ٢:٢٥٥؟');
    const quote = expected<Quote>('verse-uthmani').text;
    expect(hit.url).toBe(origin + versePath);
    expect(hit.title).toContain(tanzilAttribution);
    expect(Buffer.from(hit.snippet, 'utf8')).toEqual(Buffer.from(quote, 'utf8'));
  });

  it.each([
    ['ما نص الآية ٢٥٥ من سورة البقرة؟', versePath],
    ['Surah Al-Baqarah, verse 255', editionsPath],
    ['verse 255 of Surah The Cow', editionsPath],
  ])('resolves %s from the surah catalog', async (question, path) => {
    const { search, requestedPaths } = setup();
    const [hit] = await search(question);
    expect(hit.url).toBe(origin + path);
    expect(requestedPaths()).toEqual(['/robots.txt', '/v1/surah', path]);
  });

  it('can look up a bare English surah name after the religious domain was selected', async () => {
    const { search, requestedPaths } = setup();
    const rows = await search('The Opening', 7);
    expect(rows).toHaveLength(7);
    expect(rows[0].title).toContain('Al-Faatiha (1:1)');
    expect(rows[6].title).toContain('Al-Faatiha (1:7)');
    expect(rows.every(row => row.title.includes(tanzilAttribution))).toBe(true);
    const [arabic] = expected<{ ayahs: Quote[] }[]>('chapter-editions');
    expect(rows[0].snippet).toContain(arabic.ayahs[0].text);
    expect(requestedPaths()).toEqual(['/robots.txt', '/v1/surah', chapterPath]);
  });

  it('looks up a numbered chapter directly', async () => {
    const { search, requestedPaths } = setup();
    const rows = await search('Surah 1', 7);
    expect(rows).toHaveLength(7);
    expect(rows[6].title).toContain('Al-Faatiha (1:7)');
    expect(requestedPaths()).toEqual(['/robots.txt', chapterPath]);
  });

  it('matches Arabic wording with diacritics, hamza and alef forms, and taa marbuta variants', async () => {
    const { search, requestedPaths } = setup();
    const [hit] = await search('في أي سورة لَا تَاخُذُهُ سِنَهٌ وَلَا نَوْمٌ؟');
    expect(hit.url).toBe(origin + '/v1/ayah/2:255/quran-simple');
    expect(hit.title).toContain(tanzilAttribution);
    const { surahs } = expected<{ surahs: { number: number; ayahs: (Quote & { numberInSurah: number })[] }[] }>('simple-excerpt');
    expect(hit.snippet).toBe(surahs.find(surah => surah.number === 2)?.ayahs.find(ayah => ayah.numberInSurah === 255)?.text);
    const alternate = await search('في أي سورة لا تَأْخُذُهُ سِنَةٌ ولا نوم؟');
    expect(alternate).toEqual([hit]);
    expect(requestedPaths()).toEqual(['/robots.txt', corpusPath]);
  });

  it('excludes chapter prefaces when matching the basmala and preserves the source BOM', async () => {
    const { search } = setup();
    const hits = await search('في أي سورة بسم الله الرحمن الرحيم؟');
    expect(hits.map(hit => hit.url)).toEqual([origin + '/v1/ayah/1:1/quran-simple', origin + '/v1/ayah/27:30/quran-simple']);
    const { surahs } = expected<{ surahs: { ayahs: Quote[] }[] }>('simple-excerpt');
    expect(Buffer.from(hits[0].snippet)).toEqual(Buffer.from(surahs[0].ayahs[0].text));
  });

  it('returns a recorded verse for a ruling topic', async () => {
    const { search } = setup();
    const [hit] = await search('ما حكم الربا في القرآن؟');
    expect(hit.url).toBe(origin + '/v1/ayah/2:275/quran-simple');
    const { surahs } = expected<{ surahs: { number: number; ayahs: (Quote & { numberInSurah: number })[] }[] }>('simple-excerpt');
    expect(hit.snippet).toBe(surahs.find(surah => surah.number === 2)?.ayahs.find(ayah => ayah.numberInSurah === 275)?.text);
  });

  it('returns the cited tafsir and verse as distinct, verbatim quotations', async () => {
    const { search } = setup();
    const [arabic, tafsir] = expected<(Quote & { edition: { name: string } })[]>('tafsir-editions');
    const [hit] = await search('ما تفسير آية الكرسي؟');
    expect(hit.url).toBe(origin + tafsirPath);
    expect(hit.title).toContain(`(2:255) · التفسير · ${tafsir.edition.name}`);
    expect(hit.title).toContain(tanzilAttribution);
    expect(hit.snippet).toBe(`نص القرآن\n${arabic.text}\n\nالتفسير · ${tafsir.edition.name}\n${tafsir.text}`);
  });

  it.each([
    ['what does verse 2:282 say', '2-282-verse-editions', longEditionsPath, 'en.sahih'],
    ['ما تفسير الآية ٢:٢٨٢؟', '2-282-tafsir-editions', longTafsirPath, 'ar.muyassar'],
  ])('returns separate intact editions when %s exceeds the combined snippet budget', async (question, recording, path, edition) => {
    const { search, requestedPaths } = setup();
    const [original, requested] = expected<Quote[]>(recording);
    const hits = await search(question);
    expect(original.text.length + requested.text.length).toBeGreaterThan(2000);
    expect(hits.map(hit => hit.url)).toEqual([
      origin + `/v1/ayah/2:282/${edition}`, origin + '/v1/ayah/2:282/quran-uthmani',
    ]);
    for (const [index, quote] of [requested, original].entries()) {
      expect(hits[index].title).toContain('(2:282)');
      expect(hits[index].snippet.length).toBeLessThanOrEqual(2000);
      expect(Buffer.from(hits[index].snippet, 'utf8')).toEqual(Buffer.from(quote.text, 'utf8'));
    }
    expect(hits[1].title).toContain(tanzilAttribution);
    expect(requestedPaths()).toEqual(['/robots.txt', path]);
  });

  it('searches the named English translation and handles a recorded no-match response', async () => {
    const { search } = setup();
    const [hit] = await search('which verse contains “the Ever-Living”');
    expect(hit.url).toBe(origin + '/v1/ayah/2:255/en.sahih');
    expect(hit.snippet).toBe(expected<{ matches: Quote[] }>('english-search').matches[0].text);
    expect(await search('which verse contains “qftqftzx”')).toEqual([]);
  });

  it('honors Retry-After before making another request', async () => {
    const { search, provider, requestedPaths, limitRequests, advance } = setup();
    limitRequests(true);
    await expect(search('what does verse 2:255 say')).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 12_000 });
    advance(5_000);
    expect(provider.cooldownMs?.()).toBe(7_000);
    await expect(search('what does verse 2:255 say')).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 7_000 });
    expect(requestedPaths()).toEqual(['/robots.txt', editionsPath]);
    limitRequests(false);
    advance(7_000);
    await expect(search('what does verse 2:255 say')).resolves.toHaveLength(1);
  });

  it('checks robots before calling the API', async () => {
    const { disallowRobots, search, requestedPaths } = setup();
    disallowRobots();
    await expect(search('what does verse 2:255 say')).rejects.toMatchObject({ kind: 'unavailable' });
    expect(requestedPaths()).toEqual(['/robots.txt']);
  });
});
