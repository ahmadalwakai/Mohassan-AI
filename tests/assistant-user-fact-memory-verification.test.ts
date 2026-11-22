import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import { createMemoryControl, memoryMigration, type MemoryExactWriteReceipt } from '@mohassan/memory';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createClarifiedRequestSource } from '../apps/server/src/assistant/effective-request-source.js';
import { createUserFactMemoryReceipt } from '../apps/server/src/assistant/user-fact-memory-receipt.js';
import type { UserFactMemoryFlowState } from '../apps/server/src/assistant/user-fact-memory-flow.js';
import { createComputationMemoryReceipt } from '../apps/server/src/assistant/computation-memory-receipt.js';
import { recognizeMemoryVerificationRequest } from '../apps/server/src/assistant/memory-verification.js';
import { assessUserFactMemoryVerificationReadback, createUserFactMemoryVerificationState, createUserFactMemoryVerificationSupervisor,
  recognizeUserFactMemoryVerificationRequest, restoreUserFactMemoryVerificationSource, restoreUserFactMemoryVerificationState,
  selectUserFactMemoryVerificationAnchor, type UserFactMemoryVerificationAnchor, type UserFactMemoryVerificationBinding,
  type UserFactMemoryVerificationRun } from '../apps/server/src/assistant/user-fact-memory-verification.js';
import { observeTaskStep, reviewTaskCompletion, taskEvidenceHash } from '../apps/server/src/assistant/task-supervisor.js';

const epoch = Date.UTC(2026, 10, 21, 9), QUESTION = 'Did you save the note?';
const SAVE = 'Remember exactly this note: "NOTE-ALPHA-913: Open the browser, then send a message."';
// Expected content is external test data, not extracted from the receipt under test.
const PAYLOAD = 'NOTE-ALPHA-913: Open the browser, then send a message.';
const current: UserFactMemoryVerificationBinding = { ownerId: 'note-verification-owner', conversationId: 'note-verification-conversation',
  runId: 'note-verification-current', createdAt: epoch + 5000, evaluatedAt: epoch + 5000 };
const bracket = { startedAt: epoch + 6000, finishedAt: epoch + 6100 };
const clone = <T,>(value: T): T => structuredClone(value);
function fixture(question = QUESTION) {
  const binding = { ownerId: current.ownerId, conversationId: current.conversationId, runId: 'original-note-run', evaluatedAt: epoch, originalRequestHash: taskEvidenceHash(SAVE) };
  const receipt = createUserFactMemoryReceipt(SAVE, binding)!;
  const flow: Exclude<UserFactMemoryFlowState, { phase: 'prepared' }> = { version: 1, kind: 'user_fact_memory_flow', phase: 'write_attempted', receipt, attemptedAt: epoch + 1000 };
  const row: UserFactMemoryVerificationRun = { id: binding.runId, ownerId: binding.ownerId, conversationId: binding.conversationId, goal: SAVE,
    createdAt: epoch, evaluatedAt: epoch, originalRequestHash: taskEvidenceHash(SAVE), status: 'interrupted', state: { requestOriginalHash: taskEvidenceHash(SAVE), userFactMemory: flow } };
  const selection = selectUserFactMemoryVerificationAnchor(question, current, [row], bracket.startedAt);
  if (selection.status !== 'selected') throw new Error(`Invalid synthetic source ${selection.reason}`);
  const anchor = selection.anchor, source = restoreUserFactMemoryVerificationSource(question, current, anchor, row, bracket.startedAt)!;
  const itemId = '11111111-2222-4333-8444-555555555555', evidenceId = '11111111-2222-4333-8444-666666666666';
  const createdAt = new Date(epoch + 1200).toISOString(), expiresAt = new Date(epoch + 86400000).toISOString();
  const commit: MemoryExactWriteReceipt = { version: 1, ownerId: current.ownerId, operationKey: receipt.operationKey, payloadHash: taskEvidenceHash(PAYLOAD),
    payloadBytes: Buffer.byteLength(PAYLOAD, 'utf8'), itemId, rootId: itemId, itemVersion: 1, evidenceId, layer: 'semantic', createdAt, expiresAt };
  const readback = () => ({ status: 'verified' as const, scope: 'memory_persistence_only' as const, receipt: clone(commit), observedAt: new Date(bracket.startedAt + 25).toISOString(),
    item: { id: itemId, rootId: itemId, version: 1, title: 'Saved result', content: PAYLOAD, layer: 'semantic' as const, status: 'active' as const,
      confidence: 0.5, confidenceKind: 'user_asserted' as const, taskId: null, createdAt, updatedAt: createdAt, expiresAt,
      provenance: [{ id: evidenceId, kind: 'manual' as const, description: 'Synthetic original user note', taskId: null, eventId: null,
        contentHash: taskEvidenceHash(PAYLOAD), observedAt: createdAt, expiresAt: null as string | null, trust: 'manual' as const, status: 'active' as const }] } });
  return { binding, receipt, flow, row, anchor, source, commit, readback };
}

