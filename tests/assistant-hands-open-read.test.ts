import { describe, expect, it, vi } from 'vitest';
import type { AgentAction, AgentElement, AgentPage } from '@mohassan/browser';
import { describe as describeReply, isBareAddress, parseHands, runHands, shownLabel, siteToOpen, unnamedSite, type HandsIO } from '../apps/server/src/assistant/hands.js';

/**
 * «افتح موقعًا واعرض لي محتواه» and its kin (hands.ts): the production test of 2026-11-23 found the home screen's own suggestion
 * refused as private, a bare link refused, and «افتح X واعرض لي محتواه» opened and then «not verified». The pages, addresses and
 * wordings here are this test's own.
 */
const link = (label: string, href: string, ref: string): AgentElement => ({ ref, role: 'link', label, href, inViewport: true });
const pageOf = (address: string, title: string, text: string, elements: AgentElement[] = []): AgentPage => {
  const url = new URL(address).href;
  return {
    id: url, url, title, text, elements, signals: { captcha: false, password: false, otp: false, card: false },
    scroll: { top: 0, height: 1000, viewport: 800 }, hash: url, observedAt: '2026-11-23T12:00:00.000Z', documentStatus: 200,
  };
};
function io(pages: Record<string, AgentPage>): HandsIO {
  return {
    page: async () => null,
    act: async (action: AgentAction) => {
      const address = /^https?:\/\//iu.test(action.text ?? '') ? action.text! : `https://${action.text}`;
      const opened = pages[new URL(address).href];
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

const notes = pageOf('https://field-notes.test/', 'Field Notes', 'Field Notes\nThis site keeps short records of each visit to the field.\nEach note names the place and the date.');

describe('open a page and show what it says', () => {
  it('plans «افتح X واعرض لي محتواه» and its variants as open, then read', () => {
    const openRead = (url: string, name: string) => [{ kind: 'open', url, name }, { kind: 'read', more: false }];
    expect(parseHands('افتح https://field-notes.test واعرض لي محتواه')).toEqual(openRead('https://field-notes.test', 'field-notes.test'));
    expect(parseHands('افتح الموقع field-notes.test ثم اقرأه')).toEqual(openRead('field-notes.test', 'field-notes.test'));
    expect(parseHands('افتح https://field-notes.test/guide، وأرني ما فيها')).toEqual(openRead('https://field-notes.test/guide', 'field-notes.test'));
    expect(parseHands('Open https://field-notes.test and show me its content')).toEqual(openRead('https://field-notes.test', 'field-notes.test'));
    expect(parseHands('open field-notes.test then read it')).toEqual(openRead('field-notes.test', 'field-notes.test'));
  });

  it('reads a message that is only an address, and nothing else that merely holds one', () => {
    expect(parseHands('https://field-notes.test/guide')).toEqual([{ kind: 'open', url: 'https://field-notes.test/guide', name: 'field-notes.test' }, { kind: 'read', more: false }]);
    expect(parseHands('field-notes.org')).toEqual([{ kind: 'open', url: 'field-notes.org', name: 'field-notes.org' }, { kind: 'read', more: false }]);
    expect(isBareAddress('www.field-notes.co.uk/visits?page=2')).toBe(true);
    // A word with a dot is not an address: «vue.js» and «notes.txt» are still asked about, not opened.
    expect(isBareAddress('vue.js')).toBe(false);
    expect(isBareAddress('notes.txt')).toBe(false);
    expect(parseHands('ما هو https://field-notes.test؟')).toBeNull();
  });

  it('reads the open page on «اعرض لي محتواه» and «show me its content»', () => {
    expect(parseHands('اعرض لي محتواه')).toEqual([{ kind: 'read', more: false }]);
    expect(parseHands('أرني ما فيها')).toEqual([{ kind: 'read', more: false }]);
    expect(parseHands('show me its content')).toEqual([{ kind: 'read', more: false }]);
  });

  it('leaves the other requests as they were', () => {
    // A screenshot, a question about the page, a lone open and an unrelated ask keep their own paths.
    expect(parseHands('افتح field-notes.test واعرض لي لقطة شاشة')).toBeNull();
    expect(parseHands('افتح https://field-notes.test وأخبرني بالعنوان الرئيسي')).toEqual([
      { kind: 'open', url: 'https://field-notes.test', name: 'field-notes.test' }, { kind: 'ask_page', question: 'بالعنوان الرئيسي' }]);
    expect(parseHands('افتح field-notes.test')).toBeNull();
    expect(parseHands('افتح https://field-notes.test وقل لي نكتة')).toBeNull();
    expect(parseHands('اعرض لي صورة')).toBeNull();
  });

  it('opens and reads the page in the owner\'s language', async () => {
    const ar = await runHands({ steps: parseHands('افتح https://field-notes.test واعرض لي محتواه')!, next: 0, lang: 'ar' }, io({ 'https://field-notes.test/': notes }));
    // The page's sentences as written; «Field Notes» alone is a heading, not a sentence, so it is not quoted.
    expect(ar).toEqual({ kind: 'done', status: 'completed', text: 'من **Field Notes** (field-notes.test):\n\n> This site keeps short records of each visit to the field. Each note names the place and the date.' });
    const en = await runHands({ steps: parseHands('Open https://field-notes.test and show me its content')!, next: 0, lang: 'en' }, io({ 'https://field-notes.test/': notes }));
    expect(en).toEqual({ kind: 'done', status: 'completed', text: 'From **Field Notes** (field-notes.test):\n\n> This site keeps short records of each visit to the field. Each note names the place and the date.' });
  });
});

describe('a website the request does not name', () => {
  it('recognises the home suggestion and its kin, and nothing that names a site', () => {
    expect(unnamedSite('افتح موقعًا واعرض لي محتواه')).toEqual({ read: true, lang: 'ar' });
    expect(unnamedSite('افتح لي موقعا ثم اقرأه')).toEqual({ read: true, lang: 'ar' });
    expect(unnamedSite('افتح صفحة')).toEqual({ read: false, lang: 'ar' });
    expect(unnamedSite('Open a website and show me its content')).toEqual({ read: true, lang: 'en' });
    expect(unnamedSite('افتح موقع field-notes.test')).toBeNull();
    expect(unnamedSite('افتح الموقع واعرض لي محتواه')).toEqual({ read: true, lang: 'ar' });
    expect(unnamedSite('ابنِ لي موقعًا')).toBeNull();
  });

  it('distinguishes a missing browser destination from a link or a live page', () => {
    const readCurrentPage = vi.fn();
    expect(unnamedSite('Kindly open the web page for us.', readCurrentPage)).toEqual({ read: false, lang: 'en' });
    expect(parseHands('Open the web page for us.')).toBeNull();
    expect(parseHands('Open the membership link.')).toEqual([{ kind: 'click', target: 'membership link', ordinal: null }]);
    expect(unnamedSite('ادخل على الرابط اللي أعنيه')).toEqual({ read: false, lang: 'ar' });
    expect(unnamedSite('افتح صفحة الدعم التي أقصدها')).toBeNull();
    expect(readCurrentPage).not.toHaveBeenCalled();
    expect(unnamedSite('Visit this webpage and display its text.')).toEqual({ read: true, lang: 'en' });
    expect(unnamedSite('Visit this webpage and display its text.', readCurrentPage)).toBeNull();
    expect(readCurrentPage).toHaveBeenCalledExactlyOnceWith({ steps: [{ kind: 'read', more: false }], next: 0, lang: 'en' });
  });

  it('takes the site from the owner\'s answer: an address, a known site, or «افتح X»', () => {
    expect(siteToOpen('field-notes.test')).toEqual({ url: 'field-notes.test', name: 'field-notes.test' });
    expect(siteToOpen('https://field-notes.test/guide')).toEqual({ url: 'https://field-notes.test/guide', name: 'field-notes.test' });
    expect(siteToOpen('افتح موقع field-notes.test من فضلك')).toEqual({ url: 'field-notes.test', name: 'field-notes.test' });
    expect(siteToOpen('يوتيوب')).toEqual({ url: 'https://www.youtube.com/', name: 'YouTube' });
    expect(siteToOpen('لا أعرف بعد')).toBeNull();
  });
});

describe('a link text the browser cut', () => {
  // The browser keeps the first 90 characters of an element's text (agent-browser.ts), here inside «المقبل».
  const long = 'وزارة الزراعة تعلن خطة جديدة لدعم صغار المزارعين في المحافظات الجنوبية خلال موسم الحصاد المقبل بعد الأمطار'.slice(0, 90);

  it('ends on a whole word with «…», and leaves a short text as it is', () => {
    expect(long.endsWith('الحصاد ال')).toBe(true);
    expect(shownLabel(long, 110)).toBe('وزارة الزراعة تعلن خطة جديدة لدعم صغار المزارعين في المحافظات الجنوبية خلال موسم الحصاد…');
    expect(shownLabel('وزارة الزراعة تعلن خطة جديدة', 110)).toBe('وزارة الزراعة تعلن خطة جديدة');
    // A long text cut by the reply itself ends on a whole word too.
    expect(shownLabel('Field notes keep short records of each site visit and name the place', 40)).toBe('Field notes keep short records of each…');
  });

  it('lists a front page\'s headlines without a word cut in two', () => {
    const front = pageOf('https://daily-news.test/', 'Daily News', `${long} Weather today`, [
      link(long, 'https://daily-news.test/articles/farm-plan', 'a1'),
      link('الطقس اليوم في العاصمة والمدن الساحلية', 'https://daily-news.test/articles/weather-today', 'a2'),
      link('Weather today', 'https://daily-news.test/weather', 'a3'),
    ]);
    const { text } = describeReply({ steps: [{ kind: 'news', source: { url: front.url, name: 'Daily News' }, topic: '' }], next: 1 }, front);
    expect(text).toContain('1. [وزارة الزراعة تعلن خطة جديدة لدعم صغار المزارعين في المحافظات الجنوبية خلال موسم الحصاد…](https://daily-news.test/articles/farm-plan)');
    expect(text).toContain('2. [الطقس اليوم في العاصمة والمدن الساحلية](https://daily-news.test/articles/weather-today)');
    expect(text).not.toContain('الحصاد ال]');
  });
});
