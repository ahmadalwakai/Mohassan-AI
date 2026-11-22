import { describe, expect, it } from 'vitest';
import { approvalChoice, backgroundChoice, browserStartedChoice, changeBrowserVisibility, createBrowserVisibility, decideBrowserVisibility, opensPanel, userStepChoice } from '../apps/server/src/assistant/browser-visibility.js';

const level = (request: string, extra: Partial<Parameters<typeof decideBrowserVisibility>[0]> = {}) => decideBrowserVisibility({ request, ...extra });

describe('decideBrowserVisibility: the table of §6.1', () => {
  it('keeps local work at level 0', () => {
    expect(level('كم 15 ضرب 23؟')).toMatchObject({ level: 0, code: 'local_compute' });
    // The hands rules alone read English arithmetic as a web question; the chat's routing names it compute first.
    expect(level('What is 17% of 250?', { route: 'compute' })).toMatchObject({ level: 0, code: 'local_compute' });
    expect(level('Calculate 241 + 178')).toMatchObject({ level: 0, code: 'local_compute' });
    expect(level('من ذاكرتي، ما مدينتي المفضلة؟')).toMatchObject({ level: 0, code: 'local_memory' });
    expect(level('اكتب رسالة بريد احترافية')).toMatchObject({ level: 0, code: 'local_card' });
    expect(level('خطط لأسبوعي')).toMatchObject({ level: 0, code: 'local_card' });
    expect(level('مرحبا')).toMatchObject({ level: 0, code: 'local_chat' });
    expect(level('ذكرني بعد ساعة أن أشرب الماء')).toMatchObject({ level: 0, code: 'reminder' });
    expect(level('', { route: null })).toMatchObject({ level: 0, code: 'clarify' });
  });

  it('answers knowledge and live questions over the network, level 1', () => {
    expect(level('ما عاصمة اليابان؟')).toMatchObject({ level: 1, code: 'web_knowledge' });
    expect(level('who wrote the novel One Hundred Years of Solitude')).toMatchObject({ level: 1, code: 'web_knowledge' });
    expect(level('كم سعر الذهب اليوم؟')).toMatchObject({ level: 1, code: 'web_live' });
    expect(level('what is the weather in London today')).toMatchObject({ level: 1, code: 'web_live' });
    expect(level('أرني الطقس في الرياض')).toMatchObject({ level: 1 });
    expect(level('اعرض لي أخبار اليوم')).toMatchObject({ level: 2, code: 'news_page' });
    expect(level('وكم عدد سكانها؟', { earlier: ['ما عاصمة اليابان؟'] })).toMatchObject({ level: 1 });
  });

  it('runs steps inside a site in a hidden browser, level 2', () => {
    expect(level('ابحث في gov.uk عن تجديد الجواز وافتح النتيجة الثانية')).toMatchObject({ level: 2, code: 'browser_steps' });
    expect(level('افتح gov.uk وابحث عن passport renewal')).toMatchObject({ level: 2, code: 'browser_steps' });
    expect(level('search for python dataclasses on docs.python.org then open the first result')).toMatchObject({ level: 2, code: 'browser_steps' });
    expect(level('لخّص لي أهم أخبار اليوم')).toMatchObject({ level: 2, code: 'news_page' });
    expect(level("what's the news today")).toMatchObject({ level: 2, code: 'news_page' });
  });

  it('puts the browser in front only for an explicit ask or a bare open, level 3', () => {
    expect(level('افتح يوتيوب وأرني طريقة تغيير إطار السيارة')).toMatchObject({ level: 3, code: 'explicit_show' });
    expect(level('افتح موقعًا واعرض لي محتواه')).toMatchObject({ level: 3, code: 'explicit_show' });
    expect(level('open youtube and show me how to change a tyre')).toMatchObject({ level: 3, code: 'explicit_show' });
    expect(level('افتح https://ads.google.com')).toMatchObject({ level: 3, code: 'open_only' });
    expect(level('https://www.speedyvan.uk/')).toMatchObject({ level: 3, code: 'open_only' });
    expect(level('افتح https://www.python.org وأخبرني بآخر إصدار مذكور في الصفحة.')).toMatchObject({ level: 2, code: 'browser_steps' });
    expect(level('أرني الصفحة عن الخوارزمي')).toMatchObject({ level: 3, code: 'explicit_show' });
    expect(level('تصفح موقع gov.uk')).toMatchObject({ level: 3, code: 'explicit_show' });
  });

  it('forbids computer browsers to members and keeps their questions at level 1', () => {
    expect(level('افتح www.hsbc.co.uk وادخل إلى حسابي', { role: 'member' })).toMatchObject({ level: 4, code: 'member_no_browser' });
    expect(level('open hsbc.co.uk', { role: 'member' })).toMatchObject({ level: 4 });
    expect(level('افتح يوتيوب وأرني مقاطع', { role: 'member' })).toMatchObject({ level: 4 });
    expect(level('أرني الصفحة عن الخوارزمي', { role: 'member' })).toMatchObject({ level: 1 });
    expect(level('ما عاصمة اليابان؟', { role: 'member' })).toMatchObject({ level: 1 });
    expect(level('لخّص لي أهم أخبار اليوم', { role: 'member' })).toMatchObject({ level: 1 });
    expect(level('كم 15 ضرب 23؟', { role: 'member' })).toMatchObject({ level: 0 });
  });

  it('follows the chat routing decision when it exists', () => {
    expect(level('أنشئ حملة إعلانية لموقع dukestreettyres.com', { route: 'ads' })).toMatchObject({ level: 0, code: 'ads' });
    expect(level('ارسم لي صورة قطة', { route: 'image' })).toMatchObject({ level: 0, code: 'unsupported' });
    expect(level('ما هذا؟', { route: 'clarify' })).toMatchObject({ level: 0, code: 'clarify' });
    expect(level('لخّص لي أهم أخبار اليوم', { route: 'news' })).toMatchObject({ level: 2, code: 'news_page' });
    expect(level('كم سعر الدولار مقابل الجنيه المصري؟', { route: 'web_search' })).toMatchObject({ level: 1, code: 'web_live' });
    expect(level('ما فوائد الشاي الأخضر؟', { route: 'web_search' })).toMatchObject({ level: 1, code: 'web_knowledge' });
    expect(level('افتح يوتيوب وأرني مقاطع', { route: 'browser_command' })).toMatchObject({ level: 3, code: 'explicit_show' });
    expect(level('افتح gov.uk وابحث عن passport renewal', { route: 'browser_command' })).toMatchObject({ level: 2 });
    expect(level('افحص المشروع ما هي الوظائف الغير مكتملة', { route: 'pc' })).toMatchObject({ level: 0, code: 'computer' });
  });

  it('writes the reason in the language of the request', () => {
    expect(level('ما عاصمة اليابان؟').reason).toBe('سؤال معرفة عامة: بحث عبر الشبكة دون متصفح');
    expect(level('What is the speed of light?').reason).toBe('General knowledge: searched over the network without a browser');
    expect(level('Calculate 241 + 178').reason).toMatch(/no browser/);
  });

  it('is deterministic', () => {
    for (const text of ['ما عاصمة اليابان؟', 'افتح يوتيوب وأرني مقاطع', 'كم 15 ضرب 23؟', 'لخّص لي أهم أخبار اليوم']) {
      expect(level(text)).toEqual(level(text));
    }
  });
});

