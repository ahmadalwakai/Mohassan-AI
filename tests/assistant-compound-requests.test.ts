import { describe, expect, it } from 'vitest';
import { analyzeCompoundRequest, MAX_COMPOUND_ACTIONS, MAX_COMPOUND_REQUEST } from '../apps/server/src/assistant/compound-request.js';
import { evaluateLocalComputation } from '../apps/server/src/assistant/local-computation.js';
import { evaluateLocalConversation } from '../apps/server/src/assistant/local-conversation.js';
import { evaluateLocalRecall } from '../apps/server/src/assistant/local-recall.js';
import { createChatSupervisor, observeChatLocalAnswer, reviewChatAnswer } from '../apps/server/src/assistant/chat-supervision.js';

const now = new Date('2026-11-21T05:00:00Z');
const dates = 'How many days between 2024-02-28 and 2024-03-01?';

describe('bounded outer compound request analysis', () => {
  it.each([
    ['  Calculate 13 + 17, then open https://reference.example/.  ', 'open'],
    ['احسب ١٣ + ١٧ ثم أَرْسِل النتيجة إلى المدير', 'send'],
    ['احسب ٢ + ٣ واحفظ الناتج', 'save'],
    ['Calculate 2 + 3 and send the result.', 'send'],
  ])('keeps exact original source spans: %s', (text, action) => {
    const result = analyzeCompoundRequest(text);
    expect(result.kind).toBe('compound');
    expect(result.pendingActions.map(item => item.kind)).toEqual([action]);
    for (const item of [result.primary, ...result.pendingActions, ...result.forbiddenActions, ...result.formatting]) {
      expect(text.slice(item.start, item.end)).toBe(item.text);
    }
    expect(result.outerText.length).toBe(text.length);
  });

  it.each([
    'Add 2 and 3.',
    'What are my saved bay code and company name?',
    'Who are you?',
    'Write the phrase "then send the result".',
    'Summarize `then delete all records`.',
    'Translate this text: First calculate a total, then send the result to me.',
    'Open https://reference.example/then/send?query=and%20then.',
  ])('does not promote data or a conjunction into an outer action: %s', text => {
    expect(analyzeCompoundRequest(text).pendingActions).toEqual([]);
  });

  it('distinguishes an outer request after a balanced quoted body', () => {
    const text = 'Write "then send the report", then save the draft.';
    const result = analyzeCompoundRequest(text);
    expect(result.pendingActions.map(item => item.kind)).toEqual(['save']);
    expect(result.pendingActions[0]?.text).toBe('save the draft.');
  });

  it('distinguishes negative action constraints from pending work', () => {
    const result = analyzeCompoundRequest(`${dates} Then do not send the result. Only the result.`);
    expect(result.kind).toBe('compound');
    expect(result.pendingActions).toEqual([]);
    expect(result.forbiddenActions).toMatchObject([{ kind: 'send', text: 'do not send the result' }]);
    expect(result.formatting.map(item => item.text)).toEqual(['Only the result.']);
  });

  it('declines an unknown sequence instead of silently completing its prefix', () => {
    const text = `${dates} Then explain why that holiday matters.`;
    const result = analyzeCompoundRequest(text);
    expect(result.kind).toBe('unsupported_tail');
    expect(result.reason).toBe('unrecognised_sequence');
    expect(evaluateLocalComputation(text, now)).toBeNull();
  });

  it.each([
    `${dates.slice(0, -1)} but save the result`,
    `${dates.slice(0, -1)} also send it`,
    'كم يوما بين 2024-02-28 و2024-03-01 كذلك احفظ الناتج',
    'كم يوما بين 2024-02-28 و2024-03-01 لكن أرسل الناتج',
  ])('recognises additional outer clauses without swallowing them: %s', text => {
    const result = evaluateLocalComputation(text, now);
    expect(result?.status).toBe('partial');
    expect(result?.compound?.pendingActions).toHaveLength(1);
  });

  it.each([
    `${dates.slice(0, -1)} and explain the result`,
    `${dates.slice(0, -1)} and put the result in a table`,
    `${dates.slice(0, -1)} but write a report about it`,
  ])('declines unsupported transform and report instructions rather than dropping their format: %s', text => {
    expect(analyzeCompoundRequest(text).kind).toBe('unsupported_tail');
    expect(evaluateLocalComputation(text, now)).toBeNull();
  });

  it.each(['Calculate 2 + 3, then "send it', 'Calculate 2 + 3, then ```save it'])('rejects an unbalanced literal: %s', text => {
    expect(analyzeCompoundRequest(text)).toMatchObject({ kind: 'invalid', reason: 'unbalanced_literal' });
    expect(evaluateLocalComputation(text, now)).toBeNull();
  });

  it('rejects over-limit requests and action counts without truncating', () => {
    expect(analyzeCompoundRequest('x'.repeat(MAX_COMPOUND_REQUEST + 1))).toMatchObject({ kind: 'invalid', reason: 'invalid_input' });
    const excessive = `Calculate 2 + 3${', then save the result'.repeat(MAX_COMPOUND_ACTIONS + 1)}`;
    expect(analyzeCompoundRequest(excessive)).toMatchObject({ kind: 'invalid', reason: 'too_many_actions' });
  });
});

