import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SafeNetwork, type SafeResponse } from '../../network.js';
import { compileQuery } from '../ranking.js';
import { wiktionaryFixtures as fixtures, wiktionaryRobotsExcerpt } from './fixtures/wiktionary.js';
import { languageProviders } from './language.js';

type RecordedEntry = (typeof fixtures)[keyof typeof fixtures];

class WiktionaryNetwork extends SafeNetwork {
  readonly requests: URL[] = [];
  private readonly pages = new Map<string, RecordedEntry>(Object.values(fixtures).map(entry => [entry.url, entry]));
  limited = false;
  constructor(private readonly robots = 'User-agent: *\nAllow: /w/api.php\n') {
    super();
  }

  override async request(input: string): Promise<SafeResponse> {
    const url = new URL(input);
    this.requests.push(url);
    if (url.pathname === '/robots.txt') {
      return { url: input, status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from(this.robots) };
    }
    expect(url.pathname).toBe('/w/api.php');
    expect(url.searchParams.get('action')).toBe('parse');
    expect(url.searchParams.get('prop')).toBe('text');
    expect(url.searchParams.get('formatversion')).toBe('2');
    if (this.limited) {
      return { url: input, status: 429, headers: { 'retry-after': '7' }, body: Buffer.alloc(0) };
    }
    const title = url.searchParams.get('page')!;
    const page = this.pages.get(`${url.origin}/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`);
    if (!page) throw new Error(`Unrecorded fixture: ${url.hostname} ${title}`);
    // The HTML and page status are recordings. The Action API wrapper is simulated from the documented
    // format because the edition robots policies disallow action=parse (checked 2026-11-27).
    // https://www.mediawiki.org/wiki/API:Parsing_wikitext
    const payload = page.status === 404 ? { error: { code: 'missingtitle' } } : { parse: { title, text: page.html } };
    return { url: input, status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify(payload)) };
  }

  titles(): (string | null)[] {
    return this.requests.filter(url => url.pathname === '/w/api.php').map(url => url.searchParams.get('page'));
  }
}

function setup(network = new WiktionaryNetwork()) {
  const [ar, en] = languageProviders(network, () => Date.now());
  const find = (provider: typeof ar, question: string, limit = 1) =>
    provider.search(compileQuery(question), limit, new AbortController().signal);
  return { network, ar, en, find };
}