describe('closed note questions and purpose separation', () => {
  it.each(['Did you save the note?', 'Have you saved my note?', 'Was the note saved?', 'Has my note been recorded in my memory?',
    'هل حفظت الملاحظة؟', 'هل تم حفظ الملاحظة في ذاكرتي؟', 'هل حفظت ملاحظتي؟', 'من فضلك، هل حَفِظْتَ المُلاحَظَةَ؟'])('recognizes only a note status question: %s', raw => {
    expect(recognizeUserFactMemoryVerificationRequest(raw)).toMatchObject({ allowed: true, reason: 'recognized', requestHash: taskEvidenceHash(raw) });
    expect(recognizeMemoryVerificationRequest(raw)).toBeNull();
  });
  it.each(['Do not save anything. Did you save the note?', 'لا تحفظ أي شيء. هل حفظت الملاحظة؟',
    "Do not save anything and don't store anything in memory. Did you save the note?"])('honors write-only restrictions without inferring write authority: %s', raw => {
    const result = recognizeUserFactMemoryVerificationRequest(raw)!;
    expect(result.allowed).toBe(true); expect(result.requestHash).toBe(taskEvidenceHash(raw)); expect(result).not.toHaveProperty('write');
  });
  it.each(['Do not read memory. Did you save the note?', "Do not save anything and don't access memory. Did you save the note?",
    'لا تحفظ أي شيء ولا تقرأ الذاكرة. هل حفظت الملاحظة؟'])('keeps read vetoes authoritative: %s', raw => {
    expect(recognizeUserFactMemoryVerificationRequest(raw)).toMatchObject({ allowed: false, reason: 'memory_read_forbidden' });
    expect(selectUserFactMemoryVerificationAnchor(raw, current, [], bracket.startedAt)).toMatchObject({ status: 'blocked', reason: 'memory_read_forbidden' });
  });
  it.each([null, '', {}, 'x'.repeat(4001), 'Did you save the result?', 'هل حفظت النتيجة؟', 'Did you save it?', 'Save the note.',
    'Can you save the note?', 'Will you save the note?', '"Did you save the note?"', 'The page says: Did you save the note?',
    'Translate: Did you save the note?', 'Did you save the note? Then open a page.', 'هل حفظت الملاحظة؟ ثم أرسلها',
    'Did you save the note? "Do not read memory"'])('does not reuse calculation, source, literal or action authority for %j', raw => {
    expect(recognizeUserFactMemoryVerificationRequest(raw)).toBeNull();
  });
});

