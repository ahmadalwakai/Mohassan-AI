import { describe, expect, it } from 'vitest';
import { createRunLedger } from '../apps/server/src/assistant/agent-run.js';
import {
  PermissionGateError, actionFingerprint, checkPermission, consumePermission, invalidatePermissions, pendingActionMaterial, recordDecision, requestPermission, type ActionMaterial,
} from '../apps/server/src/assistant/permission-gate.js';

/** The permission gate is pure: an approval is bound to its actor, conversation, run and the action's exact details. */
const RUN = '1e7c2a9b-4f3d-4a5e-8b6c-7d8e9f0a1b2c';
const APPROVAL = '2f8d3b0c-5a4e-4b6f-9c7d-8e9f0a1b2c3d';
const OTHER_APPROVAL = '3a9e4c1d-6b5f-4c70-8d8e-9f0a1b2c3d4e';
const T0 = Date.parse('2026-11-23T14:00:00.000Z');
const scope = { actorId: 'owner-a', conversationId: 'conversation-a', runId: RUN };

const deleteOld = (): ActionMaterial => pendingActionMaterial({ pendingDesktop: { command: { kind: 'file_delete', path: 'old.txt', folder: 'desktop', what: 'file' }, label: 'حذف old.txt', lang: 'ar' } })!.material;
const deleteNew = (): ActionMaterial => pendingActionMaterial({ pendingDesktop: { command: { kind: 'file_delete', path: 'new.txt', folder: 'desktop', what: 'file' }, label: 'حذف old.txt', lang: 'ar' } })!.material;
const check = (ledger: ReturnType<typeof createRunLedger>, material: unknown, extra: Partial<Parameters<typeof checkPermission>[1]> = {}) =>
  checkPermission(ledger, { material, ...scope, actorAllowed: true, platformAllowed: true, at: T0 + 1000, ...extra });

describe('fingerprints', () => {
  it('change with any material detail and ignore the wording shown to the owner', () => {
    const material = deleteOld();
    const relabelled: ActionMaterial = { ...material, action: 'something else entirely', consequence: 'other words' };
    expect(actionFingerprint(material)).toBe(actionFingerprint(relabelled));
    expect(actionFingerprint(material)).not.toBe(actionFingerprint(deleteNew()));
    expect(actionFingerprint(material)).not.toBe(actionFingerprint({ ...material, details: { ...material.details, extra: true } }));
  });
});

