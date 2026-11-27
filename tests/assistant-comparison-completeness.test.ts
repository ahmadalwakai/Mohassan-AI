import { describe, expect, it } from 'vitest';
import { checkComparisonCompleteness } from '../apps/server/src/assistant/comparison-completeness.js';
import { parseComparisonQuestion } from '../apps/server/src/assistant/comparison-question.js';
import { judge, type JudgeEvidence } from '../apps/server/src/assistant/judge.js';

const en = 'Is Python faster than Java?';
const ar = 'هل Python أسرع من Java؟';
const source = 'https://comparison.example/observations';
const page = (text: string, url = source): JudgeEvidence => ({ kind: 'page', text, url });
const check = (question: string, reply: string, texts: string[]) =>
  checkComparisonCompleteness(parseComparisonQuestion(question)!, reply, texts.map(text => ({ text })));
const withSource = (lang: 'ar' | 'en', text: string) => `${text}\n\n**${lang === 'ar' ? 'المصدر' : 'Source'}:** [Observations](${source})`;

// Hypothetical observations generated from the requested subject pair and scenario names.
// These fixtures make no factual claims about programming-language benchmarks or real prices.
const pair = ['Python', 'Java'] as const;
const small = `For the small input, ${pair[0]} was faster than ${pair[1]}.`;
const large = `For the large input, ${pair[1]} was faster than ${pair[0]}.`;
const smallAr = `عند استخدام مدخلات صغيرة كان ${pair[0]} أسرع من ${pair[1]}.`;
const largeAr = `عند استخدام مدخلات كبيرة كان ${pair[1]} أسرع من ${pair[0]}.`;

for (const [lang, question, short, long, single] of [
  ['en', en, small, large, `For the small input, ${pair[0]} ran in 15 ms.`],
  ['ar', ar, smallAr, largeAr, `عند استخدام مدخلات صغيرة كانت سرعة ${pair[0]} عالية.`],
] as const) {
  describe(`comparison evidence in ${lang}`, () => {
    it('requires the second side even if the first page is on topic', () => {
      expect(check(question, single, [single])).toMatchObject({ complete: false, missingEvidenceSubjects: ['Java'] });
      const verdict = judge({ question, reply: withSource(lang, single), evidence: [page(single)], status: 'completed' });
      expect(verdict).toMatchObject({ decision: 'withhold', kind: 'answer' });
      expect(verdict.codes).toContain('comparison_incomplete');
      expect(verdict.withholdText).toMatch(lang === 'ar' ? /^إجابة جزئية: لم أجد مصدراً يقارن/u : /^Partial answer:/u);
    });

    it('accepts passages that give the comparison and each condition supported by the evidence', () => {
      const reply = `${short}\n${long}`;
      expect(check(question, reply, [short, long]).complete).toBe(true);
      expect(judge({ question, reply: withSource(lang, reply), evidence: [page(reply)] })).toMatchObject({ decision: 'send' });
      expect(check(question, short, [short, long])).toMatchObject({ complete: false, missingConditions: true });
    });

    it('requires the compared attribute in the reply and in the evidence', () => {
      const unrelated = lang === 'ar' ? `${pair[0]} و${pair[1]} لغتا برمجة.` : `${pair[0]} and ${pair[1]} are programming languages.`;
      expect(check(question, unrelated, [short])).toMatchObject({ complete: false, missingAttribute: true });
      expect(check(question, short, [unrelated])).toMatchObject({ complete: false, missingAttribute: true });
    });
  });
}

describe('comparison completeness', () => {
  it('allows separate observations for both subjects on the same criterion', () => {
    const left = `${pair[0]} ran in 15 ms on shared test hardware.`;
    const right = `${pair[1]} ran in 12 ms on shared test hardware.`;
    expect(check(en, `${left}\n${right}`, [left, right]).complete).toBe(true);
  });

  it('carries a separate evidence sentence that explains when the finding applies', () => {
    const comparison = 'Python was faster than Java.';
    const condition = 'Results vary by input size and runtime.';
    expect(check(en, `${comparison} ${condition}`, [`${comparison} ${condition}`]).complete).toBe(true);
    expect(check(en, comparison, [`${comparison} ${condition}`])).toMatchObject({ complete: false, missingConditions: true });
    expect(check(en, comparison, [comparison])).toMatchObject({ complete: false, missingConditions: true });
  });

  it('requires the price periods supported by the evidence', () => {
    const question = 'Is Plan A cheaper than Plan B?';
    const earlier = 'In the trial month, Plan A costs less than Plan B.';
    const later = 'After the trial month, Plan B costs less than Plan A.';
    expect(check(question, `${earlier}\n${later}`, [earlier, later]).complete).toBe(true);
    expect(check(question, earlier, [earlier, later])).toMatchObject({ complete: false, missingConditions: true });
  });

  it('requires conditions for an inferred performance criterion and a shared criterion for an open comparison', () => {
    const question = 'Python versus Java';
    const content = 'Python is faster than Java.';
    expect(check(question, content, [content])).toMatchObject({ complete: false, missingConditions: true });
    expect(check(question, 'Python is easier than Java.', [small])).toMatchObject({ complete: false, missingAttribute: true });
  });

  it('keeps sources, links and question echoes out of ordinary answer coverage', () => {
    const comparison = parseComparisonQuestion(en)!;
    const pythonOnly = `For the small input, ${pair[0]} ran in 15 ms.`;
    expect(checkComparisonCompleteness(comparison, withSource('en', pythonOnly), [
      { text: pythonOnly, title: 'Python versus Java speed', url: source },
      { text: small, url: 'https://comparison.example/uncited' },
    ])).toMatchObject({ complete: false, missingEvidenceSubjects: ['Java'], missingReplySubjects: ['Java'] });
    const echo = `Question: ${en} | Answer: ${pair[0]}`;
    expect(check(en, echo, [echo]).complete).toBe(false);
  });

  it('uses the source’s explicit choice on an exact question about a stable attribute', () => {
    const [left, right] = ['Test Container A', 'Test Container B'];
    const question = `Which is larger: ${left} or ${right}?`;
    const record = `Question: ${question} | Answer: ${left}`;
    expect(check(question, record, [record]).complete).toBe(true);
    expect(check(question, left, [record]).complete).toBe(false);
    expect(check(question.replace('larger', 'smaller'), record, [record]).complete).toBe(false);
  });

  it('recognises the host’s partial reply without a second judge replacement', () => {
    const reply = withSource('ar', 'إجابة جزئية: لم أجد مصدراً يقارن «Python» و«Java».');
    expect(judge({ question: ar, reply, status: 'partial' })).toMatchObject({ decision: 'send', kind: 'abstain', withholdText: null });
  });

  it('leaves normal single-subject judge checks in place', () => {
    const question = 'What is Python?';
    const content = 'Python is a programming language.';
    expect(judge({ question, reply: withSource('en', content), evidence: [page(content)] })).toMatchObject({ decision: 'send', codes: [] });
  });
});