describe('the run changes the level only with a reason', () => {
  const at = new Date('2026-11-22T03:00:00.000Z');
  it('records each change and keeps the request-time level', () => {
    const start = createBrowserVisibility(decideBrowserVisibility({ request: 'ما عاصمة اليابان؟' }), { canView: true, lang: 'ar', at });
    expect(start).toMatchObject({ version: 1, level: 1, requested: 1, canView: true, decidedAt: at.toISOString(), history: [{ level: 1, code: 'web_knowledge', at: at.toISOString() }] });
    const opened = changeBrowserVisibility(start, browserStartedChoice('البحث عن «ما عاصمة اليابان»…', 'ar'), new Date(at.getTime() + 1000));
    expect(opened).toMatchObject({ level: 2, code: 'browser_started', requested: 1, reason: 'فُتح متصفح مخفي: البحث عن «ما عاصمة اليابان»' });
    const login = changeBrowserVisibility(opened, userStepChoice({ kind: 'login', site: 'https://accounts.example.com' }, 'ar'), new Date(at.getTime() + 2000));
    expect(login).toMatchObject({ level: 3, code: 'needs_login', reason: 'هذه الخطوة تحتاجك: تسجيل الدخول إلى accounts.example.com' });
    const back = changeBrowserVisibility(login, backgroundChoice('ar'), new Date(at.getTime() + 3000));
    expect(back).toMatchObject({ level: 2, code: 'background_resumed', requested: 1 });
    expect(back.history.map(entry => entry.level)).toEqual([1, 2, 3, 2]);
    expect(changeBrowserVisibility(back, backgroundChoice('ar'))).toBe(back);
  });

  it('names the step for codes, human checks and approvals', () => {
    expect(userStepChoice({ kind: 'code', site: 'https://login.example.com' }, 'en')).toMatchObject({ level: 3, code: 'needs_code', reason: 'This step needs you: the verification code from login.example.com' });
    expect(userStepChoice({ kind: 'hands_on', site: '' }, 'ar')).toMatchObject({ level: 3, code: 'hands_on', reason: 'هذه الخطوة تحتاجك' });
    expect(approvalChoice('consent.google.com', 'ar')).toMatchObject({ level: 3, code: 'needs_approval', reason: 'مراجعة قبل الإرسال إلى consent.google.com' });
    expect(browserStartedChoice(null, 'en').reason).toBe('A hidden browser opened to read the page');
  });

  it('bounds the history to eight entries', () => {
    let record = createBrowserVisibility(decideBrowserVisibility({ request: 'ما عاصمة اليابان؟' }), { canView: true, lang: 'ar', at });
    for (let round = 0; round < 10; round++) {
      record = changeBrowserVisibility(record, round % 2 ? backgroundChoice('ar') : userStepChoice({ kind: 'hands_on', site: 'x.example' }, 'ar'), new Date(at.getTime() + round * 1000));
    }
    expect(record.history).toHaveLength(8);
    expect(record.requested).toBe(1);
  });
});

describe('opensPanel: the owner setting', () => {
  const record = (level: 0 | 1 | 2 | 3 | 4, code: string, canView = true) => ({ level, code, canView } as Parameters<typeof opensPanel>[0]);
  it('opens for a step that needs the user, and for an explicit ask only when wanted', () => {
    expect(opensPanel(record(3, 'needs_login'), 'needed')).toBe(true);
    expect(opensPanel(record(3, 'explicit_show'), 'needed')).toBe(true);
    expect(opensPanel(record(3, 'explicit_show'), 'necessary')).toBe(false);
    expect(opensPanel(record(3, 'needs_login'), 'necessary')).toBe(true);
    expect(opensPanel(record(2, 'browser_steps'), 'needed')).toBe(false);
    expect(opensPanel(record(2, 'browser_steps'), 'always')).toBe(true);
    expect(opensPanel(record(1, 'web_knowledge'), 'always')).toBe(false);
    expect(opensPanel(record(3, 'needs_login', false), 'always')).toBe(false);
  });
});
