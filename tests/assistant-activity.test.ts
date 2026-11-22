import { describe, expect, it } from 'vitest';
import type { AgentAction, AgentElement, AgentPage } from '@mohassan/browser';
import { hostOf, liveLabel, readingLabel, siteName } from '../apps/server/src/assistant/activity.js';
import { runHands, webQuestion, type HandsIO, type HandsPlan } from '../apps/server/src/assistant/hands.js';
import { activityKind, elapsedLabel } from '../apps/web/components/activity-phase';

const pageOf = (url: string, elements: AgentElement[], text = ''): AgentPage => ({
  id: url, url, title: `Title of ${url}`, text, elements,
  signals: { captcha: false, password: false, otp: false, card: false },
  scroll: { top: 0, height: 1000, viewport: 800 }, hash: url, observedAt: '2026-11-22T00:00:00Z',
});

describe('السطر الحي: صيغة الفعل من سجل الخطوة', () => {
  it('turns a step record into present-tense words', () => {
    expect(liveLabel('قراءة ويكيبيديا')).toBe('يقرأ ويكيبيديا');
    expect(liveLabel('قراءة britannica.com، space.com')).toBe('يقرأ britannica.com، space.com');
    expect(liveLabel('البحث عن «ما عاصمة اليابان»')).toBe('يبحث عن «ما عاصمة اليابان»');
    expect(liveLabel('البحث في الذاكرة عن «مدينتي»')).toBe('يبحث في الذاكرة عن «مدينتي»');
    expect(liveLabel('فتح gov.uk')).toBe('يفتح gov.uk');
    expect(liveLabel('فتح النتيجة 2: Data Classes')).toBe('يفتح النتيجة 2: Data Classes');
    expect(liveLabel('الضغط على «dataclasses — Data Classes»')).toBe('يضغط على «dataclasses — Data Classes»');
    expect(liveLabel('النقر على «تسجيل»')).toBe('ينقر على «تسجيل»');
    expect(liveLabel('الكتابة في «البريد»')).toBe('يكتب في «البريد»');
    expect(liveLabel('إنشاء الحملة متوقفة في Google Ads')).toBe('ينشئ الحملة متوقفة في Google Ads');
    expect(liveLabel('تنفيذ «حذف الملف» بعد موافقتك')).toBe('ينفذ «حذف الملف» بعد موافقتك');
    expect(liveLabel('إعادة قراءة المتصفح لمتابعة الطلب')).toBe('يعيد قراءة المتصفح لمتابعة الطلب');
  });

  it('leaves sentences, English labels and compound nouns as they are', () => {
    expect(liveLabel('لم يُجب البحث الأول؛ البحث عن «الخوارزمي»')).toBe('لم يُجب البحث الأول؛ البحث عن «الخوارزمي»');
    expect(liveLabel('حساب محلي')).toBe('حساب محلي');
    expect(liveLabel('اكتمل تسجيل الدخول')).toBe('اكتمل تسجيل الدخول');
    expect(liveLabel('Verify saved note status')).toBe('Verify saved note status');
    expect(liveLabel('يفهم طلبك')).toBe('يفهم طلبك');
  });

  it('names each site once when several pages are read together', () => {
    expect(readingLabel(['https://ar.wikipedia.org/wiki/a', 'https://ar.wikipedia.org/wiki/b', 'https://ar.wikipedia.org/wiki/c'])).toBe('قراءة ويكيبيديا (3 صفحات)');
    expect(readingLabel(['https://www.bbc.com/x', 'https://ar.wikipedia.org/wiki/a', 'https://www.bbc.com/y'])).toBe('قراءة بي بي سي (صفحتان) وويكيبيديا');
    expect(readingLabel(['https://britannica.test/light'])).toBe('قراءة britannica.test');
    expect(liveLabel(readingLabel(['https://ar.wikipedia.org/wiki/a', 'https://ar.wikipedia.org/wiki/b']))).toBe('يقرأ ويكيبيديا (صفحتان)');
  });

  it('names sites as people do', () => {
    expect(siteName('https://ar.wikipedia.org/wiki/x')).toBe('ويكيبيديا');
    expect(siteName('https://www.bbc.co.uk/news')).toBe('بي بي سي');
    expect(siteName('https://www.example.org/a')).toBe('example.org');
    expect(hostOf('https://www.example.org/a')).toBe('example.org');
    expect(hostOf('not a url')).toBe('not a url');
  });
});