describe('the gate', () => {
  it('asks, then allows exactly the approved action once, then asks again for a second execution', () => {
    const ledger = createRunLedger({ runId: RUN, at: T0 });
    expect(check(ledger, deleteOld())).toMatchObject({ decision: 'ask', reason: 'approval_required' });
    requestPermission(ledger, { approvalId: APPROVAL, ...scope, material: deleteOld(), at: T0 });
    expect(check(ledger, deleteOld())).toMatchObject({ decision: 'deny', reason: 'awaiting_decision' });
    recordDecision(ledger, { approvalId: APPROVAL, actorId: scope.actorId, conversationId: scope.conversationId, approved: true, at: T0 + 500 });
    // The unchanged action is covered by the existing yes; a resumed run or a retry does not ask again.
    const allowed = check(ledger, deleteOld(), { approvalId: APPROVAL });
    expect(allowed).toMatchObject({ decision: 'allow', reason: 'granted' });
    expect(check(ledger, deleteOld(), { approvalId: APPROVAL }).decision).toBe('allow');
    consumePermission(ledger, APPROVAL, T0 + 2000);
    expect(check(ledger, deleteOld())).toMatchObject({ decision: 'ask', reason: 'grant_consumed' });
  });

  it('denies an action whose details changed after the approval, and keeps a refusal for the rest of the run', () => {
    const ledger = createRunLedger({ runId: RUN, at: T0 });
    requestPermission(ledger, { approvalId: APPROVAL, ...scope, material: deleteOld(), at: T0 });
    recordDecision(ledger, { approvalId: APPROVAL, ...scope, approved: true, at: T0 + 100 });
    expect(check(ledger, deleteNew(), { approvalId: APPROVAL })).toMatchObject({ decision: 'deny', reason: 'approval_mismatch' });
    expect(check(ledger, deleteNew())).toMatchObject({ decision: 'ask', reason: 'approval_required' });
    requestPermission(ledger, { approvalId: OTHER_APPROVAL, ...scope, material: deleteNew(), at: T0 + 200 });
    recordDecision(ledger, { approvalId: OTHER_APPROVAL, ...scope, approved: false, at: T0 + 300 });
    expect(check(ledger, deleteNew())).toMatchObject({ decision: 'deny', reason: 'owner_refused' });
  });

  it('lets only the asked actor answer, in the same conversation, and never across runs', () => {
    const ledger = createRunLedger({ runId: RUN, at: T0 });
    requestPermission(ledger, { approvalId: APPROVAL, ...scope, material: deleteOld(), at: T0 });
    expect(() => recordDecision(ledger, { approvalId: APPROVAL, actorId: 'owner-b', conversationId: scope.conversationId, approved: true, at: T0 + 1 })).toThrow(PermissionGateError);
    expect(() => recordDecision(ledger, { approvalId: APPROVAL, actorId: scope.actorId, conversationId: 'conversation-b', approved: true, at: T0 + 1 })).toThrow(/Only the account/);
    expect(() => recordDecision(ledger, { approvalId: OTHER_APPROVAL, ...scope, approved: true, at: T0 + 1 })).toThrow(/not waiting/);
    recordDecision(ledger, { approvalId: APPROVAL, ...scope, approved: true, at: T0 + 2 });
    expect(check(ledger, deleteOld(), { actorId: 'owner-b' })).toMatchObject({ decision: 'ask' });
    expect(check(ledger, deleteOld(), { runId: 'another-run' })).toMatchObject({ decision: 'ask' });
  });

  it('checks the capability, its arguments, the actor and the platform before any approval', () => {
    const ledger = createRunLedger({ runId: RUN, at: T0 });
    expect(check(ledger, { ...deleteOld(), capability: 'shell.rm_rf' })).toMatchObject({ decision: 'deny', reason: 'capability_unregistered' });
    expect(check(ledger, { ...deleteOld(), target: '' })).toMatchObject({ decision: 'deny', reason: 'invalid_arguments' });
    expect(check(ledger, { ...deleteOld(), details: { nested: { not: 'allowed' } } })).toMatchObject({ decision: 'deny', reason: 'invalid_arguments' });
    expect(check(ledger, deleteOld(), { actorAllowed: false })).toMatchObject({ decision: 'deny', reason: 'actor_not_allowed' });
    expect(check(ledger, deleteOld(), { platformAllowed: false })).toMatchObject({ decision: 'deny', reason: 'platform_restricted' });
    expect(() => requestPermission(ledger, { approvalId: APPROVAL, ...scope, material: { ...deleteOld(), capability: 'shell.rm_rf' } as unknown as ActionMaterial, at: T0 })).toThrow(PermissionGateError);
  });

  it('expires an old yes, and a correction invalidates every unused one', () => {
    const ledger = createRunLedger({ runId: RUN, at: T0 });
    requestPermission(ledger, { approvalId: APPROVAL, ...scope, material: deleteOld(), at: T0, ttlMs: 1000 });
    recordDecision(ledger, { approvalId: APPROVAL, ...scope, approved: true, at: T0 + 10 });
    expect(check(ledger, deleteOld(), { at: T0 + 5000 })).toMatchObject({ decision: 'deny', reason: 'approval_expired' });
    const corrected = createRunLedger({ runId: RUN, at: T0 });
    requestPermission(corrected, { approvalId: APPROVAL, ...scope, material: deleteOld(), at: T0 });
    recordDecision(corrected, { approvalId: APPROVAL, ...scope, approved: true, at: T0 + 10 });
    invalidatePermissions(corrected, 'superseded', T0 + 20);
    expect(corrected.permissions[0]).toMatchObject({ decision: 'invalidated', reason: 'superseded' });
    expect(check(corrected, deleteOld())).toMatchObject({ decision: 'ask', reason: 'approval_required' });
  });

  it('builds browser, held, task and computer materials from the stored pending action only', () => {
    const browser = pendingActionMaterial({ pendingAction: { action: { kind: 'click', ref: 'e1' }, label: 'إرسال',
      permit: { id: 'p', url: 'https://shop.test/checkout', method: 'POST', bodyHash: 'b'.repeat(64), pageHash: 'c'.repeat(64), actionHash: 'd'.repeat(64), expiresAt: T0 } } })!;
    expect(browser).toMatchObject({ kind: 'action', material: { capability: 'browser.submit', target: 'POST https://shop.test/checkout' } });
    expect(pendingActionMaterial({ pendingHeld: { id: 'held-1', label: 'طلب' } })!.material.capability).toBe('browser.submit');
    expect(pendingActionMaterial({ pendingTask: { id: 'task-1', label: 'تعديل', tool: 'code_change' } })!.material).toMatchObject({ capability: 'runtime.task', target: 'task:task-1' });
    expect(pendingActionMaterial({ pendingComputer: { step: { kind: 'click', name: 'Save', type: 'button' }, label: 'Save' } })!.material).toMatchObject({ capability: 'computer.input', reversible: false });
    expect(pendingActionMaterial({})).toBeNull();
  });
});
