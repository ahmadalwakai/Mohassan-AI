import { describe, expect, it } from 'vitest';
import type { AgentAction, AgentElement, AgentPage } from '@mohassan/browser';
import { pageAnswer, parseHands, runHands, type HandsIO } from '../apps/server/src/assistant/hands.js';
import { judge } from '../apps/server/src/assistant/judge.js';

/**
 * «افتح X وأخبرني بـY» as two steps (hands.ts): open the page, then answer from its own text. The pages and wording here are
 * this test's own; the frozen real set stays a measurement.
 */
const link = (label: string, href: string, ref: string): AgentElement => ({ ref, role: 'link', label, href, inViewport: true });
const pageOf = (address: string, title: string, text: string, elements: AgentElement[] = []): AgentPage => {
  const url = new URL(address).href;
  return {
    id: url, url, title, text, elements, signals: { captcha: false, password: false, otp: false, card: false },
    scroll: { top: 0, height: 1000, viewport: 800 }, hash: url, observedAt: '2026-11-22T16:00:00.000Z', documentStatus: 200,
  };
};
function io(pages: Record<string, AgentPage>): HandsIO {
  return {
    page: async () => null,
    act: async (action: AgentAction) => {
      const opened = pages[new URL(action.text ?? 'https://none.example/').href];
      if (!opened) throw new Error(`Unexpected address: ${action.text}`);
      return opened;
    },
    prepare: async () => null,
    settle: async page => page,
    step: async () => {},
    pause: async () => {},
    approve: async () => {},
    hold: async () => {},
  };
}
const text = (outcome: Awaited<ReturnType<typeof runHands>>) => outcome.kind === 'done' ? outcome.text : '';

const sample = pageOf('https://sample-docs.test/', 'Sample Docs', 'Sample Docs\nGuides for the sample library.\nRead the guides', [link('Read the guides', 'https://sample-docs.test/guides', 'a1')]);
const releases = pageOf('https://tool-releases.test/', 'Tool releases', 'Tool releases\nOlder builds: 4.8.2 and 4.7.0\nLatest: Tool 5.1.3 (stable)\nDownload for Windows');

