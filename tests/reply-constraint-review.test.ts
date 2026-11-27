import { describe, expect, it } from 'vitest';
import { judge } from '../apps/server/src/assistant/judge.js';
import { enforceReplyConstraints } from '../apps/server/src/assistant/reply-constraint-review.js';
import { reviewReply } from '../apps/server/src/assistant/review/checks.js';
import { buildConversationLedger } from '../apps/server/src/assistant/review/ledger.js';

describe('reply constraint enforcement', () => {
  it('keeps whole sentences, a decimal, an inline link, and the primary citation', () => {
    const draft = 'The result was 2.5. Read [the summary](https://example.com/reports/v1.2). A third sentence follows.\n\n**Source:** [Report v1.2](https://example.com/reports/v1.2)';
    const reply = enforceReplyConstraints(draft, { sentences: 2 });
    expect(reply.text).toBe('The result was 2.5. Read [the summary](https://example.com/reports/v1.2).\n\n**Source:** [Report v1.2](https://example.com/reports/v1.2)');
    expect(reply.findings).toEqual(['reply_length']);
  });

  it('recognizes Arabic sentences after periods and counts list items', () => {
    expect(enforceReplyConstraints('ذكرت النتيجة. كانت القيمة صحيحة. حسبت المجموع.', { lang: 'ar', sentences: 2 }).text)
      .toBe('ذكرت النتيجة. كانت القيمة صحيحة.');
    expect(enforceReplyConstraints('1. First.\n2. Second.\n3. Third.', { sentences: 2, list: false }).text)
      .toBe('First. Second.');
    expect(enforceReplyConstraints('First.\nSecond.', { list: true }).text).toBe('- First.\n- Second.');
  });

  it('strips link destinations and leaves inline code and JSON payloads intact', () => {
    const draft = 'Read [the report](https://example.com/r) or <https://example.com/a> and `https://example.com/b`.\n\n**Source:** https://example.com/r';
    const reply = enforceReplyConstraints(draft, { links: 0 });
    expect(reply.text).toContain('Read the report');
    expect(reply.text).toContain('`https://example.com/b`');
    expect(reply.text).not.toContain('https://example.com/r');
    expect(reply.text).not.toContain('https://example.com/a');
    const json = '{\n  "value": "Saved content."\n}';
    expect(enforceReplyConstraints(json, { lang: 'ar', sentences: 1 }).text).toBe(json);
    const jsonWithLink = JSON.stringify({ value: 'https://example.com/a' });
    const escapedLink = enforceReplyConstraints(jsonWithLink, { links: 0 });
    expect(escapedLink.text).not.toContain('https://');
    expect(JSON.parse(escapedLink.text)).toEqual(JSON.parse(jsonWithLink));
    expect(escapedLink.findings).toEqual(['reply_links']);
  });

  it('retains medical advice and a model disclosure through the sentence limit', () => {
    const draft = 'The study reports an association. This sentence gives more detail.\n\nNote: this is general information quoted from the source, not a diagnosis. For diagnosis and treatment, see a doctor.';
    expect(enforceReplyConstraints(draft, { sentences: 1 }).text)
      .toBe('The study reports an association — For diagnosis and treatment, see a doctor.');
    const model = 'It was measured. Extra detail.\n\n— Answer from the reading model v3 (experimental; F1 18% Arabic, 26% English on XQuAD)';
    expect(enforceReplyConstraints(model, { sentences: 1 }).text)
      .toBe('It was measured.\n\n— Answer from the reading model v3 (experimental; F1 18% Arabic, 26% English on XQuAD)');
  });

  it('keeps the conflicting source qualifier ahead of extra details', () => {
    const draft = 'The agency reports 25. The report also lists the prior figure.\n\n**Source:** [Agency report](https://example.com/a)\n\nA second source reports a different figure.';
    const reply = enforceReplyConstraints(draft, { sentences: 2, links: 0 });
    expect(reply.text).toBe('The agency reports 25.\n\n**Source:** Agency report\n\nA second source reports a different figure.');
  });

  it('keeps literal memory evidence inside a localized answer and withholds foreign prose', () => {
    const memory = 'من الذاكرة: «The bay code is RX-85. This is the exact note.»';
    expect(enforceReplyConstraints(memory, { lang: 'ar', sentences: 1 }).text).toBe(memory);
    const response = enforceReplyConstraints('This draft is in the wrong language.\n\n**Source:** [Report](https://example.com/r)', { lang: 'ar' });
    expect(response).toEqual({ text: 'تعذّر تقديم جواب بالعربية.\n**المصدر:** [Report](https://example.com/r)', findings: ['reply_language'], withheld: true });
  });
});

describe('constraints in judge and conversation review', () => {
  it('fixes a judge-approved answer to meet current format and length', () => {
    const reply = 'The work finished. The first check passed. A second check passed.';
    const verdict = judge({ question: 'How did the work go?', reply, constraints: { sentences: 2, list: true } });
    expect(verdict.decision).toBe('fix');
    expect(verdict.fixedReply).toBe('- The work finished. The first check passed.');
    expect(verdict.codes).toContain('reply_length');
  });

  it('checks the requested language against the reply without changing the question language', () => {
    const accepted = judge({ question: 'What happened?', reply: 'اكتمل العمل بنجاح.', constraints: { lang: 'ar' } });
    expect(accepted.lang).toBe('ar');
    expect(accepted.codes).not.toContain('language_mismatch');
    const rejected = judge({ question: 'What happened?', reply: 'The work finished.', constraints: { lang: 'ar' } });
    expect(rejected.decision).toBe('withhold');
    expect(rejected.codes).toContain('reply_language');
    expect(rejected.withholdText).toBe('تعذّر تقديم جواب بالعربية.');
  });

  it('reviews against the merged value when an earlier message says otherwise', () => {
    const ledger = buildConversationLedger([
      { role: 'user', content: 'Always answer in English.' },
      { role: 'assistant', content: 'Understood.' },
      { role: 'user', content: 'أخبرني عن حالة العمل.' },
    ]);
    const reviewed = reviewReply(ledger, 'اكتمل العمل. نجح التحقق. ثبتت النتيجة.', { constraints: { lang: 'ar', sentences: 2 } });
    expect(reviewed.reply).toBe('اكتمل العمل. نجح التحقق.');
    expect(reviewed.findings).not.toContainEqual({ check: 'preferences', code: 'reply_language' });
    expect(reviewed.findings).toContainEqual({ check: 'preferences', code: 'reply_length' });
  });
});
