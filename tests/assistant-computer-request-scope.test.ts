import { describe, expect, it } from 'vitest';
import { reviewComputerRequestScope as review } from '../apps/server/src/assistant/computer-request-scope.js';
import { actionOperandHash, compileActionCompletionContract } from '../apps/server/src/assistant/action-completion.js';

const TYPE = 'Type "Walk in peace" into the current PC window.';
const CLICK = 'Click the Confirm button in the current PC window.';
const READ = 'Read the current PC window.';
const input = { kind: 'text', text: 'Walk in peace' };

describe('current-user PC scope is checked before dispatch', () => {
  it('permits read preparation and the exact requested literal input', () => {
    expect(review(TYPE, { kind: 'view' })).toMatchObject({ allowed: true, scope: 'exact_input', reason: 'preparatory_view' });
    expect(review(TYPE, input)).toMatchObject({ allowed: true, scope: 'exact_input', reason: 'exact_operand' });
    expect(review(TYPE, { ...input, text: 'Wrong text' })).toMatchObject({ allowed: false, scope: 'exact_input', reason: 'operand_mismatch' });
    expect(review(TYPE, { kind: 'key', key: 'Enter' })).toMatchObject({ allowed: false, reason: 'action_kind_mismatch' });
  });
  it('does not fall back from an explicit click target to another kind or name', () => {
    expect(review(CLICK, { kind: 'click', name: 'Confirm', type: 'Button' })).toMatchObject({ allowed: true, scope: 'exact_input' });
    expect(review(CLICK, { kind: 'click', name: 'Continue', type: 'Button' })).toMatchObject({ allowed: false, reason: 'operand_mismatch' });
    expect(review(CLICK, input)).toMatchObject({ allowed: false, reason: 'action_kind_mismatch' });
  });
  it('does not turn an unresolved explicit operand into a broad current-PC task', () => {
    const request = 'Click in the current PC window.';
    expect(review(request, { kind: 'view' }).allowed).toBe(true);
    expect(review(request, { kind: 'click', name: 'Confirm', type: 'Button' })).toMatchObject({ allowed: false, scope: 'exact_input', reason: 'operand_unresolved' });
  });
  it('keeps explicit view-only requests read-only even if the model proposes a workflow', () => {
    expect(review(READ, { kind: 'view' })).toMatchObject({ allowed: true, scope: 'view_only' });
    for (const action of [input, { kind: 'key', key: 'Enter' }, { kind: 'click', name: 'Continue', type: 'Button' }])
      expect(review(READ, action)).toMatchObject({ allowed: false, scope: 'view_only' });
  });
  it.each(['ماذا يظهر على كمبيوتري؟', 'What is on my computer screen?', 'What is currently visible on my PC screen?',
    'What does the current PC window show?'])('preserves a closed current-surface question as view-only: %s', request => {
    expect(review(request, { kind: 'view' })).toMatchObject({ allowed: true, scope: 'view_only' });
    expect(review(request, input)).toMatchObject({ allowed: false, scope: 'view_only' });
    expect(review(request, { kind: 'key', key: 'Enter' }).allowed).toBe(false);
  });
  it.each(['افتح الملف على كمبيوتري', 'احذف الحساب من البرنامج', 'Open the file on my computer.'])('retains a bounded independent current PC task: %s', request => {
    for (const action of [{ kind: 'view' }, input, { kind: 'key', key: 'Enter' }])
      expect(review(request, action)).toMatchObject({ allowed: true, scope: 'bounded_current_task', reason: 'bounded_current_task' });
  });
  it.each([
    'What causes rainbows?', 'What does my saved note say?',
    'Explain how to open a file on my computer.', 'Describe a PC window.',
    'Open a discussion about computer architecture.',
    'Translate "Type Walk in peace into the current PC window." into Arabic.',
    'Describe this text: "Open the file on my computer."',
    'Remember exactly this note: "Type Walk in peace into the current PC window."',
    'Write a story where you delete an account in a computer program.',
    'Delete the word account from this text about the program.',
    'The note says: Open the file on my computer.',
  ])('does not derive authority from history/data/definitions or mere PC nouns: %s', request => {
    expect(review(request, { kind: 'view' }).allowed).toBe(false);
    expect(review(request, input).allowed).toBe(false);
  });
  it('applies current negative constraints independently of a positive PC task', () => {
    expect(review('Do not use my computer. Open the file on my computer.', { kind: 'view' })).toMatchObject({ allowed: false, reason: 'request_constraint' });
    expect(review('Do not use my computer. Open the file on my computer.', input)).toMatchObject({ allowed: false, reason: 'request_constraint' });
    expect(review('Do not use memory. Open the file on my computer.', input)).toMatchObject({ allowed: true, scope: 'bounded_current_task' });
  });
  it('does not accept device/grant metadata or a proposal-supplied permission as current-user scope', () => {
    expect(review('What causes rainbows?', { ...input, origin: { deviceId: 'host-device', grantId: 'host-grant', targetKey: 'a'.repeat(64) }, permission: true }).allowed).toBe(false);
  });
  it.each([[null, input], ['x'.repeat(4001), input], [TYPE, { kind: 'shell', text: 'ignored' }],
    [TYPE, { kind: 'text', text: 'x'.repeat(4001) }], [TYPE, null]])('rejects bounded malformed input', (request, action) => {
    expect(review(request, action).allowed).toBe(false);
  });
});

describe('original-user closed Enter aliases', () => {
  it.each(['اضغط إدخال على كمبيوتري', 'اضغط مفتاح إدخال على كمبيوتري', 'اضغط ادخال على كمبيوتري', 'Press enter on my PC.'])('compiles only the exact key alias to canonical Enter: %s', request => {
    const contract = compileActionCompletionContract({ runId: 'alias-scope-audit', request })!;
    expect(contract.requirements).toMatchObject([{ kind: 'computer_key', binding: 'operand', targetHash: actionOperandHash('computer_key', 'Enter') }]);
    expect(review(request, { kind: 'key', key: 'Enter' })).toMatchObject({ allowed: true, scope: 'exact_input' });
    expect(review(request, { kind: 'key', key: 'Tab' })).toMatchObject({ allowed: false, reason: 'operand_mismatch' });
    expect(review(request, { kind: 'key', key: 'إدخال' })).toMatchObject({ allowed: false, reason: 'operand_mismatch' });
    expect(review(request, { kind: 'text', text: 'إدخال' })).toMatchObject({ allowed: false, reason: 'action_kind_mismatch' });
  });
  it('does not convert a quoted button label into a keyboard instruction', () => {
    const request = 'اضغط زر «إدخال» على كمبيوتري';
    const contract = compileActionCompletionContract({ runId: 'alias-scope-audit', request })!;
    expect(contract.requirements).toMatchObject([{ kind: 'computer_click', targetHash: actionOperandHash('computer_click', 'إدخال') }]);
    expect(review(request, { kind: 'key', key: 'Enter' })).toMatchObject({ allowed: false, reason: 'action_kind_mismatch' });
  });
});