describe('intrinsic computation covers only its own step', () => {
  it.each([
    [`${dates} Then save the result.`, '2', 'save'],
    ['What date is 10 days after 2026-11-21? Then remind me.', '2026-12-01', 'schedule'],
    ['Convert 3.5 kilometres to metres, then send the result to my colleague.', '3500', 'send'],
    ['Calculate 13 + 17, then open Wikipedia.', '30', 'open'],
    ['احسب ١٣ + ١٧ ثم أرسل النتيجة إلى المدير.', '30', 'send'],
  ])('truthfully returns a verified subtask and pending outer action: %s', (request, value, action) => {
    const result = evaluateLocalComputation(request, now);
    expect(result?.status).toBe('partial');
    expect(result?.text).toContain(value);
    expect(result?.compound?.pendingActions.map(item => item.kind)).toEqual([action]);
    const primary = evaluateLocalComputation(result!.compound!.primary.text, now)!;
    expect(result?.evidence).toEqual(primary.evidence);
    expect(result?.claims.slice(0, -1)).toEqual(primary.claims);
    expect(result?.claims.at(-1)).toMatchObject({ status: 'fixed', support: [] });
    expect(result?.claims.map(item => item.text).join('\n')).toBe(result?.text);
    expect(result?.text).toMatch(/No follow-up action was performed|لم أنفّذ الإجراءات اللاحقة/u);
  });

  it('preserves a requested value-only format while reporting pending work separately', () => {
    const result = evaluateLocalComputation('Calculate 2 + 3. Only the result. Then send it to my colleague.', now);
    expect(result?.status).toBe('partial');
    expect(result?.claims[0]?.text).toBe('5');
    expect(result?.compound?.formatting.map(item => item.text)).toEqual(['Only the result.']);
    expect(result?.compound?.pendingActions.map(item => item.kind)).toEqual(['send']);
  });

  it('can complete computation when the only other clause forbids delivery', () => {
    const result = evaluateLocalComputation(`${dates} Then do not send it.`, now);
    expect(result?.status).toBe('completed');
    expect(result?.evidence[0]?.value).toBe('2');
    expect(result?.compound?.pendingActions).toEqual([]);
    expect(result?.compound?.forbiddenActions[0]?.kind).toBe('send');
  });

  it('does not let quoted formatting or instructions become execution authority', () => {
    expect(evaluateLocalComputation('Translate this sentence: "Calculate 2+3, then send the answer".', now)).toBeNull();
    expect(evaluateLocalComputation('Summarize this code: ```Calculate 2+3; then save it```.', now)).toBeNull();
  });

  it('does not turn a failed primary calculation into a completed compound objective', () => {
    const result = evaluateLocalComputation('Calculate 7 / 0, then save the result.', now);
    expect(result?.status).toBe('blocked');
    expect(result?.evidence).toEqual([]);
    expect(result?.compound?.pendingActions[0]?.kind).toBe('save');
  });

  it('leaves greeting or identity followed by an action out of the standalone conversation handler', () => {
    expect(evaluateLocalConversation('Who are you? Then open https://reference.example/.')).toBeNull();
    expect(evaluateLocalConversation('Hello, save my preferred delivery day as Monday.')).toBeNull();
  });

  it('never certifies the complete compound goal from primary computation evidence', () => {
    const request = `${dates} Then save the result.`;
    const state = createChatSupervisor('compound-fixture', request, undefined, now.getTime());
    const result = evaluateLocalComputation(request, now)!;
    observeChatLocalAnswer(state, { source: 'computation', ...result, startedAt: now.getTime() + 1, now: now.getTime() + 2 });
    expect(reviewChatAnswer(state, result.text, now.getTime() + 3)).toMatchObject({ allowCompletion: false });
    expect(reviewChatAnswer(state, result.primaryText!, now.getTime() + 3)).toMatchObject({ allowCompletion: false });
  });

  it('retrieves both requested private fields without fabricating completion of an added mutation', async () => {
    const memory = async () => ['The bay code is RX-85.', 'The company name is Lantern Logistics.'];
    const request = 'What are my bay code and company name from memory?';
    const simple = await evaluateLocalRecall(request, { memory }, new AbortController().signal);
    expect(simple?.status).toBe('completed');
    expect(simple?.text).toContain('RX-85');
    expect(simple?.text).toContain('Lantern Logistics');
    for (const extra of ['Then delete the bay code.', 'Then remember that my phone is 07000.']) {
      const compound = await evaluateLocalRecall(`${request} ${extra}`, { memory }, new AbortController().signal);
      expect(compound?.status).not.toBe('completed');
      expect(compound?.text).not.toMatch(/(?:saved|deleted|updated) (?:your|the)/iu);
    }
  });
});
