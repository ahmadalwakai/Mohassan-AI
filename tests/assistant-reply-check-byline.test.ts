import { describe, expect, it } from 'vitest';
import { judge } from '../apps/server/src/assistant/judge.js';
import { applyReplyFixes, checkReply } from '../apps/server/src/assistant/reply-check.js';

// Regression: the byline rules of reply-check.ts read sentence openings as bylines, and the fix cut them. Live on 2026-11-22
// (06:39–07:16, the owner's account with the judge's fix on) «كتبت 14 حرفًا في نافذة المفكرة.» reached the owner as «14 حرفًا في
// نافذة المفكرة.»; the browser-hands reply of hands.ts («كتبت «…» في …») lost its verb the same way. The same rules cut «تحرير»
// from «تحرير الكويت …», «نُشر في» from «نُشر في 24 نوفمبر 1859 كتاب …» and «By the end of 1900» from an English answer.
const bylines = (question: string, reply: string) => checkReply({ question, reply }).findings.filter(finding => finding.code === 'byline_lead');
const AR_SOURCE = (title: string) => `\n\n**المصدر:** [ويكيبيديا — ${title}](https://ar.wikipedia.org/wiki/x)`;
const EN_SOURCE = (title: string) => `\n\n**Source:** [Wikipedia — ${title}](https://en.wikipedia.org/wiki/x)`;

/** Replies that open with the verb, and the request behind each. */
const VERB_REPLIES: [question: string, reply: string][] = [
  // hands.ts, the browser «type» step: `كتبت «${text}» في ${where}. قل «اضغط على …» لأتابع.`, where = **page title** (host).
  ['اكتب مرحبا في حقل البحث', 'كتبت «مرحبا» في **Google** (www.google.com). قل «اضغط على …» لأتابع.'],
  // The three desktop replies the judge cut live on 2026-11-22 (.data/judge/shadow.jsonl).
  ['اكتب مرحبا من موحسن في المفكرة', 'كتبت 14 حرفًا في نافذة المفكرة.'],
  ['اكتب مرحبا من موحسن في المفكرة', 'كتبت 14 حرفًا في «Untitled - Notepad».'],
  ['اكتب مرحبا من موحسن في المفكرة', 'كتبت 14 حرفًا في «ملاحظات.txt - Notepad» وتحققت أنها ظهرت كما هي.'],
  // The computer-use reference answer of packages/learning/src/evaluation.ts.
  ['اكتب مسودة المكتب', 'كتبت مسودة المكتب.'],
  ['اكتب hello في الحقل', 'كتبت "hello" في الحقل.'],
  ['اكتب ثلاثة أسطر في الملف', 'كتب 3 أسطر في الملف.'],
];

/** Page sentences that open with a word a byline or dateline also opens with. */
const PAGE_SENTENCES: [question: string, reply: string][] = [
  ['من كتب رواية الحرافيش؟', `كتب نجيب محفوظ رواية الحرافيش ونُشرت عام 1977.${AR_SOURCE('الحرافيش')}`],
  ['متى تم تحرير الكويت؟', `تحرير الكويت تم في 26 فبراير 1991 بعد حرب الخليج.${AR_SOURCE('تحرير الكويت')}`],
  ['متى نُشر كتاب أصل الأنواع؟', `نُشر في 24 نوفمبر 1859 كتاب أصل الأنواع لتشارلز داروين.${AR_SOURCE('أصل الأنواع')}`],
  ['متى نُشر كتاب أصل الأنواع؟', `نشر في عام 1859 كتاب أصل الأنواع لتشارلز داروين.${AR_SOURCE('أصل الأنواع')}`],
  ['What was the population of the city in 1900?', `By the end of 1900, the city had grown to 400,000 people.${EN_SOURCE('City')}`],
  ['What is the population of Tokyo?', `By January 2025, the population of Tokyo was 14 million.${EN_SOURCE('Tokyo')}`],
  ['How big is Mars?', `By contrast, Mars is about half the size of Earth.${EN_SOURCE('Mars')}`],
  ['Which port does the server use?', 'By default, the server listens on port 3000.'],
  ['When were the shops full?', 'By Christmas, the shops were full.'],
  ['When will it open?', 'By Monday morning the bridge will reopen.'],
];