describe('latest scoped exact user-note source and trusted metadata', () => {
  it('binds the original user note purpose, raw source hash and distinct DB creation/effective times', () => {
    const test = fixture();
    expect(test.receipt.payload.text).toBe(PAYLOAD);
    expect(test.anchor).toMatchObject({ sourceRunId: 'original-note-run', sourceCreatedAt: epoch, sourceEvaluatedAt: epoch,
      sourceOriginalRequestHash: taskEvidenceHash(SAVE), sourceRequestHash: taskEvidenceHash(SAVE), attemptedAt: epoch + 1000 });
    expect(test.source.current.runId).toBe('note-verification-current'); expect(test.source.flow.receipt.kind).toBe('current_user_literal_memory');
  });
  it('never scans past unrelated work or chooses an arbitrary timestamp tie', () => {
    const test = fixture(), unrelated = { ...test.row, id: 'unrelated-latest', goal: 'Calculate 7 + 8', createdAt: epoch + 2000, evaluatedAt: epoch + 2000, state: {} };
    expect(selectUserFactMemoryVerificationAnchor(QUESTION, current, [unrelated, test.row], bracket.startedAt)).toMatchObject({ status: 'blocked', reason: 'unrelated_prior_run' });
    expect(selectUserFactMemoryVerificationAnchor(QUESTION, current, [test.row, { ...test.row, id: 'tied-other' }], bracket.startedAt)).toMatchObject({ status: 'blocked', reason: 'ambiguous_latest' });
    expect(selectUserFactMemoryVerificationAnchor(QUESTION, current, [], bracket.startedAt)).toMatchObject({ status: 'blocked', reason: 'no_prior_run' });
  });
  it('uses an older legacy-clarified row only for recency, never as a source-provenance veto', () => {
    const test = fixture(), older = { ...test.row, id: 'older-legacy', goal: 'An old question', createdAt: epoch - 1000,
      evaluatedAt: epoch - 1000, state: { clarifiedRequest: 'A legacy answer without new source metadata' } };
    expect(selectUserFactMemoryVerificationAnchor(QUESTION, current, [test.row, older], bracket.startedAt)).toEqual({ status: 'selected', anchor: test.anchor });
    expect(selectUserFactMemoryVerificationAnchor(QUESTION, current, [older], bracket.startedAt).status).toBe('blocked');
    expect(selectUserFactMemoryVerificationAnchor(QUESTION, current, [test.row, { ...older, ownerId: 'foreign' }], bracket.startedAt).status).toBe('blocked');
  });
  it.each(['ownerId', 'conversationId', 'id', 'createdAt', 'evaluatedAt'] as const)('fails closed on a wrong source %s', key => {
    const test = fixture(), row = { ...test.row, [key]: key === 'id' ? current.runId : key === 'createdAt' || key === 'evaluatedAt' ? current.createdAt + 1 : 'foreign' };
    expect(selectUserFactMemoryVerificationAnchor(QUESTION, current, [row], bracket.startedAt).status).toBe('blocked');
    expect(restoreUserFactMemoryVerificationSource(QUESTION, current, test.anchor, row, bracket.startedAt)).toBeNull();
  });
  it.each(['running', 'waiting_user', 'waiting_input', 'waiting_approval'])('never resumes a %s task', status => {
    const test = fixture(); expect(selectUserFactMemoryVerificationAnchor(QUESTION, current, [{ ...test.row, status }], bracket.startedAt)).toMatchObject({ status: 'blocked', reason: 'active_prior_run' });
  });
  it('requires the separate DB-pinned original hash rather than recovering it from a valid receipt', () => {
    const test = fixture();
    const variants = [{ ...test.row, originalRequestHash: undefined }, { ...test.row, originalRequestHash: '0'.repeat(64) },
      { ...test.row, state: { userFactMemory: test.flow } }, { ...test.row, state: { requestOriginalHash: '0'.repeat(64), userFactMemory: test.flow } }];
    for (const row of variants) {
      expect(selectUserFactMemoryVerificationAnchor(QUESTION, current, [row], bracket.startedAt).status).toBe('blocked');
      expect(restoreUserFactMemoryVerificationSource(QUESTION, current, test.anchor, row, bracket.startedAt)).toBeNull();
    }
  });
  it.each([null, {}, { phase: 'unknown' }, 'saved'])('rejects malformed state %j without a source', stored => {
    const test = fixture(), row = { ...test.row, state: { requestOriginalHash: taskEvidenceHash(SAVE), userFactMemory: stored } };
    expect(selectUserFactMemoryVerificationAnchor(QUESTION, current, [row], bracket.startedAt).status).toBe('blocked');
  });
  it('rejects prepared, legacy acknowledged and calculation states even when they mention the same note', () => {
    const test = fixture(), calcRequest = 'Calculate 2 + 3, then remember the result.';
    const { originalRequestHash: _hash, ...calcBinding } = test.binding;
    const calc = createComputationMemoryReceipt(calcRequest, calcBinding)!;
    for (const state of [{ requestOriginalHash: taskEvidenceHash(SAVE), userFactMemory: { ...test.flow, phase: 'prepared', attemptedAt: undefined } },
      { memorySaves: 1, requestOriginalHash: taskEvidenceHash(SAVE), trail: [{ result: 'saved to memory' }] },
      { computationMemory: { version: 1, kind: 'calculation_memory_flow', phase: 'write_attempted', receipt: calc, attemptedAt: epoch + 1000 } },
      { requestOriginalHash: taskEvidenceHash(SAVE), userFactMemory: test.flow, computationMemory: null }])
      expect(selectUserFactMemoryVerificationAnchor(QUESTION, current, [{ ...test.row, state }], bracket.startedAt).status).toBe('blocked');
  });
  it('validates a clarified note at its DB message time and never substitutes the earlier run creation time', () => {
    const test = fixture(), evaluatedAt = epoch + 2000;
    const receipt = createUserFactMemoryReceipt(SAVE, { ...test.binding, evaluatedAt })!;
    const row = { ...test.row, goal: 'Remember it', evaluatedAt, state: { requestOriginalHash: taskEvidenceHash(SAVE), clarifiedRequest: SAVE,
      clarifiedRequestSource: createClarifiedRequestSource(SAVE, 'actual-user-message'), userFactMemory: { ...test.flow, receipt, attemptedAt: epoch + 3000 } } };
    const selected = selectUserFactMemoryVerificationAnchor(QUESTION, current, [row], bracket.startedAt);
    expect(selected.status).toBe('selected'); if (selected.status !== 'selected') throw new Error('Explicit source fixture rejected');
    expect(selected.anchor.sourceCreatedAt).toBe(epoch); expect(selected.anchor.sourceEvaluatedAt).toBe(evaluatedAt);
    expect(restoreUserFactMemoryVerificationSource(QUESTION, current, selected.anchor, row, bracket.startedAt)).not.toBeNull();
    for (const changed of [{ ...row, evaluatedAt: epoch }, { ...row, state: { ...row.state, clarifiedRequestSource: undefined } },
      { ...row, state: { ...row.state, clarifiedRequestSource: createClarifiedRequestSource('other text', 'actual-user-message') } }])
      expect(restoreUserFactMemoryVerificationSource(QUESTION, current, selected.anchor, changed, bracket.startedAt)).toBeNull();
  });
});

