import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import { createMemoryControl, memoryMigration, type MemoryExactWriteReceipt } from '@mohassan/memory';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createComputationMemoryReceipt } from '../apps/server/src/assistant/computation-memory-receipt.js';
import { type ComputationMemoryFlowState } from '../apps/server/src/assistant/computation-memory-flow.js';
import { assessMemoryVerificationReadback, createMemoryVerificationState, createMemoryVerificationSupervisor, recognizeMemoryVerificationRequest,
  restoreMemoryVerificationSource, restoreMemoryVerificationState, selectMemoryVerificationAnchor, type MemoryVerificationAnchor, type MemoryVerificationBinding,
  type MemoryVerificationRun, type MemoryVerificationSource } from '../apps/server/src/assistant/memory-verification.js';
import { observeTaskStep, reviewTaskCompletion, taskEvidenceHash } from '../apps/server/src/assistant/task-supervisor.js';

const epoch = Date.UTC(2026, 10, 21, 7);
const question = 'Did you save the result?';
const originalRequest = 'Calculate 271 + 314, then remember the result.';
const current: MemoryVerificationBinding = { ownerId: 'verification-owner', conversationId: 'verification-conversation', runId: 'verification-current', createdAt: epoch + 5000 };
const clone = <T,>(value: T): T => structuredClone(value);
const bracket = { startedAt: epoch + 6000, finishedAt: epoch + 6100 };

function fixture(raw = question) {
  const oldBinding = { ownerId: current.ownerId, conversationId: current.conversationId, runId: 'calculation-original', evaluatedAt: epoch };
  const receipt = createComputationMemoryReceipt(originalRequest, oldBinding)!;
  if (!receipt) throw new Error('Invalid synthetic calculation fixture');
  const flow: Exclude<ComputationMemoryFlowState, { phase: 'prepared' }> = { version: 1, kind: 'calculation_memory_flow', phase: 'write_attempted',
    receipt, attemptedAt: epoch + 1000 };
  const row: MemoryVerificationRun = { id: oldBinding.runId, ownerId: oldBinding.ownerId, conversationId: oldBinding.conversationId,
    goal: originalRequest, createdAt: epoch, status: 'interrupted', state: { computationMemory: flow } };
  const selected = selectMemoryVerificationAnchor(raw, current, [row], bracket.startedAt);
  if (selected.status !== 'selected') throw new Error(`Unselected synthetic attempt: ${selected.reason}`);
  const anchor = selected.anchor, source = restoreMemoryVerificationSource(raw, current, anchor, row, bracket.startedAt)!;
  const itemId = '11111111-2222-4333-8444-555555555555', evidenceId = '11111111-2222-4333-8444-666666666666';
  const createdAt = new Date(epoch + 1500).toISOString(), expiresAt = new Date(epoch + 86400000).toISOString();
  const commit: MemoryExactWriteReceipt = { version: 1, ownerId: current.ownerId, operationKey: receipt.operationKey, payloadHash: receipt.payload.hash,
    payloadBytes: receipt.payload.bytes, itemId, rootId: itemId, itemVersion: 1, evidenceId, layer: 'semantic', createdAt, expiresAt };
  const readback = () => ({ status: 'verified' as const, scope: 'memory_persistence_only' as const, receipt: clone(commit), observedAt: new Date(bracket.startedAt + 25).toISOString(),
    item: { id: itemId, rootId: itemId, version: 1, title: 'Saved result', content: receipt.payload.text, layer: 'semantic' as const, status: 'active' as const,
      confidence: 0.5, confidenceKind: 'user_asserted' as const, taskId: null, createdAt, updatedAt: createdAt, expiresAt,
      provenance: [{ id: evidenceId, kind: 'manual' as const, description: 'Synthetic exact-write provenance', taskId: null, eventId: null,
        contentHash: receipt.payload.hash, observedAt: createdAt, expiresAt: null, trust: 'manual' as const, status: 'active' as const }] } });
  return { oldBinding, receipt, flow, row, anchor, source, commit, readback };
}

