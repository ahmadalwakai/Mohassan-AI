import { describe, expect, it } from 'vitest';
import {
  actionOperandHash, actionRequestHash, compileActionCompletionContract, createActionCompletionLedger,
  MAX_ACTION_COMPLETION_EVENTS, recordActionCompletionEvent, restoreActionCompletionLedger, reviewActionCompletion,
  type ActionCompletionEventInput, type ActionCompletionKind, type ActionCompletionLedger,
} from '../apps/server/src/assistant/action-completion.js';

const runId = 'action-audit-run';
const MEMORY = 'Remember that my fixture seating preference is aisle.';
const CLICK = 'Click the Confirm button in the current PC window.';
const TYPE = 'Type AUDIT-TEXT into the current Notepad window.';
const READ = 'What is my saved seating preference?';
const SEND = 'Write and send a thank-you email to Pat about the fixture review.';
const receiptHash = 'a'.repeat(64), answerHash = 'b'.repeat(64);
function ledger(request = MEMORY) { return createActionCompletionLedger(compileActionCompletionContract({ runId, request })!); }
function record(state: ActionCompletionLedger, event: ActionCompletionEventInput) {
  const result = recordActionCompletionEvent(state, event); expect(result.accepted).toBe(true); return result.ledger!;
}
function event(state: ActionCompletionLedger, phase: ActionCompletionEventInput['phase'], kind: ActionCompletionKind,
  changes: Partial<ActionCompletionEventInput> = {}): ActionCompletionEventInput {
  return { attemptId: 'attempt-1', kind, targetHash: state.contract.requirements.find(item => item.kind === kind)?.targetHash ?? state.contract.requestHash,
    phase, proof: phase === 'acknowledged' ? 'adapter_ack' : 'none', ...changes } as ActionCompletionEventInput;
}
function ack(state: ActionCompletionLedger, kind: ActionCompletionKind, changes: Partial<ActionCompletionEventInput> = {}) {
  state = record(state, event(state, 'started', kind, changes));
  return record(state, event(state, 'acknowledged', kind, changes));
}
function review(state: unknown, request = MEMORY, changes: Partial<Parameters<typeof reviewActionCompletion>[1]> = {}) {
  return reviewActionCompletion(state, { runId, request, outcome: 'done', ...changes });
}