describe('flat note pointers are not permissions or old task state', () => {
  function repeated() {
    const test = fixture(), pointer = createUserFactMemoryVerificationState(QUESTION, current, test.anchor, { outcome: 'active', checkedAt: bracket.finishedAt })!;
    const prior: UserFactMemoryVerificationRun = { id: current.runId, ownerId: current.ownerId, conversationId: current.conversationId, goal: QUESTION,
      createdAt: current.createdAt, evaluatedAt: current.evaluatedAt, status: 'completed', state: { userFactMemoryVerification: pointer } };
    const next = { ...current, runId: 'next-note-verification', createdAt: epoch + 10000, evaluatedAt: epoch + 10000 };
    return { ...test, pointer, prior, next };
  }
  it('selects one original pointer but still requires reloading that exact original row', () => {
    const test = repeated(), selected = selectUserFactMemoryVerificationAnchor(QUESTION, test.next, [test.prior, test.row], epoch + 11000);
    expect(selected).toEqual({ status: 'selected', anchor: test.anchor });
    expect(restoreUserFactMemoryVerificationSource(QUESTION, test.next, test.anchor, test.row, epoch + 11000)).not.toBeNull();
    expect(restoreUserFactMemoryVerificationSource(QUESTION, test.next, test.anchor, test.prior, epoch + 11000)).toBeNull();
    expect(JSON.stringify(test.pointer)).not.toContain(PAYLOAD); expect(JSON.stringify(test.pointer)).not.toContain(SAVE);
    expect(test.pointer).not.toHaveProperty('userFactMemory'); expect(test.pointer).not.toHaveProperty('receipt');
  });
  it.each(['ownerId', 'conversationId', 'verificationRunId', 'verificationCreatedAt', 'verificationEvaluatedAt', 'verificationRequestHash'] as const)('validates the previous pointer own %s', key => {
    const test = repeated(), pointer = { ...test.pointer, [key]: key.endsWith('At') ? current.createdAt - 1 : key.endsWith('Hash') ? '0'.repeat(64) : 'foreign' };
    expect(selectUserFactMemoryVerificationAnchor(QUESTION, test.next, [{ ...test.prior, state: { userFactMemoryVerification: pointer } }], epoch + 11000).status).toBe('blocked');
  });
  it('requires a recognized previous question and never recursively follows a different pointer purpose', () => {
    const test = repeated();
    expect(selectUserFactMemoryVerificationAnchor(QUESTION, test.next, [{ ...test.prior, goal: 'Did you save the result?' }], epoch + 11000).status).toBe('blocked');
    expect(restoreUserFactMemoryVerificationSource(QUESTION, test.next, test.anchor, { ...test.row, state: { userFactMemoryVerification: test.pointer } }, epoch + 11000)).toBeNull();
    expect(restoreUserFactMemoryVerificationState({ ...test.pointer, kind: 'memory_verification' }, QUESTION, current)).toBeNull();
    expect(selectUserFactMemoryVerificationAnchor(QUESTION, test.next, [{ ...test.prior, state: { userFactMemoryVerification: { ...test.pointer,
      lastCheck: { outcome: 'active', checkedAt: test.next.createdAt + 1 } } } }], epoch + 11000).status).toBe('blocked');
  });
  it.each(['sourceRunId', 'sourceCreatedAt', 'sourceEvaluatedAt', 'sourceOriginalRequestHash', 'sourceRequestHash', 'receiptHash', 'operationKey', 'attemptedAt'] as const)('rechecks immutable source %s after exact reload', key => {
    const test = repeated(), value = test.anchor[key], changed = { ...test.anchor, [key]: typeof value === 'number' ? value + 1 : key === 'sourceRunId' ? 'other-original' : '0'.repeat(64) };
    expect(restoreUserFactMemoryVerificationSource(QUESTION, test.next, changed as UserFactMemoryVerificationAnchor, test.row, epoch + 11000)).toBeNull();
  });
});