describe('closed current-user memory verification questions', () => {
  it.each(['Did you save the result?', 'Have you saved the result?', 'Was the result saved?', 'Has the answer been stored in my memory?',
    'Please, did you record the value to your memory?', '  Did you remember the answer?  ', 'Ｄｉｄ ｙｏｕ ｓａｖｅ ｔｈｅ ｒｅｓｕｌｔ？',
    'هل حفظت النتيجة؟', 'هل حفظت الناتج في ذاكرتي؟', 'هل تم حفظ الجواب في الذاكرة؟', 'من فضلك، هل حَفِظْتَ النَّتِيجَةَ؟'])('recognizes only a past status question: %s', raw => {
    const result = recognizeMemoryVerificationRequest(raw);
    expect(result).toMatchObject({ allowed: true, reason: 'recognized', requestHash: taskEvidenceHash(raw) });
  });

  it.each(['Do not save anything. Did you save the result?', "Don't store anything in memory. Did you save the result?", 'لا تحفظ أي شيء. هل حفظت النتيجة؟'])('allows a recognized write-only prefix for matching, retaining the full original identity: %s', raw => {
    const result = recognizeMemoryVerificationRequest(raw)!;
    expect(result.allowed).toBe(true); expect(result.requestHash).toBe(taskEvidenceHash(raw));
    expect(raw.slice(result.questionSpan.start, result.questionSpan.end)).toMatch(/Did you|هل/u);
    expect(result.requestHash).not.toBe(taskEvidenceHash(raw.slice(result.questionSpan.start, result.questionSpan.end)));
  });

  it.each(['Do not access memory. Did you save the result?', 'Did you save the result? Do not read my memory.', 'لا تستخدم الذاكرة. هل حفظت النتيجة؟'])('preserves read vetoes even beside an otherwise recognized question: %s', raw => {
    expect(recognizeMemoryVerificationRequest(raw)).toMatchObject({ allowed: false, reason: 'memory_read_forbidden' });
    expect(selectMemoryVerificationAnchor(raw, current, [], bracket.startedAt)).toMatchObject({ status: 'blocked', reason: 'memory_read_forbidden' });
  });

  it.each(["Do not save anything and don't access memory. Did you save the result?", 'Do not save anything or never read my memory. Did you save the result?',
    'Never save anything nor do not access memory. Did you save the result?', "Do not save anything ＡＮＤ don't access memory. Did you save the result?",
    'لا تحفظ أي شيء ولا تقرأ الذاكرة. هل حفظت النتيجة؟', 'لا تحفظ أي شيء أو لا تستخدم الذاكرة. هل حفظت النتيجة؟'])('keeps a linked independent read veto recognizable without changing original spans: %s', raw => {
    const result = recognizeMemoryVerificationRequest(raw)!;
    expect(result).toMatchObject({ allowed: false, reason: 'memory_read_forbidden', requestHash: taskEvidenceHash(raw) });
    expect(raw.slice(result.questionSpan.start, result.questionSpan.end)).toMatch(/^(?:Did you|هل)/u);
  });

  it.each(["Do not save anything and don't store anything in memory. Did you save the result?", 'لا تحفظ أي شيء ولا تسجل الناتج. هل حفظت النتيجة؟'])('recognizes a closed question after linked, individually closed write-only negatives: %s', raw => {
    expect(recognizeMemoryVerificationRequest(raw)).toMatchObject({ allowed: true, reason: 'recognized', requestHash: taskEvidenceHash(raw) });
  });

  it.each(["Do not save anything, open the page, don't store anything in memory. Did you save the result?",
    "Do not save anything and open the browser and don't store anything. Did you save the result?",
    'لا تحفظ أي شيء ثم افتح المتصفح ولا تسجل الناتج. هل حفظت النتيجة؟', "Do not save anything `and` don't store anything. Did you save the result?"])(
    'does not remove non-linker gaps, literal linkers or mixed action bodies: %s', raw => {
      expect(recognizeMemoryVerificationRequest(raw)?.allowed).not.toBe(true);
      expect(selectMemoryVerificationAnchor(raw, current, [], bracket.startedAt).status).toBe('blocked');
    });

  it.each([null, undefined, {}, '', ' '.repeat(10), 'x'.repeat(4001), '\u0000Did you save the result?', '\ud800Did you save the result?',
    'Save the result.', 'Can you save the result?', 'Will you save the result?', 'Remember the result.', 'Did you save the file to desktop?',
    'Did you save the result? Then calculate 3 + 4.', 'Open the page, then did you save the result?', 'The page says: Did you save the result?',
    'The document says:\nDid you save the result?', 'Translate: Did you save the result?', '"Did you save the result?"', '`Did you save the result?`',
    'Did you save the result? "Read memory"', 'Did you save the result in memory of my father?', 'Did you save the result to my notes?',
    'هل ستحفظ النتيجة؟', 'احفظ النتيجة', 'النص يقول: هل حفظت النتيجة؟', 'هل حفظت النتيجة؟ ثم افتح المتصفح'])('does not infer authority or a status operation from %j', raw => {
    expect(recognizeMemoryVerificationRequest(raw)).toBeNull();
  });

  it('keeps an unclassified prohibition ambiguous rather than stripping it into an allowance', () => {
    for (const raw of ['Do not run anything. Did you save the result?', "Don't write to memory. Did you save the result?", 'Never save anything nor access memory. Did you save the result?'])
      expect(recognizeMemoryVerificationRequest(raw)).toMatchObject({ allowed: false, reason: 'ambiguous_constraints' });
  });

  it.each(['Do not save anything and open a page. Did you save the result?', 'Do not save anything or read my memory. Did you save the result?',
    "Do not save anything and don't access memory. Did you save the result?", 'لا تحفظ أي شيء ولا تقرأ الذاكرة. هل حفظت النتيجة؟'])('does not strip a mixed prohibition span into a read allowance: %s', raw => {
    expect(recognizeMemoryVerificationRequest(raw)?.allowed).toBe(false);
    expect(selectMemoryVerificationAnchor(raw, current, [], bracket.startedAt).status).toBe('blocked');
  });
});