describe('open a page, then answer a question about it', () => {
  it('plans «افتح … وأخبرني بـ…» as open, then a question about that page', () => {
    expect(parseHands('افتح الموقع https://sample-docs.test في المتصفح وأخبرني بالعنوان الرئيسي ونص الرابط فيه')).toEqual([
      { kind: 'open', url: 'https://sample-docs.test', name: 'sample-docs.test' },
      { kind: 'ask_page', question: 'بالعنوان الرئيسي ونص الرابط فيه' },
    ]);
    expect(parseHands('open https://tool-releases.test and tell me the newest version listed')).toEqual([
      { kind: 'open', url: 'https://tool-releases.test', name: 'tool-releases.test' },
      { kind: 'ask_page', question: 'the newest version listed' },
    ]);
  });

  it('leaves every other request as it was', () => {
    expect(parseHands('افتح bbc.com')).toBeNull();
    expect(parseHands('افتح https://www.wikipedia.org ثم اكتب الطاقة الشمسية في خانة البحث')).toEqual([
      { kind: 'open', url: 'https://www.wikipedia.org', name: 'www.wikipedia.org' },
      { kind: 'type', text: 'الطاقة الشمسية', field: 'البحث' },
    ]);
    expect(parseHands('ابحث عن الطاقة الشمسية وأخبرني بالنتيجة')?.some(step => step.kind === 'ask_page') ?? false).toBe(false);
    expect(parseHands('أخبرني بالعنوان الرئيسي')).toBeNull();
    // A question that does not point at the page is not about it.
    expect(parseHands('افتح https://sample-docs.test وقل لي نكتة')).toBeNull();
    expect(parseHands('open https://sample-docs.test and tell me a joke')).toBeNull();
  });

  it('answers the heading and the link from the page, as quotes the judge finds on the page', async () => {
    const steps = parseHands('افتح https://sample-docs.test وأخبرني بالعنوان الرئيسي ونص الرابط')!;
    const outcome = await runHands({ steps, next: 0, lang: 'ar' }, io({ 'https://sample-docs.test/': sample }));
    expect(outcome).toMatchObject({ kind: 'done', status: 'completed' });
    expect(text(outcome)).toBe('من **Sample Docs** (sample-docs.test):\n\nالعنوان الرئيسي:\n> Sample Docs\n\nنص الرابط:\n> Read the guides');
    const verdict = judge({ question: 'افتح https://sample-docs.test وأخبرني بالعنوان الرئيسي ونص الرابط', reply: text(outcome), status: 'completed',
      evidence: [{ kind: 'page', url: sample.url, title: sample.title, text: sample.text }] });
    expect(verdict.kind).toBe('quote');
    expect(verdict.decision).not.toBe('withhold');
    // Every quote long enough to count as a sentence is found on the page («Sample Docs» is below the judge's minimum length).
    expect(verdict.support!.sentences).toBeGreaterThan(0);
    expect(verdict.support!.supported).toBe(verdict.support!.sentences);
  });

  it('quotes the version the page marks as latest, whatever the question\'s language', () => {
    // «Older builds: 4.8.2 and 4.7.0» names no release word, so it is not offered as the version.
    expect(pageAnswer(releases, 'بآخر إصدار مذكور في الصفحة', 'ar')).toEqual({
      parts: [{ label: 'الإصدار المذكور في الصفحة:', quotes: ['Latest: Tool 5.1.3'] }], missing: [],
    });
  });

  it('reads a page the browser joined into one line, as it does for every opened page', () => {
    // agent-browser.ts collapses the page's whitespace, so a heading is the title at the top of the text, not a line of its own.
    const joined = pageOf('https://joined.test/', 'Joined Site', 'Joined Site This site is for documentation examples. Downloads Latest: Joined 7.2.0 Older releases Learn more',
      [link('Learn more', 'https://joined.test/more', 'a1')]);
    expect(pageAnswer(joined, 'العنوان الرئيسي ونص الرابط وآخر إصدار في الصفحة', 'ar')).toEqual({
      parts: [
        { label: 'العنوان الرئيسي:', quotes: ['Joined Site'] },
        { label: 'نص الرابط:', quotes: ['Learn more'] },
        { label: 'الإصدار المذكور في الصفحة:', quotes: ['Latest: Joined 7.2.0'] },
      ],
      missing: [],
    });
  });

  it('never quotes a title the page text does not show, and names it as not found', () => {
    const bare = pageOf('https://bare.test/', 'Welcome to Bare', 'Menu Home About\nBare is a small tool.');
    expect(pageAnswer(bare, 'the main heading', 'en')).toEqual({ parts: [], missing: ['the main heading'] });
  });

  it('answers the part it found and says which part it did not, as a partial result', async () => {
    const page = pageOf('https://half.test/', 'Welcome to Half', 'Menu Home About\nHalf is a small tool.\nGet started', [link('Get started', 'https://half.test/start', 'a1')]);
    const steps = parseHands('افتح https://half.test وأخبرني بالعنوان الرئيسي ونص الرابط فيها')!;
    const outcome = await runHands({ steps, next: 0, lang: 'ar' }, io({ 'https://half.test/': page }));
    expect(outcome).toMatchObject({ kind: 'done', status: 'partial' });
    expect(text(outcome)).toBe('من **Welcome to Half** (half.test):\n\nنص الرابط:\n> Get started\n\nلم أجد في نص الصفحة: العنوان الرئيسي.');
  });

  it('says what it opened and that the page has no answer, as a partial result', async () => {
    const steps = parseHands('open https://sample-docs.test and tell me the opening hours shown on the page')!;
    const outcome = await runHands({ steps, next: 0, lang: 'en' }, io({ 'https://sample-docs.test/': sample }));
    expect(outcome).toMatchObject({ kind: 'done', status: 'partial' });
    expect(text(outcome)).toMatch(/^I opened \*\*Sample Docs\*\* \(sample-docs\.test\), but found nothing on the page that answers “the opening hours shown on the page”\./u);
  });
});