// Expected words and quotes below are transcribed from the cited 2026-11-27 recordings in fixtures/wiktionary.ts.
describe('Wiktionary language providers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('advertises language coverage and recognizes word questions and explicit edition scopes', () => {
    const { ar, en } = setup();
    for (const provider of [ar, en]) {
      expect(provider.planned.domains).toEqual(['language']);
      expect(provider.planned.access).toBe('documented_api');
      expect(provider.supports(compileQuery('ما معنى كلمة كتاب؟'))).toBe(true);
      expect(provider.supports(compileQuery('what does running mean?'))).toBe(true);
      expect(provider.supports(compileQuery('what is the history of Arabic?'))).toBe(false);
    }
    const scoped = compileQuery('ما معنى كلمة كتاب site:ar.wiktionary.org');
    expect(ar.supports(scoped)).toBe(true);
    expect(en.supports(scoped)).toBe(false);
  });

  it.each(['كتاب', 'كِتَاب'])('quotes the Arabic entry for %s and credits its contributors', async word => {
    const { ar, find } = setup();
    const pending = find(ar, `ما مَعْنَى كَلِمَة «${word}»؟`);
    await vi.runAllTimersAsync();
    const [hit] = await pending;
    expect(hit).toMatchObject({ title: 'كِتَاب — Arabic Wiktionary', url: fixtures.arVocalizedBook.url });
    expect(hit.snippet.split('\n')[0]).toBe('الشيء الذي كُتِبَ، الأغلب قول كِتَابَة وهو أخصّ.');
    expect(hit.snippet).toContain('Wiktionary contributors · CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)');
  });

  it.each([
    ['مَسْأَلَة', ['مَسْأَلَة', 'مسألة']],
    ['مسالة', ['مسالة', 'مساله', 'مسألة']],
    ['مساله', ['مساله', 'مسالة', 'مسألة']],
  ])('looks up Arabic spelling alternatives for %s', async (word, titles) => {
    const { ar, network, find } = setup();
    // The combined hamza + final-h fallback reaches the two independently recorded forms first.
    const pending = find(ar, `ما معنى كلمة ${word}؟`);
    await vi.runAllTimersAsync();
    const [hit] = await pending;
    expect(hit.url).toBe(fixtures.arUnvocalizedQuestion.url);
    expect(hit.snippet.split('\n')[0]).toBe('موضوع.');
    expect(network.titles()).toEqual(titles);
  });

  it('uses the Arabic spelling after rejecting a Persian-only homograph', async () => {
    const { ar, network, find } = setup();
    const pending = find(ar, 'كيف تُكتب مدرسه؟');
    await vi.runAllTimersAsync();
    const [hit] = await pending;
    expect(network.titles()).toEqual(['مدرسه', 'مدرسة']);
    expect(hit.url).toBe(fixtures.arUnvocalizedSchool.url);
    expect(hit.snippet.split('\n')[0]).toBe('مدرسة');
  });

  it.each([
    ['ما جمع مَدْرَسَة', 'مَدْارِس'],
    ['ما جذر مَدْرَسَة', 'الجذر د ر س'],
    ['ما وزن مَدْرَسَة', 'على وزن مَفْعَلَة'],
    ['ما أصل مَدْرَسَة', 'المَدْرَسَة اسم آلة'],
    ['ما مرادفات مَدْرَسَة', 'كُتَّاب'],
    ['ما نوع مَدْرَسَة', 'اسْم مُؤَنَّث'],
  ])('uses the relevant entry text for %s', async (question, text) => {
    const { ar, find } = setup();
    const [hit] = await find(ar, question);
    expect(hit.url).toBe(fixtures.arVocalizedSchool.url);
    expect(hit.snippet.split('\n')[0]).toContain(text);
  });

  it('follows the entry’s English form-of link and preserves the exact form entry', async () => {
    const { en, network, find } = setup();
    const pending = find(en, 'what does running mean?', 2);
    await vi.runAllTimersAsync();
    const [lemma, form] = await pending;
    expect(network.titles()).toEqual(['running', 'run']);
    expect(lemma).toMatchObject({ title: 'run — English Wiktionary', url: fixtures.enRun.url });
    expect(lemma.snippet.split('\n')[0]).toBe('To move swiftly.');
    expect(form.url).toBe(fixtures.enRunning.url);
    expect(form.snippet).toContain('present participle and gerund of run');
  });

  it('uses only the requested language row in a translation section', async () => {
    const { en, network, find } = setup();
    const [hit] = await find(en, 'translate running to Arabic');
    expect(network.titles()).toEqual(['running']);
    expect(hit.url).toBe(fixtures.enRunning.url);
    expect(hit.snippet.split('\n')[0]).toMatch(/^Arabic: رَكْض/u);
    expect(hit.snippet).not.toMatch(/French:|The action of the verb|present participle/u);
  });

  it('looks up a localized translation row in the Arabic edition', async () => {
    const { ar, find } = setup();
    const [hit] = await find(ar, 'ترجم كِتَاب إلى الإنجليزية');
    expect(hit.url).toBe(fixtures.arVocalizedBook.url);
    expect(hit.snippet.split('\n')[0]).toBe('بالإنجليزية: book (en)');
  });

  it('uses the English entry’s sense-level synonym annotation', async () => {
    const { en, find } = setup();
    const [hit] = await find(en, 'synonyms of running');
    expect(hit.url).toBe(fixtures.enRunning.url);
    expect(hit.snippet.split('\n')[0]).toBe('Synonym: runny');
  });

  it('falls through for an absent translation and a missing entry', async () => {
    const { en, find } = setup();
    const pending = find(en, 'translate running to Klingon');
    await vi.runAllTimersAsync();
    expect(await pending).toEqual([]);
    const missing = find(en, 'what does mohassan-language-fixture-missing-20261127 mean?');
    await vi.runAllTimersAsync();
    expect(await missing).toEqual([]);
  });

  it('honors real robots restrictions on both editions before dispatching the API request', async () => {
    const { ar, en, network, find } = setup(new WiktionaryNetwork(wiktionaryRobotsExcerpt));
    const results = Promise.allSettled([find(ar, 'ما جمع كتاب'), find(en, 'what does running mean?')]);
    await vi.runAllTimersAsync();
    expect(await results).toEqual([
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ kind: 'unavailable' }) }),
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ kind: 'unavailable' }) }),
    ]);
    expect(network.requests.map(url => url.href)).toEqual(['https://ar.wiktionary.org/robots.txt', 'https://en.wiktionary.org/robots.txt']);
  });

  it('honors an HTTP 429 Retry-After across both editions', async () => {
    const { ar, en, network, find } = setup();
    network.limited = true;
    await expect(find(en, 'what does running mean?')).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 7_000 });
    expect(en.cooldownMs?.()).toBe(7_000);
    await expect(find(ar, 'ما معنى كلمة كِتَاب')).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 7_000 });
    expect(network.titles()).toEqual(['running']);
    await vi.advanceTimersByTimeAsync(7_000);
    network.limited = false;
    const [hit] = await find(ar, 'ما معنى كلمة كِتَاب');
    expect(hit.url).toBe(fixtures.arVocalizedBook.url);
  });
});