describe('fresh manual persistence status only, without content echo', () => {
  it.each([QUESTION, 'هل حفظت الملاحظة؟'])('completes only the new read-answer criterion: %s', raw => {
    const test = fixture(raw), result = assessUserFactMemoryVerificationReadback(test.source, test.readback(), bracket);
    expect(result).toMatchObject({ scope: 'user_statement_memory_read_status_only', status: 'completed', persistence: 'verified', observation: {
      kind: 'answer_evidence', criterionId: 'user-note-status-answer', source: 'memory-read', outcome: 'confirmed', independentlyVerified: true } });
    expect(result.text).not.toContain(PAYLOAD); expect(result).not.toHaveProperty('receipt'); expect(result).not.toHaveProperty('readback');
    const supervisor = createUserFactMemoryVerificationSupervisor(raw, current, test.anchor)!;
    expect(supervisor.contract.id).toBe('note-verification-current'); expect(supervisor.contract.criteria.map(c => [c.kind, c.id])).toEqual([['answer_evidence', 'user-note-status-answer']]);
    expect(supervisor.contract.criteria[0]!.target).toBe(`memory-note-status:original-note-run:${test.commit.operationKey}`);
    expect(observeTaskStep(supervisor, { stepId: 'direct-note-reconcile', sequence: 1, tool: 'memory.reconcileExact', startedAt: bracket.startedAt,
      finishedAt: bracket.finishedAt, result: 'succeeded', observations: [result.observation!] }).accepted).toBe(true);
    expect(reviewTaskCompletion(supervisor, { now: bracket.finishedAt, answerHash: taskEvidenceHash(result.text) }).allowCompletion).toBe(true);
    expect(reviewTaskCompletion(supervisor, { now: bracket.finishedAt, answerHash: taskEvidenceHash('The original write and all prior tasks are completed.') }).allowCompletion).toBe(false);
  });
  it.each(['item_missing', 'item_inactive', 'item_expired', 'identity_mismatch', 'payload_mismatch', 'provenance_unavailable'] as const)('keeps %s partial and never resurrects old content', reason => {
    const test = fixture(), result = assessUserFactMemoryVerificationReadback(test.source, { status: 'unavailable', reason, receipt: test.commit }, bracket);
    expect(result).toMatchObject({ status: 'partial', persistence: 'unavailable' }); expect(result.observation).toBeUndefined(); expect(JSON.stringify(result)).not.toContain(PAYLOAD);
  });
  it.each([null, undefined, 'saved', { saved: true }, { status: 'missing' }])('never promotes uncertainty or a missing snapshot %j into success', value => {
    const test = fixture(), result = assessUserFactMemoryVerificationReadback(test.source, value, bracket);
    expect(result.status).toBe('partial'); expect(result.text).not.toContain(PAYLOAD); expect(result.text).not.toMatch(/never saved/iu); expect(result.observation).toBeUndefined();
  });
  it.each(['owner', 'payload', 'key', 'version', 'provenance', 'stale', 'future'] as const)('rejects a tampered %s read receipt', field => {
    const test = fixture(), value = test.readback();
    if (field === 'owner') value.receipt.ownerId = 'other-owner';
    if (field === 'payload') value.item.content = 'A different externally claimed note.';
    if (field === 'key') value.receipt.operationKey = '0'.repeat(64);
    if (field === 'version') value.item.version = 2;
    if (field === 'provenance') value.item.provenance[0]!.kind = 'observed' as 'manual';
    if (field === 'stale') value.observedAt = new Date(bracket.startedAt - 1).toISOString();
    if (field === 'future') value.observedAt = new Date(bracket.finishedAt + 1).toISOString();
    expect(assessUserFactMemoryVerificationReadback(test.source, value, bracket)).toMatchObject({ status: 'partial', reason: 'invalid_readback' });
  });
  it.each(['item', 'evidence'] as const)('does not describe %s expiry during the read interval as currently active', field => {
    const test = fixture(), value = test.readback(), expiry = new Date(bracket.startedAt + 50).toISOString();
    if (field === 'item') { value.receipt.expiresAt = expiry; value.item.expiresAt = expiry; }
    else value.item.provenance[0]!.expiresAt = expiry;
    const result = assessUserFactMemoryVerificationReadback(test.source, value, bracket);
    expect(result).toMatchObject({ status: 'partial', persistence: 'unavailable' }); expect(result.observation).toBeUndefined(); expect(result.text).not.toContain(PAYLOAD);
  });
  it('rechecks current read constraints, source recipe and the effective question time', () => {
    const test = fixture();
    expect(assessUserFactMemoryVerificationReadback({ ...test.source, request: 'Do not read memory. Did you save the note?' }, test.readback(), bracket).status).toBe('blocked');
    expect(assessUserFactMemoryVerificationReadback({ ...test.source, sourceRequest: 'Remember exactly this note: changed' }, test.readback(), bracket).status).toBe('blocked');
    expect(assessUserFactMemoryVerificationReadback({ ...test.source, current: { ...current, evaluatedAt: bracket.startedAt + 1 } }, test.readback(), bracket).reason).toBe('invalid_clock');
  });
});

