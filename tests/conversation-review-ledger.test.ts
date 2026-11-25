import { describe, expect, it } from 'vitest';
import {
  buildConversationLedger, buildConversationSummary, extractClaims, extractCommitments, extractPreferences,
  splitRequest, SUMMARY_MAX_BYTES, type ConversationSummary, type ReviewMessage,
} from '../apps/server/src/assistant/review/ledger.js';

function conversation(...lines: string[]): ReviewMessage[] {
  return lines.map((content, index) => ({ id: 'turn-' + index, role: index % 2 ? 'assistant' : 'user', content }));
}

describe('conversation review ledger', () => {
  it('extracts coordinated fields in both languages and preserves literal input', () => {
    expect(splitRequest('Give me the location and opening hours.').map(part => part.text)).toEqual([
      'Give me the location', 'opening hours.',
    ]);
    expect(splitRequest('اذكر الموقع وموعد الافتتاح.').map(part => part.text)).toEqual(['اذكر الموقع', 'موعد الافتتاح.']);
    expect(splitRequest('Translate “Name and address”').map(part => part.text)).toEqual(['Translate “Name and address”']);
    expect(splitRequest('List these fields:\n1. Reason\n2. Duration').map(part => part.text)).toEqual(['Reason', 'Duration']);
  });

  it('keeps updated user evidence apart from requests and ignores questions and quotes as assertions', () => {
    const ledger = buildConversationLedger(conversation(
      'What is the opening date?', 'Opening date: 2027-03-01.',
      'The opening date is 2027-04-01. What is the current opening date?',
    ));
    expect(ledger.requests.at(-1)).toEqual({ text: 'What is the current opening date?', messageIndex: 2 });
    expect(ledger.claims).toMatchObject([{ kind: 'date', subject: 'opening date', value: '2027-03-01', messageIndex: 1 }]);
    expect(ledger.userClaims).toMatchObject([{ kind: 'date', subject: 'opening date', value: '2027-04-01', messageIndex: 2 }]);
    expect(extractClaims('The budget is 50? التكلفة هي ٥٠؟\n> The budget is 70.\nCost: ٣٠ دولار.')).toMatchObject([
      { subject: 'cost', value: '٣٠ دولار', kind: 'number' },
    ]);
  });

  it('retains only unresolved commitments and preserves their originating text', () => {
    const ledger = buildConversationLedger(conversation(
      'Check the report.', 'I will send the report. سأضيف النقاط.',
      'Please share your progress.', 'I sent the report. لم أضف النقاط.',
      'ما الخطوة التالية؟',
    ));
    expect(ledger.commitments).toMatchObject([{ text: 'سأضيف النقاط', action: 'أضيف النقاط', messageIndex: 1 }]);
    expect(extractCommitments('If you approve, I will mail the report. سارة هي المديرة.')).toEqual([]);
  });

  it('retains the specific rejected answer and bilingual correction as evidence', () => {
    const ledger = buildConversationLedger(conversation(
      'Tell me about the printers.', 'Here are scanner options.',
      "That doesn't work for me. I asked about printers, not scanners.", 'The printer desk is upstairs.',
      'لا، قصدت الدعم الهاتفي وليس المكتب.',
    ));
    expect(ledger.rejectedAnswers.map(item => item.answerIndex)).toEqual([1, 3]);
    expect(ledger.corrections).toMatchObject([
      { before: 'scanners', after: 'printers', messageIndex: 2 },
      { before: 'المكتب', after: 'الدعم الهاتفي', messageIndex: 4 },
    ]);
    expect(ledger.requests.filter(item => item.messageIndex === 4)).toEqual([]);
  });

  it('carries exact name spellings and keeps explicit preferences out of content coverage', () => {
    const ledger = buildConversationLedger(conversation(
      'اسمي احمد.', 'أهلًا يا احمد.', 'اسمي يُكتب أحمد. أجبني بالعربية دائمًا.',
      'أهلاً يا أحمد.', 'Answer in one sentence. What is the closing time?',
    ));
    expect(ledger.preferences).toMatchObject([
      { kind: 'name', value: 'أحمد', alias: 'احمد' },
      { kind: 'language', value: 'ar' },
      { kind: 'length', value: '1', limit: 'sentences' },
    ]);
    expect(ledger.requests).toEqual([{ text: 'What is the closing time?', messageIndex: 4 }]);
    expect(extractPreferences('Please avoid the phrase “good to know” in every reply.')).toMatchObject([
      { kind: 'avoid', value: 'good to know' },
    ]);
    expect(extractPreferences('استخدم الكيلومترات للمسافة. لا تتجاوز ٥ كلمات.')).toMatchObject([
      { kind: 'units', value: 'km' }, { kind: 'length', value: '5', limit: 'words' },
    ]);
  });
});

describe('conversation review running summary', () => {
  it('keeps open requests after deferral, advances on the final reply, and refuses a stale cursor', () => {
    const initial = conversation(
      'My name is Noa.', 'Project decision: keep existing dates.',
      'Provide the budget and opening hours.', 'Budget: 500 dollars. Opening hours are not yet available. I will share the opening hours.',
    );
    const summary = buildConversationSummary(buildConversationLedger(initial));
    expect(summary).toMatchObject({
      messageCount: 4, throughMessageId: 'turn-3',
      decisions: [{ subject: 'project decision', value: 'keep existing dates' }],
      openRequests: [{ text: 'opening hours.' }],
      commitments: [{ action: 'share the opening hours' }],
      preferences: [{ kind: 'name', value: 'Noa' }],
    });
    const messages = [...initial, { role: 'user', content: 'Do we have opening hours yet?', id: 'turn-4' }] satisfies ReviewMessage[];
    const ledger = buildConversationLedger(messages, summary);
    expect(ledger.summary).toEqual(summary);
    const published = { role: 'assistant', content: 'Opening hours: 9–5.', id: 'turn-5' } satisfies ReviewMessage;
    const next = buildConversationSummary(ledger, published);
    expect(next).toMatchObject({ messageCount: 6, throughMessageId: 'turn-5', commitments: [] });
    expect(next.openRequests.map(item => item.text)).not.toContain('opening hours.');
    expect(buildConversationLedger(messages, { ...summary, throughMessageId: 'another-thread' }).summary).toBeUndefined();
    expect(buildConversationLedger(messages, { ...summary, openRequests: null } as unknown as ConversationSummary).summary).toBeUndefined();
  });

  it('bounds non-ASCII summary data in bytes and retains source excerpts without rewriting', () => {
    const ledger = buildConversationLedger(conversation(...Array.from({ length: 100 }, (_, index) => index % 2
      ? 'قرار القسم ' + index + ': ' + 'المراجعة '.repeat(27)
      : 'اذكر الميزانية ' + 'والعناصر '.repeat(28) + index)));
    const summary = buildConversationSummary(ledger);
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
    for (const record of [...summary.decisions, ...summary.openRequests]) {
      expect(ledger.messages[record.messageIndex]?.content).toContain(record.text);
    }
  });
});