describe('bounded original outer action contracts', () => {
  it.each([
    [MEMORY, ['memory_write']],
    [`Hello, ${MEMORY}`, ['memory_write']],
    ['احفظ في ذاكرتي أن لون الشعار التجريبي بنفسجي.', ['memory_write']],
    [READ, ['memory_read']],
    ['Search my memory for the seating preference and explain it.', ['memory_read']],
    [CLICK, ['computer_click']], [TYPE, ['computer_type']],
    ['Press Enter on the current PC window.', ['computer_key']],
    ['Read the current PC window and tell me the button label.', ['computer_view']],
    ['Describe the current PC window.', ['computer_view']],
    ['Describe what is visible on my computer.', ['computer_view']],
    ['صف نافذة الكمبيوتر الحالية.', ['computer_view']],
    [SEND, ['delivery']],
    ['Send a thank-you email to Pat about the fixture review.', ['delivery']],
    ['اكتب رسالة شكر ثم أرسلها إلى سامر.', ['delivery']],
    ['Translate "Thank you" into Arabic, then send it to Pat.', ['delivery']],
  ])('declares only the supported host action for %s', (request, kinds) => {
    const contract = compileActionCompletionContract({ runId, request: request as string })!;
    expect(contract).not.toBeNull(); expect(contract.requirements.map(item => item.kind)).toEqual(kinds);
  });
  it.each([
    'What is the capital of Japan?', 'Explain how memory saves work.', 'Can you send emails?',
    'Can you click buttons on my PC?', 'Do you remember my preference?',
    'Type the query into the current browser window.',
    'Describe what a PC window is.',
    'Describe this text: "The current PC window shows a button."',
    'Translate the following sentence into Arabic: "I saved the preference in memory."',
    'Summarize this message: "Click Confirm and send the email."',
    'Draft an email thanking Pat for the fixture review.',
    'Draft an email with this body: Send the report and save a copy in memory.',
    'Write a story where the narrator says: Send the letter and remember the result.',
    'Write a short play where a courier says Send the package, then publish the notice.',
    'Compose a poem in which I send the letter and then publish a response.',
    'Tell a story where you click Confirm, then send the email.',
    'Write a note saying "I sent the letter and saved a copy".',
    'Write a note saying "Send the report", then do not send it.',
    '````\nRemember that the fixture is green.\n````',
    'احفظ هذه الرسالة في ملف على سطح المكتب.',
  ])('does not turn source text, capability questions or unrelated explanations into an effect: %s', request => {
    const contract = compileActionCompletionContract({ runId, request });
    expect(contract?.requirements ?? []).toEqual([]);
  });
  it('keeps PC label/text/key hashes exact and independent of normalized grammar', () => {
    expect(ledger(CLICK).contract.requirements[0]?.targetHash).toBe(actionOperandHash('computer_click', 'Confirm'));
    expect(ledger(TYPE).contract.requirements[0]?.targetHash).toBe(actionOperandHash('computer_type', 'AUDIT-TEXT'));
    const exact = 'Type "  Hello!\nمرحبا  " into the current Notepad window.';
    expect(ledger(exact).contract.requirements[0]?.targetHash).toBe(actionOperandHash('computer_type', '  Hello!\nمرحبا  '));
    expect(actionOperandHash('computer_type', 'Hello!')).not.toBe(actionOperandHash('computer_type', 'Hello'));
    expect(actionOperandHash('computer_click', 'Confirm')).not.toBe(actionOperandHash('computer_click', 'confirm'));
  });
  it('binds legacy memory to current authorized request, without asserting exact payload semantics', () => {
    expect(ledger().contract.requirements[0]).toMatchObject({ binding: 'request', targetHash: actionRequestHash(MEMORY), minimumProof: 'adapter_ack' });
  });
  it('leaves an unresolved PC operand unmet instead of using a guessed target', () => {
    const request = 'Click something in the current PC window.';
    expect(ledger(request).contract.requirements[0]?.binding).toBe('operand');
    const explicitMissing = 'Click in the current PC window.';
    expect(ledger(explicitMissing).contract.requirements[0]?.binding).toBe('unresolved');
    expect(review(ledger(explicitMissing), explicitMissing).reason).toBe('operand_unresolved');
  });
  it('does not erase an unsupported extra action behind a recognized primary', () => {
    const request = 'Type AUDIT-TEXT into the current Notepad window, then print a full report.';
    expect(ledger(request).contract.coverage).toBe('incomplete_sequence');
    expect(review(ack(ledger(request), 'computer_type'), request).reason).toBe('incomplete_sequence');
  });
  it('does not silently cover an additional recognized action that this guard does not validate', () => {
    const request = 'Type AUDIT-TEXT into the current Notepad window, then open the calculator.';
    expect(review(ack(ledger(request), 'computer_type'), request).reason).toBe('incomplete_sequence');
  });
  it('does not treat explanations of the observed result as unperformed mutations', () => {
    for (const [request, kind] of [['Search my memory for the seating preference and explain it.', 'memory_read'],
      ['Read the current PC window and tell me the button label.', 'computer_view']] as const)
      expect(review(ack(ledger(request), kind), request)).toMatchObject({ allowDone: true, proofLevel: 'adapter_ack' });
  });
  it('preserves punctuation as part of an unquoted typed operand', () => {
    const request = 'Type Hello! into the current Notepad window.';
    expect(ledger(request).contract.requirements[0]?.targetHash).toBe(actionOperandHash('computer_type', 'Hello!'));
  });
  it.each([
    ['Type "Walk in peace" into the current Notepad window.', 'computer_type', 'Walk in peace', '"Walk'],
    ['Click the "Sign in" button in the current PC window.', 'computer_click', 'Sign in', '"Sign'],
    ['Click the Sign in button in the current PC window.', 'computer_click', 'Sign in', 'Sign'],
  ] as const)('never binds a PC operand prefix inside a label/literal: %s', (request, kind, full, prefix) => {
    const state = ledger(request);
    expect(state.contract.requirements[0]?.targetHash).toBe(actionOperandHash(kind, full));
    expect(review(ack(state, kind, { targetHash: actionOperandHash(kind, prefix) }), request).allowDone).toBe(false);
    expect(review(ack(state, kind), request).allowDone).toBe(true);
  });
  it('leaves multiple plausible unquoted destination boundaries unresolved', () => {
    const request = 'Type Walk in Notepad into the current PC window.';
    expect(ledger(request).contract.requirements[0]?.binding).toBe('unresolved');
  });
  it.each(['', 'x'.repeat(4001), '"Remember an unterminated quote', 'Remember \ud800'])('rejects invalid/bounded input', request => {
    expect(compileActionCompletionContract({ runId, request })).toBeNull();
  });
});