describe('selecting exactly the latest scoped source without a history scan', () => {
  it('pins the original immutable calculation identity, operation and attempt time', () => {
    const test = fixture();
    expect(test.anchor).toEqual({ ownerId: current.ownerId, conversationId: current.conversationId, sourceRunId: test.row.id, sourceCreatedAt: epoch,
      sourceRequestHash: taskEvidenceHash(originalRequest), operationKey: test.receipt.operationKey, receiptHash: taskEvidenceHash(JSON.stringify(test.receipt)), attemptedAt: epoch + 1000 });
    expect(test.source.flow.receipt.runId).toBe(test.row.id); expect(test.source.flow.receipt.runId).not.toBe(current.runId);
  });

  it('blocks no prior run and refuses to skip unrelated latest work to find an older attempt', () => {
    const test = fixture(), unrelated = { ...test.row, id: 'unrelated', createdAt: epoch + 2000, goal: 'Write a poem', state: {} };
    expect(selectMemoryVerificationAnchor(question, current, [], bracket.startedAt)).toMatchObject({ status: 'blocked', reason: 'no_prior_run' });
    expect(selectMemoryVerificationAnchor(question, current, [unrelated, test.row], bracket.startedAt)).toMatchObject({ status: 'blocked', reason: 'unrelated_prior_run' });
  });

  it('fails closed on equal timestamps rather than choosing by ID or array order', () => {
    const test = fixture(), tied = { ...test.row, id: 'a-different-run' };
    for (const recent of [[test.row, tied], [tied, test.row]]) expect(selectMemoryVerificationAnchor(question, current, recent, bracket.startedAt))
      .toMatchObject({ status: 'blocked', reason: 'ambiguous_latest' });
  });

  it.each(['running', 'waiting_user', 'waiting_input', 'waiting_approval'])('cannot resume or supersede an active %s run', status => {
    const test = fixture();
    expect(selectMemoryVerificationAnchor(question, current, [{ ...test.row, status }], bracket.startedAt)).toMatchObject({ status: 'blocked', reason: 'active_prior_run' });
  });

  it.each(['ownerId', 'conversationId', 'id', 'createdAt'] as const)('rejects a different or future source %s', key => {
    const test = fixture(), changed = { ...test.row, [key]: key === 'id' ? current.runId : key === 'createdAt' ? current.createdAt : 'foreign' };
    expect(selectMemoryVerificationAnchor(question, current, [changed], bracket.startedAt).status).toBe('blocked');
  });

  it('requires bounded descending rows and a sane current DB clock', () => {
    const test = fixture(), newer = { ...test.row, id: 'newer', createdAt: epoch + 100 };
    for (const rows of [[test.row, newer], [newer, test.row, test.row]]) expect(selectMemoryVerificationAnchor(question, current, rows, bracket.startedAt).status).toBe('blocked');
    expect(selectMemoryVerificationAnchor(question, current, [test.row], current.createdAt - 1).status).toBe('blocked');
  });

  it.each([null, {}, { phase: 'unknown' }, { phase: 'write_attempted', receipt: 'saved' }])('rejects unsupported or malformed flow state %j without a source', value => {
    const test = fixture(), row = { ...test.row, state: { computationMemory: value } };
    expect(selectMemoryVerificationAnchor(question, current, [row], bracket.startedAt).status).toBe('blocked');
    expect(restoreMemoryVerificationSource(question, current, test.anchor, row, bracket.startedAt)).toBeNull();
  });

  it('never treats prepared state or a changed original request as an attempted write', () => {
    const test = fixture();
    const prepared = { version: 1, kind: 'calculation_memory_flow', phase: 'prepared', receipt: test.receipt };
    expect(selectMemoryVerificationAnchor(question, current, [{ ...test.row, state: { computationMemory: prepared } }], bracket.startedAt).status).toBe('blocked');
    expect(restoreMemoryVerificationSource(question, current, test.anchor, { ...test.row, goal: 'Calculate 1 + 1, then remember the result.' }, bracket.startedAt)).toBeNull();
  });

  it('validates a bounded clarified source request while rejecting malformed overrides', () => {
    const test = fixture(), row = { ...test.row, goal: 'An earlier clarification', state: { computationMemory: test.flow, clarifiedRequest: originalRequest } };
    expect(restoreMemoryVerificationSource(question, current, test.anchor, row, bracket.startedAt)).not.toBeNull();
    for (const clarifiedRequest of [null, '', 3, 'x'.repeat(4001)]) expect(restoreMemoryVerificationSource(question, current, test.anchor,
      { ...row, state: { ...row.state, clarifiedRequest } }, bracket.startedAt)).toBeNull();
  });
});

