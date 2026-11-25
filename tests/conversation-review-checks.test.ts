import { describe, expect, it } from 'vitest';
import { reviewReply } from '../apps/server/src/assistant/review/checks.js';
import { buildConversationLedger, buildConversationSummary, type ReviewMessage } from '../apps/server/src/assistant/review/ledger.js';

function history(...turns: string[]): ReviewMessage[] {
  return turns.map((content, index) => ({ id: String(index), role: index % 2 ? 'assistant' : 'user', content }));
}

const issue = (result: ReturnType<typeof reviewReply>, check: string, code?: string) =>
  result.findings.some(finding => finding.check === check && (!code || finding.code === code));

describe('conversation review checks and actions', () => {
  it('reports an unexplained same-field conflict, without asserting which old fact is right', () => {
    const ledger = buildConversationLedger(history('What is the cost?', 'The cost is $120.', 'What is the cost now?'));
    const result = reviewReply(ledger, 'The cost is $150.');
    expect(issue(result, 'contradiction')).toBe(true);
    expect(result.action).toBe('note');
    expect(result.reply).toContain('I could not verify the change');
    expect(result.reply).not.toContain('$120');
    expect(issue(reviewReply(ledger, 'The cost is $120.0.'), 'contradiction')).toBe(false);
    expect(issue(reviewReply(ledger, 'The cost is $150?', { status: 'waiting_user' }), 'contradiction')).toBe(false);
  });

  it('requires newer subject-matched evidence to explain a change', () => {
    const ledger = buildConversationLedger(history('ما الموعد؟', 'الموعد هو الثلاثاء.', 'الموعد هو الأربعاء. ما الموعد الجديد؟'));
    const draft = 'الموعد هو الأربعاء.';
    expect(issue(reviewReply(ledger, draft), 'contradiction')).toBe(false);
    const unrelated = buildConversationLedger(history('ما الموعد؟', 'الموعد هو الثلاثاء.', 'موعد التدريب هو الأربعاء. وما الموعد الجديد؟'));
    expect(issue(reviewReply(unrelated, draft), 'contradiction')).toBe(true);
    expect(issue(reviewReply(unrelated, draft, { evidence: [{ text: 'الموعد هو الأربعاء.' }] }), 'contradiction')).toBe(false);
  });

  it('requires scoped answers or explicit deferrals for each part', () => {
    const ledger = buildConversationLedger(history('Where is the office?', 'The office is on Maple Street.',
      'What is the street address? What is the contact number?'));
    const partial = reviewReply(ledger, 'Street address: 7 Maple Street.');
    expect(issue(partial, 'coverage')).toBe(true);
    expect(partial.reply).toContain('contact number');
    expect(issue(reviewReply(ledger, 'Street address: 7 Maple Street. The contact number is unavailable.'), 'coverage')).toBe(false);
    expect(issue(reviewReply(ledger, 'Street address: 7 Maple Street. Contact number.'), 'coverage')).toBe(true);
  });

  it('repairs a missing exact field using an earlier user statement with attribution', () => {
    const ledger = buildConversationLedger(history('The venue address is Pine Street.', 'I noted that address.',
      'What is the venue address? What is the contact number?'));
    const result = reviewReply(ledger, 'Contact number: 555-0123.');
    expect(result.action).toBe('fix');
    expect(result.reply).toBe('Contact number: 555-0123.\n\nYou previously said: The venue address is Pine Street.');
    expect(issue(result, 'coverage')).toBe(true);
    expect(reviewReply(ledger, 'Contact number: 555-0123.', { preserveContent: true }).action).toBe('note');
  });

  it('reports a promise missed by the new reply without marking it delivered', () => {
    const ledger = buildConversationLedger(history('Can you finish the plan?', 'I will send the draft next.',
      'What is the event topic?'));
    expect(issue(reviewReply(ledger, 'The event topic is science.'), 'commitments')).toBe(true);
    expect(issue(reviewReply(ledger, 'The event topic is science. I have not sent the draft yet.'), 'commitments')).toBe(false);
    expect(issue(reviewReply(ledger, 'The event topic is science. I sent the draft.'), 'commitments')).toBe(false);
    expect(issue(reviewReply(ledger, 'The event topic is science. I will send the draft.'), 'commitments')).toBe(true);
  });

  it('repairs a corrected value only for the matching earlier assertion', () => {
    const ledger = buildConversationLedger(history('What is the seat number?', 'Seat number: 14.', 'No, I meant 16, not 14.'));
    const repaired = reviewReply(ledger, 'Seat number: 14. Row number: 14.');
    expect(issue(repaired, 'corrections')).toBe(true);
    expect(repaired.reply).toBe('Seat number: 16. Row number: 14.');
    const protectedDraft = 'Seat number: 14. Row number: 14.';
    expect(reviewReply(ledger, protectedDraft, { preserveContent: true }).reply.startsWith(protectedDraft)).toBe(true);
    expect(issue(reviewReply(ledger, 'Row number: 14.'), 'corrections')).toBe(false);
    const ambiguous = buildConversationLedger(history('Which row and seat?', protectedDraft, 'No, I meant 16, not 14.'));
    const uncertain = reviewReply(ambiguous, 'Row number: 14. Adjacent seats are available.');
    expect(issue(uncertain, 'corrections')).toBe(true);
    expect(uncertain.reply).not.toContain('Row number: 16');
  });

  it('uses the exact latest spelling whenever addressing the user', () => {
    const ledger = buildConversationLedger(history('My name is Siobhan, not Shivawn.', 'Understood.', 'Please greet me.'));
    const result = reviewReply(ledger, 'Hello, Shivawn! I saved this for you, Shivawn. Shivawn is the contact listed in the sample.');
    expect(result.action).toBe('fix');
    expect(result.reply).toBe('Hello, Siobhan! I saved this for you, Siobhan. Shivawn is the contact listed in the sample.');
    const ar = buildConversationLedger(history('اسمي يُكتب أحمد وليس احمد.', 'فهمت.', 'سلّم عليّ.'));
    expect(reviewReply(ar, 'مرحبًا يا احمد!').reply).toBe('مرحبًا يا أحمد!');
  });

  it('flags language, length, format, units, and things the user explicitly avoids', () => {
    const examples: Array<[string, string, string]> = [
      ['Always reply in English.', 'أهلاً وسهلاً!', 'reply_language'],
      ['Answer in one sentence.', 'Welcome. I hope you have a good day.', 'reply_length'],
      ['Use bullet points.', 'Welcome to the office.', 'reply_format'],
      ['Use metric units.', 'The office is five blocks away, about 2 miles.', 'reply_units'],
      ['Avoid emojis.', 'Welcome! 😊', 'avoided_content'],
    ];
    for (const [preference, draft, code] of examples) {
      const ledger = buildConversationLedger(history(preference, 'Understood.', 'Say hello to the visitor.'));
      expect(issue(reviewReply(ledger, draft), 'preferences', code), preference).toBe(true);
    }
  });

  it('retains JSON format for a note and preserves an exact sentence limit when no safe note fits', () => {
    const json = buildConversationLedger(history('Use JSON.', 'I will send the draft.', 'What is the status?'));
    const result = reviewReply(json, '{"status":"waiting"}');
    expect(issue(result, 'commitments')).toBe(true);
    expect(JSON.parse(result.reply)).toMatchObject({ status: 'waiting', conversationReview: expect.any(String) });
    expect(reviewReply(json, '{"status":"waiting"}', { preserveContent: true }).reply).toBe('{"status":"waiting"}');
    const limit = buildConversationLedger(history('Answer in one sentence.', 'I will send the draft.', 'What is the status?'));
    expect(reviewReply(limit, 'The plan is ready.').reply).toBe('The plan is ready.');
  });

  it('does not send a rejected answer again even when punctuation changes', () => {
    const ledger = buildConversationLedger(history('Suggest a plan.', 'Use a sign-up sheet. Put it by the gate.',
      "That's wrong. Please offer another plan."));
    const result = reviewReply(ledger, 'Use a sign-up sheet\nPut it by the gate!');
    expect(issue(result, 'repetition')).toBe(true);
    expect(result.reply).not.toContain('Put it by the gate');
    expect(issue(reviewReply(ledger, 'Assign volunteers to meet visitors.'), 'repetition')).toBe(false);
  });

  it('uses a stored open item on an explicit continuation', () => {
    const messages = history('What is the venue address? What is the contact number?', 'Venue address: Pine Street.');
    const summary = buildConversationSummary(buildConversationLedger(messages));
    const continued = buildConversationLedger([...messages, { role: 'user', content: 'Please continue.' }], summary);
    const result = reviewReply(continued, 'The weather is sunny.');
    expect(issue(result, 'coverage')).toBe(true);
    expect(result.reply).toContain('contact number');
  });
});