describe('trusted immutable action event ledger', () => {
  it.each([[MEMORY, 'memory_write'], [CLICK, 'computer_click'], [TYPE, 'computer_type']] as const)('does not accept done with zero dispatch for %s', (request, kind) => {
    expect(review(ledger(request), request)).toMatchObject({ allowDone: false, proofLevel: 'none', pendingKinds: [kind], reason: 'action_not_performed', replacement: { status: 'partial' } });
  });
  it('retains legacy acknowledgment only at adapter_ack proof level', () => {
    const original = ledger(), next = ack(original, 'memory_write');
    expect(original.events).toEqual([]);
    expect(review(next)).toMatchObject({ allowDone: true, proofLevel: 'adapter_ack', pendingKinds: [] });
    expect(JSON.stringify(next)).not.toContain('fixture seating preference');
  });
  it('allows exact acknowledged PC operands but cannot substitute another label/payload', () => {
    expect(review(ack(ledger(CLICK), 'computer_click'), CLICK)).toMatchObject({ allowDone: true, proofLevel: 'adapter_ack' });
    const wrong = ack(ledger(TYPE), 'computer_type', { targetHash: actionOperandHash('computer_type', 'DIFFERENT-TEXT') });
    expect(review(wrong, TYPE)).toMatchObject({ allowDone: false, reason: 'unexpected_mutation' });
  });
  it('keeps a started mutation pending across JSON checkpoints', () => {
    const state = record(ledger(), event(ledger(), 'started', 'memory_write'));
    const restored = restoreActionCompletionLedger(JSON.parse(JSON.stringify(state)), { runId, request: MEMORY });
    expect(review(restored)).toMatchObject({ allowDone: false, reason: 'effect_pending' });
  });
  it('keeps unknown mutation sticky and refuses a reworded retry or later self-acknowledgment', () => {
    let state = record(ledger(), event(ledger(), 'started', 'memory_write'));
    state = record(state, event(state, 'unknown', 'memory_write'));
    expect(review(state)).toMatchObject({ allowDone: false, reason: 'effect_unknown' });
    for (const proposed of [event(state, 'started', 'memory_write', { attemptId: 'different-attempt', targetHash: 'c'.repeat(64) }),
      event(state, 'acknowledged', 'memory_write'), event(state, 'started', 'computer_type', { attemptId: 'different-kind' })]) {
      const next = recordActionCompletionEvent(state, proposed);
      expect(next.accepted).toBe(false); expect(next.ledger?.events).toEqual(state.events);
      expect(review(next.ledger).allowDone).toBe(false);
    }
  });
  it('cannot promote a tool result string or acknowledgment without an actual started event', () => {
    const next = recordActionCompletionEvent(ledger(), event(ledger(), 'acknowledged', 'memory_write'));
    expect(next.accepted).toBe(false); expect(review(next.ledger).reason).toBe('ledger_fault');
  });
  it('does not treat a PC input acknowledgment as delivery evidence', () => {
    const state = ack(ledger(SEND), 'computer_key', { targetHash: actionOperandHash('computer_key', 'Enter') });
    expect(review(state, SEND)).toMatchObject({ allowDone: false, reason: 'unexpected_mutation' });
  });
  it('requires a host-validated authoritative receipt for delivery', () => {
    let state = ledger(SEND);
    state = record(state, event(state, 'started', 'delivery'));
    expect(recordActionCompletionEvent(state, event(state, 'acknowledged', 'delivery')).accepted).toBe(false);
    expect(recordActionCompletionEvent(state, event(state, 'acknowledged', 'delivery', { proof: 'authoritative_readback' })).accepted).toBe(false);
    state = record(state, event(state, 'acknowledged', 'delivery', { proof: 'authoritative_readback', receiptHash }));
    expect(review(state, SEND)).toMatchObject({ allowDone: true, proofLevel: 'authoritative_readback' });
  });
  it('requires separate matching attempts for two explicit delivery actions', () => {
    const request = 'Write a note, then send it to Pat, then publish it.';
    let state = ledger(request);
    expect(state.contract.requirements).toHaveLength(2);
    state = record(state, event(state, 'started', 'delivery'));
    state = record(state, event(state, 'acknowledged', 'delivery', { proof: 'authoritative_readback', receiptHash }));
    expect(review(state, request)).toMatchObject({ allowDone: false, reason: 'action_not_performed' });
  });
  it('does not erase a denied mutation when model outcome or wording changes', () => {
    const state = record(ledger(READ), event(ledger(READ), 'denied', 'memory_write'));
    for (const outcome of ['done', 'partial', 'blocked'] as const) expect(review(state, READ, { outcome })).toMatchObject({ allowDone: false, reason: 'denied_mutation', replacement: { status: outcome === 'blocked' ? 'blocked' : 'partial' } });
    expect(restoreActionCompletionLedger(JSON.parse(JSON.stringify(state)), { runId, request: READ })?.events).toHaveLength(1);
  });
  it.each([[CLICK, 'computer_click'], [MEMORY, 'memory_write']] as const)('retains rejected proposals but permits a later matching authorized actual acknowledgment: %s', (request, kind) => {
    let state = ledger(request);
    state = record(state, event(state, 'denied', kind, { attemptId: 'rejected', targetHash: 'f'.repeat(64) }));
    state = ack(state, kind, { attemptId: 'corrected' });
    expect(review(state, request)).toMatchObject({ allowDone: true, proofLevel: 'adapter_ack' });
    const restored = restoreActionCompletionLedger(JSON.parse(JSON.stringify(state)), { runId, request })!;
    expect(restored.events[0]?.event.phase).toBe('denied'); expect(restored.events).toHaveLength(3);
  });
  it('does not clear a denial with an earlier ack or a later wrong target', () => {
    let state = ack(ledger(CLICK), 'computer_click');
    state = record(state, event(state, 'denied', 'computer_click', { attemptId: 'rejected-after' }));
    expect(review(state, CLICK).reason).toBe('denied_mutation');
    state = ledger(CLICK);
    state = record(state, event(state, 'denied', 'computer_click', { attemptId: 'rejected-before' }));
    state = ack(state, 'computer_click', { attemptId: 'wrong', targetHash: actionOperandHash('computer_click', 'Cancel') });
    expect(review(state, CLICK).reason).toBe('unexpected_mutation');
  });
  it('preserves a host-verified exact recall despite an unrelated denied proposal, bound to the exact final answer', () => {
    const state = record(ledger(READ), event(ledger(READ), 'denied', 'computer_click'));
    const verifiedReadOnlyAnswer = { source: 'exact_memory_recall' as const, runId, requestHash: actionRequestHash(READ), answerHash };
    expect(review(state, READ, { answerHash, verifiedReadOnlyAnswer })).toMatchObject({ allowDone: true, reason: 'verified_read_only_answer' });
    for (const change of [{ answerHash: 'c'.repeat(64) }, { runId: 'other-run' }, { requestHash: 'd'.repeat(64) }])
      expect(review(state, READ, { answerHash, verifiedReadOnlyAnswer: { ...verifiedReadOnlyAnswer, ...change } }).allowDone).toBe(false);
    expect(review(state, READ, { verifiedReadOnlyAnswer }).allowDone).toBe(false);
  });
  it('never uses exact recall to clear unknown or to satisfy an outstanding requested mutation', () => {
    const changes = { answerHash, verifiedReadOnlyAnswer: { source: 'exact_memory_recall' as const, runId, requestHash: actionRequestHash(READ), answerHash } };
    let state = record(ledger(READ), event(ledger(READ), 'started', 'memory_write'));
    state = record(state, event(state, 'unknown', 'memory_write'));
    expect(review(state, READ, changes).reason).toBe('effect_unknown');
    expect(review(ledger(MEMORY), MEMORY, { ...changes, verifiedReadOnlyAnswer: { ...changes.verifiedReadOnlyAnswer, requestHash: actionRequestHash(MEMORY) } }).allowDone).toBe(false);
  });
  it('preserves a bound host-verified exact recall when narrow read-head recognition produced no requirements', () => {
    const request = 'From my memory, return code only.';
    let state = ledger(request); expect(state.contract.requirements).toEqual([]);
    state = record(state, event(state, 'denied', 'memory_write'));
    expect(review(state, request).reason).toBe('denied_mutation');
    expect(review(state, request, { answerHash, verifiedReadOnlyAnswer: {
      source: 'exact_memory_recall', runId, requestHash: actionRequestHash(request), answerHash,
    } })).toMatchObject({ allowDone: true, reason: 'verified_read_only_answer' });
    expect(state.events).toHaveLength(1);
  });
  it('does not substitute an exact memory value for a specifically required PC observation', () => {
    const request = 'Read the current PC window and tell me the button label.';
    expect(review(ledger(request), request, { answerHash, verifiedReadOnlyAnswer: {
      source: 'exact_memory_recall', runId, requestHash: actionRequestHash(request), answerHash,
    } }).allowDone).toBe(false);
  });
  it('allows read acknowledgments without claiming a write or independently verified factual accuracy', () => {
    expect(review(ack(ledger(READ), 'memory_read'), READ)).toMatchObject({ allowDone: true, proofLevel: 'adapter_ack' });
  });
  it('binds restored state to run and original bytes, and rejects legacy or altered state', () => {
    const state = ack(ledger(), 'memory_write');
    expect(restoreActionCompletionLedger(state, { runId: 'other-run', request: MEMORY })).toBeNull();
    expect(restoreActionCompletionLedger(state, { runId, request: `${MEMORY} ` })).toBeNull();
    for (const bad of [null, 'saved', {}, { ...state, events: [...state.events].reverse() },
      { ...state, events: state.events.map((item, at) => at ? item : { ...item, event: { ...item.event, targetHash: 'e'.repeat(64) } }) },
      { ...state, contract: { ...state.contract, requirements: [] } }]) expect(review(bad).reason).toBe('invalid_state');
  });
  it('retains all records and a fail-closed fault on capacity rather than dropping old denials', () => {
    let state = ledger(READ);
    for (let at = 0; at < MAX_ACTION_COMPLETION_EVENTS; at++) state = record(state, event(state, 'denied', 'computer_click', { attemptId: `denied-${at}` }));
    const next = recordActionCompletionEvent(state, event(state, 'denied', 'computer_click', { attemptId: 'overflow' }));
    expect(next).toMatchObject({ accepted: false, reason: 'capacity' });
    expect(next.ledger?.events).toEqual(state.events); expect(review(next.ledger, READ).reason).toBe('ledger_fault');
    expect(restoreActionCompletionLedger(next.ledger, { runId, request: READ })?.fault).toBe('capacity');
  });
  it('does not inspect final prose or promote a model partial in ordinary conversation/source transformations', () => {
    const request = 'Translate "I saved the note" into Arabic.';
    expect(review(ledger(request), request, { outcome: 'partial' })).toMatchObject({ allowDone: true, proofLevel: 'none', reason: 'unscoped' });
  });
});