describe('السطر الحي: نوع العمل من الكلمات', () => {
  it("classifies the server's real live texts", () => {
    const cases: [string, ReturnType<typeof activityKind>][] = [
      ['يفهم طلبك…', 'think'], ['يختار الخطوة التالية…', 'think'], ['يفكر…', 'think'], ['يتابع العمل…', 'think'], ['يرتب خطوته التالية…', 'think'],
      ['النموذج مشغول مؤقتًا؛ سأستأنف تلقائيًا خلال 20 ثانية (المحاولة 1/3)…', 'wait'],
      ['يبحث في الذاكرة…', 'memory'], ['يبحث في الذاكرة عن «مدينتي»…', 'memory'], ['يقرأ المستندات المحفوظة…', 'memory'],
      ['يبحث عن «ما عاصمة اليابان»…', 'search'], ['لم يُجب البحث الأول؛ البحث عن «الخوارزمي»…', 'search'],
      ['يقرأ ar.wikipedia.org…', 'read'], ['يقرأ britannica.com، space.com…', 'read'], ['يعيد قراءة الصفحة ويتحقق من الخطوة…', 'read'], ['يفحص الصفحة بصريًا…', 'read'],
      ['يفتح gov.uk…', 'open'], ['يفتح BBC News عربي…', 'open'], ['يفتح britannica.com في المتصفح…', 'open'],
      ['يراجع الرد…', 'write'], ['يكتب «مرحبا»…', 'write'], ['ينشئ الحملة متوقفة في Google Ads…', 'write'], ['يحفظ في الذاكرة…', 'memory'],
      ['يضغط على «dataclasses — Data Classes»…', 'act'], ['ينفذ التعديل ويتحقق من نتيجته…', 'act'], ['يسجّل الدخول…', 'act'],
    ];
    for (const [text, kind] of cases) expect(activityKind(text), text).toBe(kind);
    expect(activityKind(null)).toBe('think');
    expect(activityKind('')).toBe('think');
  });

  it('shows the time only after five seconds', () => {
    expect(elapsedLabel(4999)).toBeNull();
    expect(elapsedLabel(5000)).toBe('5 ث');
    expect(elapsedLabel(59_999)).toBe('59 ث');
    expect(elapsedLabel(65_000)).toBe('1 د 5 ث');
    expect(elapsedLabel(Number.NaN)).toBeNull();
  });
});

describe('يدا المتصفح تسجّلان ما يُقرأ', () => {
  it('records the search, then the result it reads, in that order', async () => {
    const log: string[] = [];
    const article = pageOf('https://britannica.test/speed-of-light', [], 'Speed of light, speed at which light waves propagate through different materials: 299,792,458 metres per second in a vacuum. '.repeat(4));
    const io: HandsIO = {
      page: async () => null,
      search: async () => [{ title: 'Speed of light | Britannica', url: article.url, snippet: 'The speed of light in a vacuum is 299,792 km per second.' }],
      act: async (action: AgentAction) => { log.push(`${action.kind}:${action.text ?? action.ref ?? ''}`); return article; },
      prepare: async () => null,
      settle: async page => page,
      step: async label => { log.push(`step:${label}`); },
      approve: async () => {},
      hold: async () => {},
    };
    const plan: HandsPlan = { steps: webQuestion('What is the speed of light?')!, next: 0 };
    const outcome = await runHands(plan, io);
    expect(outcome.kind).toBe('done');
    const steps = log.filter(line => line.startsWith('step:'));
    expect(steps).toContain('step:البحث عن «What is the speed of light»');
    expect(steps).toContain('step:قراءة britannica.test');
    expect(steps.indexOf('step:قراءة britannica.test')).toBeGreaterThan(steps.indexOf('step:البحث عن «What is the speed of light»'));
  });
});
