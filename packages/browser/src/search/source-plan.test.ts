import { describe, expect, it } from 'vitest';
import { planSources, sourceSearchText } from './source-plan.js';

describe('source planning', () => {
  // Expected named hosts are the primary destinations cited and dated in source-plan.ts.
  it.each([
    ['ابحث في موقع الجزيرة عن الزلزال', 'aljazeera.net', 'ar'],
    ['من موقع وزارة الصحة', 'moh.gov.sa', 'ar'],
    ['اللقاحات من موقع وزارة الصحة السعودية', 'moh.gov.sa', 'ar'],
    ['ابحث عن فيديو على يوتيوب', 'youtube.com', 'ar'],
    ['أخبار الجزيرة', 'aljazeera.net', 'ar'],
    ['Find case numbers from the World Health Organization', 'who.int', 'en'],
    ['Search Al Jazeera for the ceasefire', 'aljazeera.com', 'en'],
    ['BBC News', 'bbc.co.uk', 'en'],
    ['أَخبار بي بي سي', 'bbc.com', 'ar'],
    ['cataracts site:WHO.INT', 'who.int', 'en'],
    ['لقاحات who.int', 'who.int', 'ar'],
    ['who.int', 'who.int', 'en'],
  ])('scopes the requested site in %s', (question, host, language) => {
    const plan = planSources(question);
    expect(plan).toMatchObject({ explicitSites: [host], language });
    expect(plan.reasons[0]?.ar).toContain(host);
    expect(plan.reasons[0]?.en).toContain(host);
  });

  it('discloses the country inferred for an unqualified ministry and respects a different qualifier', () => {
    expect(planSources('من موقع وزارة الصحة').reasons[0]?.ar).toContain('الوزارة السعودية');
    expect(planSources('من موقع وزارة الصحة في مصر').explicitSites).toEqual([]);
  });

  it.each([
    'ما عاصمة اليابان لا تستخدم ويكيبيديا',
    'ما عاصمة اليابان من غير ويكيبيديا؟',
    'What is solar energy, not from Wikipedia?',
    'Solar energy without Wikipedia.',
    'Solar energy -site:wikipedia.org',
  ])('retains the Wikipedia exclusion in %s', question => {
    expect(planSources(question)).toMatchObject({ explicitSites: [], excludedSites: ['wikipedia.org'] });
  });

  it('retains multiple sites and exclusions without letting them enter retrieval terms', () => {
    const question = 'Find flu symptoms from WHO and YouTube, not from Wikipedia.';
    expect(planSources(question)).toMatchObject({
      explicitSites: ['who.int', 'youtube.com'],
      excludedSites: ['wikipedia.org'],
      domains: ['health'],
    });
    expect(sourceSearchText(question)).toBe('flu symptoms.');
    expect(sourceSearchText('ابحث في موقع الجزيرة عن "صَرْف المياه"')).toBe('"صَرْف المياه"');
  });

  it('keeps quoted subjects, software names and questions about a website as topics', () => {
    expect(planSources('The phrase "not from Wikipedia site:who.int"').explicitSites).toEqual([]);
    expect(planSources('The phrase "not from Wikipedia site:who.int"').excludedSites).toEqual([]);
    expect(planSources('What is Wikipedia?').explicitSites).toEqual([]);
    expect(planSources('search who wrote Hamlet').explicitSites).toEqual([]);
    const release = 'ما هو آخَر إصدار مستقر من Node.js';
    expect(sourceSearchText(release)).toBe(release);
    expect(planSources(release)).toMatchObject({ explicitSites: [], domains: ['programming'], language: 'ar', fresh: true });
  });

  it.each([
    ['ما أحدث أخبار سوريا؟', 'news', true],
    ['What are the symptoms of cataracts?', 'health', false],
    ['كم عدد سكان فرنسا حالياً؟', 'official_statistics', true],
    ['UK passport renewal fees', 'government', true],
    ['مقالة في مجلة علمية عن الخوارزميات', 'scholarly', false],
    ['What does the Quran say about charity?', 'religion', false],
    ['ما معنى كلمة سَدَف؟', 'language', false],
    ['Train tickets to London tomorrow', 'travel', true],
    ['من هو ألبرت أينشتاين؟', 'encyclopedia', false],
    ['What is the capital of Japan?', 'encyclopedia', false],
    ['ما حالة الطقس غدًا؟', 'general_web', true],
  ])('uses the requested source family in %s', (question, domain, fresh) => {
    expect(planSources(question)).toMatchObject({ domains: [domain], fresh });
  });

  it('does not treat a physical current as a freshness cue', () => {
    expect(planSources('What is direct current?')).toMatchObject({ domains: ['encyclopedia'], fresh: false });
  });

  it('uses context only for a follow-up and lets a new source instruction replace the last choice', () => {
    const previous = ['ما أحدث أخبار سوريا على الجزيرة؟'];
    expect(planSources('وماذا عن مصر؟', previous)).toMatchObject({ explicitSites: ['aljazeera.net'], domains: ['news'], fresh: true });
    expect(planSources('وماذا عن مصر من موقع بي بي سي؟', previous)).toMatchObject({ explicitSites: ['bbc.com'], domains: ['news'] });
    expect(planSources('كم عدد سكان مصر؟', previous)).toMatchObject({ explicitSites: [], domains: ['official_statistics'], fresh: false });
  });
});