describe('flattened verification pointers are identity only, never old write authority', () => {
  function repeated() {
    const test = fixture(), pointer = createMemoryVerificationState(question, current, test.anchor, { outcome: 'active', checkedAt: bracket.finishedAt })!;
    const prior: MemoryVerificationRun = { id: current.runId, ownerId: current.ownerId, conversationId: current.conversationId,
      createdAt: current.createdAt, goal: question, status: 'completed', state: { memoryVerification: pointer } };
    const next = { ...current, runId: 'verification-next', createdAt: epoch + 10000 };
    return { ...test, pointer, prior, next };
  }

  it('follows one flattened pointer but still requires reloading the exact original row', () => {
    const test = repeated(), selected = selectMemoryVerificationAnchor(question, test.next, [test.prior, test.row], epoch + 11000);
    expect(selected).toEqual({ status: 'selected', anchor: test.anchor });
    expect(restoreMemoryVerificationSource(question, test.next, test.anchor, test.row, epoch + 11000)).not.toBeNull();
    expect(restoreMemoryVerificationSource(question, test.next, test.anchor, test.prior, epoch + 11000)).toBeNull();
    const serialized = JSON.stringify(test.pointer);
    expect(serialized).not.toContain(test.receipt.payload.text); expect(serialized).not.toContain(originalRequest);
    expect(test.pointer).not.toHaveProperty('computationMemory'); expect(test.pointer).not.toHaveProperty('receipt');
  });

  it.each(['verificationRunId', 'verificationRequestHash', 'ownerId', 'conversationId', 'verificationCreatedAt'] as const)('rejects a prior pointer with wrong %s', key => {
    const test = repeated();
    const pointer = { ...test.pointer, [key]: key === 'verificationCreatedAt' ? current.createdAt - 1 : key === 'verificationRequestHash' ? '0'.repeat(64) : 'other' };
    const row = { ...test.prior, state: { memoryVerification: pointer } };
    expect(selectMemoryVerificationAnchor(question, test.next, [row], epoch + 11000).status).toBe('blocked');
  });

  it('requires that the prior original or clarified goal is itself the hashed verification question', () => {
    const test = repeated();
    expect(selectMemoryVerificationAnchor(question, test.next, [{ ...test.prior, goal: 'Write a poem' }], epoch + 11000).status).toBe('blocked');
    const clarified = { ...test.prior, goal: 'Can you check that?', state: { memoryVerification: test.pointer, clarifiedRequest: question } };
    expect(selectMemoryVerificationAnchor(question, test.next, [clarified], epoch + 11000).status).toBe('selected');
    expect(restoreMemoryVerificationState(test.pointer, ` ${question}`, current)).toBeNull();
  });

  it.each(['sourceRunId', 'sourceCreatedAt', 'sourceRequestHash', 'operationKey', 'receiptHash', 'attemptedAt'] as const)('rejects a reloaded original whose pinned %s differs', key => {
    const test = repeated(), anchor = { ...test.anchor, [key]: key === 'sourceCreatedAt' || key === 'attemptedAt' ? test.anchor[key] + 1 : key === 'sourceRunId' ? 'foreign-source' : '0'.repeat(64) };
    expect(restoreMemoryVerificationSource(question, test.next, anchor as MemoryVerificationAnchor, test.row, epoch + 11000)).toBeNull();
  });

  it('does not recursively follow a second pointer or accept a mixed write+verification state', () => {
    const test = repeated();
    const fakeOriginal = { ...test.row, state: { memoryVerification: test.pointer } };
    expect(restoreMemoryVerificationSource(question, test.next, test.anchor, fakeOriginal, epoch + 11000)).toBeNull();
    const mixed = { ...test.prior, state: { ...test.prior.state as object, computationMemory: test.flow } };
    expect(selectMemoryVerificationAnchor(question, test.next, [mixed], epoch + 11000).status).toBe('blocked');
  });

  it('rejects a prior pointer claiming a check after the new verification run was created', () => {
    const test = repeated(), pointer = { ...test.pointer, lastCheck: { outcome: 'active' as const, checkedAt: test.next.createdAt + 1 } };
    expect(selectMemoryVerificationAnchor(question, test.next, [{ ...test.prior, state: { memoryVerification: pointer } }], epoch + 11000).status).toBe('blocked');
  });
});

