import { describe, expect, it } from 'vitest';
import { deliberationReadFindings, reviewDeliberationResult, type DeliberationReviewInput } from '../apps/server/src/assistant/deliberation/review.js';
import { joinSequence, type WebSequenceAnswer } from '../apps/server/src/assistant/web-sequence.js';

const act = (request: string, reply: string, extra: Partial<DeliberationReviewInput> = {}): DeliberationReviewInput => (
  { request, reply, status: 'completed', decision: 'act', ...extra }
);

describe('deliberation post-action review', () => {
  it('checks the presented parts against the actual part outcomes', () => {
    const request = 'What is the capital of France? Then what is its population?';
    const parts: WebSequenceAnswer[] = [
      { request: 'What is the capital of France?', text: 'Paris is the capital.', status: 'completed' },
      { request: 'what is its population?', text: 'Paris has about two million inhabitants.', status: 'completed' },
    ];
    const joined = joinSequence(parts);
    expect(reviewDeliberationResult(act(request, joined.text, { parts }), true)).toMatchObject({
      text: joined.text, status: 'completed', record: { checkedParts: 2, answeredParts: 2, findings: [] },
    });
    const omitted = joinSequence(parts.slice(0, 1)).text;
    expect(reviewDeliberationResult(act(request, omitted, { parts }), true)).toMatchObject({
      text: omitted, status: 'partial', record: { checkedParts: 2, answeredParts: 1, findings: ['missing_part'] },
    });
  });

  it('requires independent evidence that a requested follow-on action happened', () => {
    const input = act('Calculate 2 + 3, then save the result in memory.', '2 + 3 = 5');
    expect(reviewDeliberationResult(input, true).record).toMatchObject({
      checkedParts: 2, answeredParts: 1, findings: ['missing_part'], revision: 'none',
    });
    const completion = { status: 'verified', allowCompletion: true, shouldBlockCompletion: false, missingCriteria: [], stagnantSteps: 0,
      criteria: [{ id: 'computed-memory-save', required: true, status: 'verified', reason: 'matched' }] } as const;
    expect(reviewDeliberationResult({ ...input, completion: { ...completion, criteria: [...completion.criteria], missingCriteria: [] } }, true).record).toMatchObject({
      checkedParts: 2, answeredParts: 2, findings: [],
    });
  });

  it('detects a sourced answer about the wrong entity and preserves the legacy reply in shadow', () => {
    const request = 'What is the capital of Japan?';
    const text = 'Paris is the capital and largest city of France.';
    const url = 'https://en.wikipedia.org/wiki/Paris';
    const reply = `${text}\n\n**Source:** [Wikipedia — Paris](${url})`;
    const input = act(request, reply, { reading: { request, scope: 'public', entity: 'Japan' }, evidence: [{ kind: 'page', title: 'Paris', url, text }] });
    expect(deliberationReadFindings(input)).toContain('wrong_entity');
    expect(reviewDeliberationResult(input, false)).toMatchObject({ text: reply, status: 'completed', record: { findings: ['wrong_entity'] } });
    const enabled = reviewDeliberationResult(input, true);
    expect(enabled.status).toBe('partial');
    expect(enabled.text).not.toContain('Paris');
    expect(JSON.stringify(enabled.record)).not.toMatch(/Japan|Paris|https:/u);
  });

  it('uses the existing shortening tool once and rechecks the exact result', () => {
    const request = 'What is the capital of Japan? Answer in one short English sentence.';
    const reply = 'Tokyo is the capital of Japan. It is also the largest city in Japan.';
    const input = act(request, reply);
    expect(reviewDeliberationResult(input, true)).toMatchObject({ text: 'Tokyo is the capital of Japan.', status: 'completed',
      record: { revision: 'format', initialFindings: ['format_sentences'], findings: [] } });
    expect(reviewDeliberationResult({ ...input, readRevision: ['unverified_part'] }, true)).toMatchObject({ text: reply, status: 'partial',
      record: { revision: 'read', initialFindings: ['unverified_part'], findings: ['format_sentences'] } });
    expect(reviewDeliberationResult({ ...input, protectedReply: true }, true)).toMatchObject({ text: reply, status: 'partial',
      record: { revision: 'none', findings: ['format_sentences'] } });
  });

  it('checks explicit language, source fields, and JSON shape', () => {
    const arabic = act('Calculate 37 × 24 and reply with the result in one short Arabic sentence.', 'It is 888.');
    expect(reviewDeliberationResult(arabic, true).record.findings).toContain('format_language');
    const fields = act('Search the web for the official IANA documentation about example domains. Return the page title and source link.', 'Example domains.');
    expect(reviewDeliberationResult(fields, true).record.findings).toContain('format_fields');
    const inventory = 'Show the coding project as a JSON object with name and id.';
    const object = '{"name":"Example","id":"id"}';
    expect(reviewDeliberationResult(act(inventory, `\`\`\`json\n${object}\n\`\`\``), true)).toMatchObject({
      text: object, status: 'completed', record: { revision: 'format', findings: [] },
    });
    expect(reviewDeliberationResult(act(inventory, `[${object}]`), true)).toMatchObject({
      status: 'partial', record: { revision: 'none', findings: ['format_json'] },
    });
  });

  it('checks a clarification has one question and does not claim completion', () => {
    const request = 'What is its population?';
    const input = act(request, 'Which place do you mean?', { decision: 'ask', status: 'blocked' });
    expect(reviewDeliberationResult(input, true).record).toMatchObject({ checkedParts: 0, findings: [] });
    expect(reviewDeliberationResult({ ...input, reply: 'Which place? Which year?' }, true).record.findings).toEqual(['decision_mismatch']);
    expect(reviewDeliberationResult({ ...input, decision: 'abstain', status: 'completed' }, true).record.findings).toEqual(['decision_mismatch']);
  });
});
