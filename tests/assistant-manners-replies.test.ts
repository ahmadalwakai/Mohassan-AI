import { describe, expect, it } from 'vitest';
import type { MannersDetection } from '../apps/server/src/assistant/manners/detect.js';
import { isMannersLanguageDirective, selectMannersLanguage } from '../apps/server/src/assistant/manners/language.js';
import { renderMannersClause, renderMannersReply } from '../apps/server/src/assistant/manners/replies.js';

function detection(act: MannersDetection['act'], overrides: Partial<MannersDetection> = {}): MannersDetection {
  return { act, language: 'en', dialect: null, request: null, socialText: '', ...overrides };
}

describe('manners reply language', () => {
  it.each([
    ['Good evening, يا موحسن.', 'en'],
    ['شكرًا يا Mohassan.', 'ar'],
    ['Thanks. "رد بالعربي"', 'en'],
    ['أهلًا، «reply in English»', 'ar'],
    ['salam 3alaykom يا Mohassan', 'ar'],
  ] as const)('keeps the matched expression language for %s', (text, language) => {
    expect(selectMannersLanguage(text, language)).toBe(language);
  });

  it.each([
    ['Good evening, please reply in Arabic.', 'en', 'ar'],
    ['أهلًا، أجب بالإنجليزية من فضلك.', 'ar', 'en'],
    ['Reply in English: كيفك؟', 'ar', 'en'],
    ['Merci. Reply in Arabic. Reply in English.', 'ar', 'en'],
  ] as const)('honors an explicit outer reply-language instruction in %s', (text, matched, expected) => {
    expect(selectMannersLanguage(text, matched)).toBe(expected);
  });

  it('recognizes a standalone direction without treating quoted content or a task as a direction', () => {
    expect(isMannersLanguageDirective('Please respond in Arabic.')).toBe(true);
    expect(isMannersLanguageDirective('جاوب بالعربي لو سمحت')).toBe(true);
    expect(isMannersLanguageDirective('"reply in Arabic"')).toBe(false);
    expect(isMannersLanguageDirective('Reply in Arabic: "A message to translate."')).toBe(false);
    expect(isMannersLanguageDirective('Reply in Arabic: look up today’s exchange rate.')).toBe(false);
  });
});

describe('manners reply rendering', () => {
  it('varies repeated greetings across turns and stays stable for a retry', () => {
    const greeting = detection('greeting', { socialText: 'Hi there!' });
    const one = renderMannersReply(greeting, undefined, 'turn-1');
    const two = renderMannersReply(greeting, undefined, 'turn-2');
    expect(one.text).not.toBe(two.text);
    expect(one).toEqual(renderMannersReply(greeting, undefined, 'turn-1'));
    expect(one).toMatchObject({ status: 'completed', evidence: [], claims: [{ status: 'fixed', support: [] }] });
    expect(one.text.match(/\?/gu)).toHaveLength(1);
  });

  it('uses light dialect mirroring when a dialect is known and Modern Standard Arabic otherwise', () => {
    const local = renderMannersReply(detection('greeting', { language: 'ar', dialect: 'iraqi' }));
    const standard = renderMannersReply(detection('greeting', { language: 'ar', dialect: 'msa' }));
    expect(local.text).toMatch(/هلا/u);
    expect(standard.text).toMatch(/^مرحبًا/u);
    expect(renderMannersReply(detection('greeting', { language: 'en', dialect: 'iraqi' })).text).toMatch(/^Hi/u);
  });

  it('answers salutations, introductions and goodnight in context', () => {
    expect(renderMannersReply(detection('greeting', { language: 'ar', detail: 'peace' })).text).toMatch(/^وعليكم السلام/u);
    expect(renderMannersReply(detection('greeting', { detail: 'meeting' })).text).toBe('Nice to meet you too!');
    expect(renderMannersReply(detection('farewell', { detail: 'night' })).text).toBe('Good night!');
  });

  it('does not solicit a task in a quiet greeting or a greeting wrapped around a task', () => {
    const quiet = detection('greeting', { detail: 'quiet' });
    const variants = ['a', 'b', 'c'].map(turn => renderMannersReply(quiet, undefined, turn).text);
    expect(new Set(variants).size).toBeGreaterThan(1);
    for (const variant of variants) expect(variant).toMatch(/^(?:Hi|Hello)(?: there)?!$/u);
    expect(renderMannersClause(detection('greeting', { request: 'Calculate 18 + 23' }))).toBe('Hi there!');
  });

  it.each([
    ['thanks', /^You’re welcome/u, /^العفو/u],
    ['apology', /^No worries/u, /^لا بأس/u],
    ['compliment', /^Thank you/u, /^شكرًا/u],
    ['farewell', /^See you/u, /^إلى اللقاء/u],
    ['wellbeing', /^Doing well/u, /^بخير/u],
    ['joke', /decimal point.+fraction/u, /الفاصلة العشرية.+جزء/u],
    ['encouragement', /^Thanks/u, /^شكرًا/u],
    ['insult', /^I’m here to help/u, /^أنا هنا للمساعدة/u],
  ] as const)('answers %s briefly in both languages', (act, english, arabic) => {
    const en = renderMannersReply(detection(act)).text;
    const ar = renderMannersReply(detection(act, { language: 'ar' })).text;
    expect(en).toMatch(english);
    expect(ar).toMatch(arabic);
    expect(`${en}${ar}`).not.toMatch(/[\r\n?؟]/u);
  });

  it('distinguishes a request for encouragement from encouragement given to the assistant', () => {
    expect(renderMannersReply(detection('encouragement', { detail: 'encourage-me' })).text).toContain('Good luck');
  });

  it('answers identity honestly, with the name alone when asked', () => {
    expect(renderMannersReply(detection('identity')).text).toBe('I’m Mohassan, a digital assistant.');
    expect(renderMannersReply(detection('identity', { detail: 'human' })).text).toMatch(/^No, I’m Mohassan/u);
    expect(renderMannersReply(detection('identity', { language: 'ar', detail: 'name' })).text).toBe('موحسن');
    expect(renderMannersReply(detection('identity', { detail: 'creator' })).text).toContain('Ahmad Alwakai');
  });

  it('lists capabilities from the given account view and only mentions free-form replies when configured', () => {
    const question = detection('capabilities');
    const member = renderMannersReply(question, { chatModel: false, available: ['computation', 'letters'] }).text;
    const owner = renderMannersReply(question, { chatModel: true, available: ['web', 'ads', 'pc'] }).text;
    expect(member).toBe('I can help with calculations and unit and date conversions and formal letters from templates.');
    expect(member).not.toMatch(/Google Ads|computer|free-form/u);
    expect(owner).toMatch(/web search.+Google Ads.+computer.+free-form replies/u);
    expect(renderMannersReply(detection('capabilities', { language: 'ar' }), { chatModel: false, available: ['memory'] }).text)
      .toBe('أستطيع مساعدتك في الحفظ في ذاكرتك والاسترجاع منها.');
    expect(renderMannersReply(question).text).toMatch(/don’t have the capability list/u);
  });
});
