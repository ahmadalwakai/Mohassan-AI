import { afterEach, expect, it, vi } from 'vitest';
import { readableSource, type AgentPage } from '@mohassan/browser';
import { articleUrl, runHands, webQuestion, type HandsIO } from '../apps/server/src/assistant/hands.js';
import { createHttpPageReader } from '../apps/server/src/assistant/http-page-reader.js';

const subject = 'نوارق';
const url = articleUrl(subject, 'ar');
const question = `ما عاصمة ${subject}؟`;
// Fictional article and answer for the ranking regression.
const answer = 'عاصمة نوارق هي مدينة مرزان وتضم مقر الحكومة.';
const fillerSentence = 'هذه فقرة حشو في اختبار قارئ الصفحات. ';
const filler = (characters: number) => fillerSentence.repeat(Math.ceil(characters / fillerSentence.length));
const html = `<title>${subject} - ويكيبيديا</title><main>
  <h1>${subject}</h1><p>${filler(65_000)}</p>
  <section><h2>العاصمة</h2><p>${answer}</p></section>
  <section><h2>الملحق</h2><p>${filler(150_000)}</p><p>لا يظهر خارج النافذة.</p></section>
</main>`;

function fixtureReader() {
  const body = Buffer.from(html, 'utf8');
  return createHttpPageReader({ async request(requestedUrl) {
    return { url: requestedUrl, status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body };
  } }, { async assertAllowed() {} });
}

afterEach(() => vi.unstubAllEnvs());

it('keeps the default 60,000-character extraction for the local index', () => {
  const legacy = readableSource(html, url);
  expect(legacy.text).toHaveLength(60_000);
  expect(legacy.text.startsWith(`${subject} ${fillerSentence}`)).toBe(true);
  expect(legacy.text).not.toContain(answer);
});

it('marks the cut after a complete line when the next claim would be clipped', () => {
  const intro = 'The previous amount is unknown.';
  const claim = 'The total is 123456.';
  const limit = `${intro}\n${claim}`.indexOf('4');
  const page = readableSource(`<p>${intro}</p><p>${claim}</p>`, url, limit);
  expect(page.text).toBe(`${intro}\n…`);
});

it('keeps complete words when a single long paragraph has no sentence breaks', () => {
  const page = readableSource('<p>Unpunctuated page text</p>', url, 'Unpunctuated pag'.length);
  expect(page.text).toBe('Unpunctuated\n…');
});

it('defaults to the same flat 60,000-character text as the local extractor', async () => {
  vi.stubEnv('MOHASSAN_SECTIONED_WEB_EVIDENCE', undefined);
  await expect(fixtureReader()(url, new AbortController().signal)).resolves.toMatchObject({
    text: readableSource(html, url).text,
  });
});

it('reads and ranks an Arabic answer after 60,000 characters when the 200,000-character window is enabled', async () => {
  vi.stubEnv('MOHASSAN_SECTIONED_WEB_EVIDENCE', '1');
  const reader = fixtureReader();
  const signal = new AbortController().signal;
  const start = performance.now();
  const page = await reader(url, signal);
  const elapsed = performance.now() - start;
  // Regression ceiling for a 200k read with in-memory HTTP and robots responses.
  expect(elapsed).toBeLessThan(1_000);
  if (!page || typeof page !== 'object' || !('text' in page)) throw new Error('The fixture page was not read');
  expect(page.text.length).toBeLessThanOrEqual(200_000);
  expect(page.text.length).toBeGreaterThan(200_000 - fillerSentence.length);
  expect(page.text).toContain(`\nالعاصمة ${answer}\nالملحق `);
  expect(page.text.indexOf(answer)).toBeGreaterThan(60_000);
  expect(page.text.endsWith('…')).toBe(true);
  expect(page.text).not.toContain('لا يظهر خارج النافذة');

  const act = vi.fn(async () => { throw new Error('The hidden browser was opened'); });
  const io: HandsIO = {
    page: async () => null,
    search: async () => [{ url, title: subject, snippet: '' }],
    read: async requestedUrl => {
      const result = await reader(requestedUrl, signal);
      if (!result || typeof result !== 'object' || !('text' in result) || !result.fetchedAt) return { kind: 'unreadable' };
      const read: AgentPage = {
        id: result.url, url: result.url, title: result.title, text: result.text, elements: [],
        signals: { captcha: false, password: false, otp: false, card: false },
        scroll: { top: 0, height: 0, viewport: 0 }, hash: '', observedAt: result.fetchedAt, documentStatus: result.status,
      };
      return { kind: 'page', page: read };
    },
    act, prepare: async () => null, settle: async page => page,
    step: async () => {}, pause: async () => {}, approve: async () => {}, hold: async () => {},
  };
  const outcome = await runHands({ next: 0, steps: webQuestion(question)! }, io);
  expect(outcome).toMatchObject({ kind: 'done', status: 'completed', text: expect.stringContaining(answer) });
  expect(act).not.toHaveBeenCalled();
});