describe('fresh exact readback certifies only the current status answer', () => {
  it.each([question, 'هل حفظت النتيجة؟'])('confirms fresh active data with a new read-answer criterion: %s', raw => {
    const test = fixture(raw), assessment = assessMemoryVerificationReadback(test.source, test.readback(), bracket);
    expect(assessment).toMatchObject({ scope: 'memory_read_status_only', status: 'completed', persistence: 'verified', observation: {
      kind: 'answer_evidence', source: 'memory-read', criterionId: 'memory-status-answer', answerHash: taskEvidenceHash(assessment.text) } });
    expect(assessment.text).not.toContain(test.receipt.payload.text);
    const supervisor = createMemoryVerificationSupervisor(raw, current, test.anchor)!;
    expect(supervisor.contract.criteria).toHaveLength(1); expect(supervisor.contract.criteria[0]!.kind).toBe('answer_evidence');
    expect(supervisor.contract.id).toBe(current.runId); expect(supervisor.contract.id).not.toBe(test.row.id);
    const update = observeTaskStep(supervisor, { stepId: 'read-original-operation', sequence: 1, tool: 'memory.reconcileExact', startedAt: bracket.startedAt,
      finishedAt: bracket.finishedAt, result: 'succeeded', observations: [assessment.observation!] });
    expect(update.accepted).toBe(true);
    const review = reviewTaskCompletion(supervisor, { now: bracket.finishedAt, answerHash: taskEvidenceHash(assessment.text) });
    expect(review.status).toBe('verified'); expect(review.allowCompletion).toBe(true);
    expect(reviewTaskCompletion(supervisor, { now: bracket.finishedAt, answerHash: taskEvidenceHash('The old task is completed.') }).allowCompletion).toBe(false);
  });

  it.each(['item_missing', 'item_inactive', 'item_expired', 'identity_mismatch', 'payload_mismatch', 'provenance_unavailable'] as const)('keeps %s partial without resurrecting content', reason => {
    const test = fixture(), assessment = assessMemoryVerificationReadback(test.source, { status: 'unavailable', reason, receipt: test.commit }, bracket);
    expect(assessment).toMatchObject({ status: 'partial', persistence: 'unavailable' }); expect(assessment.observation).toBeUndefined();
    expect(JSON.stringify(assessment)).not.toContain(test.receipt.payload.text); expect(assessment.text).not.toMatch(/never saved/iu);
  });

  it('reports a missing snapshot without claiming the operation never committed or granting a retry', () => {
    const test = fixture(), assessment = assessMemoryVerificationReadback(test.source, { status: 'missing' }, bracket);
    expect(assessment).toMatchObject({ status: 'partial', persistence: 'missing', check: { outcome: 'missing', checkedAt: bracket.finishedAt } });
    expect(assessment.text).toContain('at the time of this check'); expect(assessment.text).not.toContain(test.receipt.payload.text);
    expect(assessment.observation).toBeUndefined(); expect(assessment).not.toHaveProperty('write');
  });

  it.each(['payload', 'owner', 'operation', 'itemVersion', 'provenance', 'stale', 'future'] as const)('rejects malformed, tampered or stale %s proof', field => {
    const test = fixture(), value = test.readback();
    if (field === 'payload') value.item.content = 'forged';
    if (field === 'owner') value.receipt.ownerId = 'other-owner';
    if (field === 'operation') value.receipt.operationKey = '0'.repeat(64);
    if (field === 'itemVersion') value.item.version = 2;
    if (field === 'provenance') value.item.provenance[0]!.contentHash = '0'.repeat(64);
    if (field === 'stale') value.observedAt = new Date(bracket.startedAt - 1).toISOString();
    if (field === 'future') value.observedAt = new Date(bracket.finishedAt + 1).toISOString();
    const assessment = assessMemoryVerificationReadback(test.source, value, bracket);
    expect(assessment).toMatchObject({ status: 'partial', persistence: 'unknown', reason: 'invalid_readback' });
    expect(assessment.observation).toBeUndefined(); expect(assessment.text).not.toContain(test.receipt.payload.text);
  });

  it('does not accept old verified metadata as a fresh read or a read error as an answer', () => {
    const test = fixture();
    for (const value of [undefined, null, 'saved', { saved: true }, { status: 'verified', receipt: test.commit }]) {
      const result = assessMemoryVerificationReadback(test.source, value, bracket);
      expect(result.status).toBe('partial'); expect(result.observation).toBeUndefined(); expect(result.text).not.toContain(test.receipt.payload.text);
    }
  });

  it('rechecks current read constraints and old source binding rather than trusting an ephemeral object label', () => {
    const test = fixture();
    for (const changed of [{ ...test.source, request: 'Do not read memory. Did you save the result?' },
      { ...test.source, sourceRequest: 'Calculate 1 + 1, then remember the result.' },
      { ...test.source, current: { ...current, ownerId: 'other-owner' } }]) {
      expect(assessMemoryVerificationReadback(changed, test.readback(), bracket)).toMatchObject({ status: 'blocked', reason: 'invalid_source' });
    }
    expect(assessMemoryVerificationReadback(test.source, test.readback(), { startedAt: current.createdAt - 1, finishedAt: bracket.finishedAt }).reason).toBe('invalid_clock');
  });
});