describe('the byline rules leave sentences alone', () => {
  it('reads no byline in «كتبت …» replies, so the fixes return them as they are', () => {
    for (const [question, reply] of VERB_REPLIES) {
      expect(bylines(question, reply), reply).toEqual([]);
      expect(applyReplyFixes({ question, reply }), reply).toBe(reply);
    }
  });

  it('lets the judge send «كتبت …» replies unchanged, the browser-hands reply included', () => {
    for (const [question, reply] of VERB_REPLIES) {
      const verdict = judge({ question, reply, status: 'completed' });
      expect(verdict.codes, reply).not.toContain('byline_lead');
      expect(verdict.decision, reply).toBe('send');
      expect(verdict.fixedReply, reply).toBeNull();
    }
  });

  it('reads no byline in a page sentence that opens with «كتب», «تحرير», «نُشر في» or «By», and the judge does not rewrite it', () => {
    for (const [question, reply] of PAGE_SENTENCES) {
      expect(bylines(question, reply), reply).toEqual([]);
      expect(applyReplyFixes({ question, reply }), reply).toBe(reply);
      const verdict = judge({ question, reply });
      expect(verdict.codes, reply).not.toContain('byline_lead');
      expect(verdict.fixedReply, reply).toBeNull();
    }
  });

  it('keeps «By January 2025, …» when a dateline later in the line flags it', () => {
    const reply = 'By January 2025, the city had grown to 14 million people, according to the census published on March 3, 2025.';
    expect(applyReplyFixes({ question: 'What is the population of the city?', reply })).toMatch(/^By January 2025, the city had grown to 14 million people/u);
  });
});

describe('a real byline is still cut', () => {
  const question = 'ما آخر أخبار وزارة الصحة؟';
  const answer = 'أعلنت وزارة الصحة اليوم عن حملة تطعيم جديدة تبدأ الأسبوع المقبل.';

  it('flags «كتب», «كتبت», «كتبه» and «تحرير» before a colon or a dash, and the fix takes the mark with its colon or dash', () => {
    // The mark goes and the name stays, as before: nothing in Arabic script marks where a name ends. Before 2026-11-22 a dash or
    // a spaced colon stayed behind («- سارة أحمد» read as a list item, «: محمد علي»).
    const cases: [reply: string, fixed: string][] = [
      ['كتب: محمد علي', 'محمد علي'],
      ['كتب:محمد علي', 'محمد علي'],
      ['كتب : محمد علي', 'محمد علي'],
      ['كتبت - سارة أحمد', 'سارة أحمد'],
      ['كتبه – أحمد خالد', 'أحمد خالد'],
      ['كتب — محمد علي', 'محمد علي'],
      ['تحرير: سارة أحمد', 'سارة أحمد'],
      ['تحرير - فريق الموقع', 'فريق الموقع'],
    ];
    for (const [reply, fixed] of cases) {
      expect(bylines(question, reply), reply).toMatchObject([{ line: 1, severity: 'fix' }]);
      expect(applyReplyFixes({ question, reply }), reply).toBe(fixed);
    }
  });

  it('flags «نُشر في» before a colon or a dash, or before a date that ends the line, and the date goes with it', () => {
    for (const dateline of ['نُشر في 22 نوفمبر 2026', 'نشر في 22 نوفمبر 2026', 'نشر في الأحد، 22 نوفمبر/تشرين الثاني 2026 - 07:00 ص', 'نُشر في 22/11/2026', 'نُشر في ٢٢ نوفمبر ٢٠٢٦', 'نُشر في: 22 نوفمبر 2026']) {
      const reply = `${dateline}\n${answer}`;
      expect(bylines(question, reply), dateline).toMatchObject([{ line: 1, severity: 'fix' }]);
      expect(applyReplyFixes({ question, reply }), dateline).toBe(answer);
    }
    expect(applyReplyFixes({ question, reply: `نشر في: 22 نوفمبر 2026 ${answer}` })).toBe(answer);
  });

  it('still flags the other marks, with or without a colon', () => {
    for (const reply of ['بقلم: محمد علي', 'بقلم محمد علي', 'آخر تحديث: 22 نوفمبر 2026', 'تاريخ النشر: 22 نوفمبر 2026', 'المصدر الأصلي: رويترز']) {
      expect(bylines(question, reply), reply).toMatchObject([{ line: 1, severity: 'fix' }]);
    }
  });

  it('cuts an English byline whose name is in capitals, with the separator after it', () => {
    const body = 'The company said on Monday that sales rose.';
    for (const byline of ['By Vicky Stein', 'BY VICKY STEIN', 'Written by Jane Doe', 'By Reuters', 'By The Associated Press']) {
      const reply = `${byline}\n${body}`;
      expect(bylines('What did the company say?', reply), byline).toMatchObject([{ line: 1, severity: 'fix' }]);
      expect(applyReplyFixes({ question: 'What did the company say?', reply }), byline).toBe(body);
    }
    expect(applyReplyFixes({ question: 'What did the company say?', reply: `By AFP | ${body}` })).toBe(body);
  });

  it('lets the judge cut «كتب:» from a quoted page', () => {
    const reply = [`كتب: محمد علي ${answer}`, '', '**المصدر:** [أخبار — حملة تطعيم جديدة](https://news.example/1)'].join('\n');
    const verdict = judge({ question, reply });
    expect(verdict.codes).toContain('byline_lead');
    expect(verdict.decision).toBe('fix');
    expect(verdict.fixedReply?.split('\n')[0]).toBe(`محمد علي ${answer}`);
  });
});