describe('actual read-only user-note domain checks in fresh isolated PGlite', () => {
  async function domainFixture(age = 10000) {
    const store = await createDatabase({});
    await migrateAuth(store.db); await migrate(store.db); await memoryMigration(store.db);
    const ownerId = `readonly-note-${randomUUID()}`, conversationId = randomUUID(), runId = randomUUID();
    await store.db.insertInto('user').values({ id: ownerId, name: 'Synthetic note owner', email: `${ownerId}@example.test` }).execute();
    const createdAt = Date.now() - age, attemptedAt = createdAt + 1000;
    let clock = attemptedAt;
    const memory = createMemoryControl(store.db, { now: () => new Date(clock) });
    const binding = { ownerId, conversationId, runId, evaluatedAt: createdAt, originalRequestHash: taskEvidenceHash(SAVE) };
    const receipt = createUserFactMemoryReceipt(SAVE, binding)!;
    expect(receipt.payload.text).toBe(PAYLOAD);
    const row: UserFactMemoryVerificationRun = { id: runId, ownerId, conversationId, goal: SAVE, createdAt, evaluatedAt: createdAt,
      originalRequestHash: taskEvidenceHash(SAVE), status: 'interrupted', state: { requestOriginalHash: taskEvidenceHash(SAVE),
        userFactMemory: { version: 1, kind: 'user_fact_memory_flow', phase: 'unknown', reason: 'write_uncertain', receipt, attemptedAt } } };
    const verification = { ownerId, conversationId, runId: randomUUID(), createdAt: Date.now(), evaluatedAt: Date.now() };
    const selected = selectUserFactMemoryVerificationAnchor(QUESTION, verification, [row], Date.now());
    if (selected.status !== 'selected') throw new Error('Synthetic original failed selection');
    const source = restoreUserFactMemoryVerificationSource(QUESTION, verification, selected.anchor, row, Date.now())!;
    const writes = vi.fn(() => memory.writeExact(ownerId, { operationKey: receipt.operationKey, payload: PAYLOAD, payloadHash: taskEvidenceHash(PAYLOAD) }));
    const read = async () => {
      const startedAt = Date.now(); clock = Date.now();
      const result = await memory.reconcileExact(ownerId, { operationKey: selected.anchor.operationKey, payloadHash: taskEvidenceHash(PAYLOAD) });
      return { assessment: assessUserFactMemoryVerificationReadback(source, result, { startedAt, finishedAt: Date.now() }), result };
    };
    return { store, memory, ownerId, writes, read, setClock: (value: number) => { clock = value; }, attemptedAt };
  }
  it('confirms actual literal bytes with manual provenance without creating a new operation', async () => {
    const test = await domainFixture();
    try {
      await test.writes(); const { assessment, result } = await test.read();
      expect(result).toMatchObject({ status: 'verified', item: { content: PAYLOAD, confidenceKind: 'user_asserted', confidence: 0.5, provenance: [{ kind: 'manual', trust: 'manual' }] } });
      expect(assessment).toMatchObject({ scope: 'user_statement_memory_read_status_only', status: 'completed' }); expect(assessment.text).not.toContain(PAYLOAD);
      expect(test.writes).toHaveBeenCalledTimes(1);
      expect(await test.store.db.selectFrom('memory_exact_operations').select('operation_key').where('owner_id', '=', test.ownerId).execute()).toHaveLength(1);
    } finally { await test.store.close(); }
  });
  it.each(['remove', 'revoke'] as const)('does not restore or echo a note after real domain %s', async action => {
    const test = await domainFixture();
    try {
      const written = await test.writes(); test.setClock(Date.now());
      await test.memory[action](test.ownerId, written.receipt.itemId, { expectedVersion: 1, reason: 'Synthetic note owner removal' });
      for (let index = 0; index < 2; index++) {
        const { assessment } = await test.read(); expect(assessment).toMatchObject({ status: 'partial', persistence: 'unavailable' }); expect(JSON.stringify(assessment)).not.toContain(PAYLOAD);
      }
      expect(test.writes).toHaveBeenCalledTimes(1);
      expect(await test.store.db.selectFrom('memory_exact_operations').select('operation_key').where('owner_id', '=', test.ownerId).execute()).toHaveLength(1);
    } finally { await test.store.close(); }
  });
  it('does not label a historical committed but expired note active', async () => {
    const test = await domainFixture(190 * 86400000);
    try { await test.writes(); const { assessment } = await test.read(); expect(assessment).toMatchObject({ status: 'partial', persistence: 'unavailable' }); expect(assessment.text).not.toContain(PAYLOAD); }
    finally { await test.store.close(); }
  });
  it('allows a later original commit to become visible after a missing snapshot, without verifier writes', async () => {
    const test = await domainFixture();
    try {
      expect((await test.read()).assessment).toMatchObject({ status: 'partial', persistence: 'missing' }); expect(test.writes).not.toHaveBeenCalled();
      test.setClock(Date.now()); await test.writes();
      expect((await test.read()).assessment.status).toBe('completed'); expect(test.writes).toHaveBeenCalledTimes(1);
    } finally { await test.store.close(); }
  });
});