describe('real exact-domain reconciliation is strictly read-only', () => {
  it('confirms an unknown old commit, downgrades a deleted item, and never recreates its content', async () => {
    const store = await createDatabase({});
    try {
      await migrateAuth(store.db); await migrate(store.db); await memoryMigration(store.db);
      const ownerId = `verification-domain-${randomUUID()}`;
      await store.db.insertInto('user').values({ id: ownerId, name: 'Synthetic verification owner', email: `${ownerId}@example.test` }).execute();
      let clock = epoch + 1500;
      const memory = createMemoryControl(store.db, { now: () => new Date(clock) }), test = fixture();
      const row = { ...test.row, ownerId };
      const receipt = createComputationMemoryReceipt(originalRequest, { ...test.oldBinding, ownerId })!;
      row.state = { computationMemory: { ...test.flow, receipt } };
      const binding = { ...current, ownerId }, selected = selectMemoryVerificationAnchor(question, binding, [row], bracket.startedAt);
      expect(selected.status).toBe('selected'); if (selected.status !== 'selected') throw new Error('Synthetic source selection failed');
      // Domain commit happens in the old operation; the current verifier only has a read port.
      const written = await memory.writeExact(ownerId, { operationKey: receipt.operationKey, payload: receipt.payload.text, payloadHash: receipt.payload.hash });
      const source = restoreMemoryVerificationSource(question, binding, selected.anchor, row, bracket.startedAt)!;
      const reconcile = vi.fn((owner: string, input: { operationKey: string; payloadHash: string }) => memory.reconcileExact(owner, input));
      clock = bracket.startedAt + 25;
      const input = { operationKey: selected.anchor.operationKey, payloadHash: source.flow.receipt.payload.hash };
      const active = assessMemoryVerificationReadback(source, await reconcile(ownerId, input), bracket);
      expect(active.status).toBe('completed');
      await memory.remove(ownerId, written.receipt.itemId, { expectedVersion: 1, reason: 'Synthetic deletion verification' });
      for (let index = 0; index < 2; index++) {
        const unavailable = assessMemoryVerificationReadback(source, await reconcile(ownerId, input), bracket);
        expect(unavailable).toMatchObject({ status: 'partial', persistence: 'unavailable' });
        expect(JSON.stringify(unavailable)).not.toContain(receipt.payload.text);
      }
      expect(reconcile).toHaveBeenCalledTimes(3);
      expect(await store.db.selectFrom('memory_items').select('id').where('owner_id', '=', ownerId).execute()).toHaveLength(0);
      expect(await store.db.selectFrom('memory_exact_operations').select('operation_key').where('owner_id', '=', ownerId).execute()).toHaveLength(1);
    } finally { await store.close(); }
  });
});
