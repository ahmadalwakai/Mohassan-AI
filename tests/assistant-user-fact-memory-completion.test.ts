import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import { createMemoryControl, memoryMigration } from '@mohassan/memory';
import { migrateAuth } from '../apps/server/src/auth.js';
import { runUserFactMemoryFlow, type UserFactMemoryFlowResult } from '../apps/server/src/assistant/user-fact-memory-flow.js';
import { createUserFactMemorySupervisor, completeUserFactMemory } from '../apps/server/src/assistant/user-fact-memory-completion.js';
import { createComputationMemoryReceipt } from '../apps/server/src/assistant/computation-memory-receipt.js';
import { createTaskSupervisor, reviewTaskCompletion, taskEvidenceHash, type TaskCriterion } from '../apps/server/src/assistant/task-supervisor.js';

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const EN = 'Remember that I prefer Arabic.';
let store: Awaited<ReturnType<typeof createDatabase>>;
beforeAll(async () => { store = await createDatabase({}); await migrateAuth(store.db); await migrate(store.db); await memoryMigration(store.db); });
afterAll(async () => { await store?.close(); });

/** Actual write + independent domain readback. No model, browser, owner account, network or training data. */
async function fixture(request = EN) {
  const now = Date.now(), ownerId = `user-fact-completion-${randomUUID()}`;
  await store.db.insertInto('user').values({ id: ownerId, name: 'Synthetic literal-note owner', email: `${ownerId}@example.test` }).execute();
  const binding = { ownerId, conversationId: `chat-${randomUUID()}`, runId: `run-${randomUUID()}`,
    evaluatedAt: now - 1000, originalRequestHash: hash(request) };
  const memory = createMemoryControl(store.db, { now: () => new Date(now) });
  const result = await runUserFactMemoryFlow({ request, binding, policy: { accountAllowed: true, quota: { used: 0, limit: 3 } } }, {
    signal: new AbortController().signal, assertActive: async () => {}, isExecutionEnded: () => false,
    checkpoint: async () => {}, scrubExact: text => text, now: () => now,
    writeExact: (owner, input) => memory.writeExact(owner, input), reconcileExact: (owner, input) => memory.reconcileExact(owner, input),
  });
  expect(result.status).toBe('verified'); expect(result.readback?.status).toBe('verified');
  const supervision = createUserFactMemorySupervisor(request, binding, now - 1)!;
  expect(supervision).not.toBeNull();
  return { request, binding, now, result, supervision, input: { request, binding, result, startedAt: now - 1, now } };
}
function altered(f: Awaited<ReturnType<typeof fixture>>, criteria: TaskCriterion[], id = f.binding.runId) {
  return createTaskSupervisor({ id, objective: f.request, mode: 'advisory', now: f.now - 1, criteria });
}
function notSaved(answer: ReturnType<typeof completeUserFactMemory>) {
  expect(answer.status).not.toBe('completed'); expect(answer.text).toBe('I could not confirm that the note was saved in memory. I did not repeat the write.');
}

describe('current-user literal-note completion boundary', () => {
  it('uses a fixed language-preference summary after real exact persistence, with one required effect criterion', async () => {
    const f = await fixture(), answer = completeUserFactMemory(f.supervision, f.input);
    expect(answer).toEqual({ status: 'completed', text: 'Saved your language preference in your memory.' });
    expect(f.result.readback?.item.content).toBe('I prefer Arabic.');
    expect(f.supervision.contract.criteria).toEqual([expect.objectContaining({ id: 'user-fact-memory-save', kind: 'effect', required: true,
      target: `memory:user-assertion:${f.result.receipt!.operationKey}`, expectationHash: hash('I prefer Arabic.') })]);
    expect(reviewTaskCompletion(f.supervision, { now: f.now, answerHash: taskEvidenceHash(answer.text) }))
      .toMatchObject({ status: 'verified', allowCompletion: true, missingCriteria: [] });
    expect(f.supervision.steps.at(-1)?.observations).toEqual([expect.objectContaining({ kind: 'effect', source: 'authoritative-readback',
      independentlyVerified: true, outcome: 'confirmed', reference: `memory:${f.result.readback!.item.id}:1` })]);
  });
  it('renders the Arabic preference summary from host facts without repeating or translating the stored bytes', async () => {
    const f = await fixture('تذكر أنني أفضل العربية'), answer = completeUserFactMemory(f.supervision, f.input);
    expect(answer).toEqual({ status: 'completed', text: 'حفظت تفضيل اللغة في ذاكرتك.' });
    expect(f.result.readback?.item.content).toBe('أنني أفضل العربية');
  });
  it('confirms persistence of an assertion without claiming its factual truth or turning it into computed evidence', async () => {
    const payload = 'The fixture moon is made of cheese.';
    const f = await fixture(`Remember exactly this note: "${payload}"`), answer = completeUserFactMemory(f.supervision, f.input);
    expect(answer).toEqual({ status: 'completed', text: 'Saved your note in your memory.' });
    expect(f.result.scope).toBe('current_user_assertion_persistence_only');
    expect(f.result.readback?.item).toMatchObject({ content: payload, confidenceKind: 'user_asserted', confidence: 0.5 });
    expect(f.result.readback?.item.provenance).toEqual([expect.objectContaining({ kind: 'manual', trust: 'manual' })]);
    expect(f.supervision.steps.at(-1)?.observations.every(observation => observation.kind === 'effect')).toBe(true);
    expect(answer.text).not.toMatch(/true|correct|factual|calculated|verified fact/iu);
  });

  it.each(['empty', 'unrelated_advisory', 'missing_criterion', 'wrong_effect_key', 'wrong_payload_hash', 'not_required', 'wrong_run'] as const)
    ('does not promote actual readback under a mismatched %s contract', async variant => {
      const f = await fixture(); let criteria = structuredClone(f.supervision.contract.criteria);
      if (variant === 'empty') criteria = [];
      else if (variant === 'unrelated_advisory') criteria = [{ id: 'ordinary-answer', kind: 'answer_evidence', required: true,
        target: 'fact:another-question', maxAgeMs: 60_000, description: 'Advisory factual-answer contract unrelated to a memory write.' }];
      else if (variant === 'missing_criterion') criteria = criteria.map(item => ({ ...item, id: 'another-effect' }));
      else if (variant === 'wrong_effect_key') criteria = criteria.map(item => ({ ...item, target: 'memory:user-assertion:another-operation' }));
      else if (variant === 'wrong_payload_hash') criteria = criteria.map(item => item.kind === 'effect' ? { ...item, expectationHash: '0'.repeat(64) } : item);
      else if (variant === 'not_required') criteria = [...criteria.map(item => ({ ...item, required: false })), {
        id: 'another-required-effect', kind: 'effect', required: true, target: 'memory:unrelated', expectationHash: '1'.repeat(64), maxAgeMs: 60_000, description: 'Another required effect.' }];
      const wrong = altered(f, criteria, variant === 'wrong_run' ? `other-${f.binding.runId}` : f.binding.runId);
      expect(completeUserFactMemory(wrong, f.input).status).toBe('partial');
      expect(wrong.steps.at(-1)?.observations).toEqual([]);
    });

  it.each(['scope', 'owner', 'payload', 'manual_trust', 'expired'] as const)('rejects a forged or expired %s readback despite verified outer flags', async variant => {
    const f = await fixture(), result = structuredClone(f.result); let startedAt = f.input.startedAt, now = f.now;
    if (variant === 'scope') (result.readback as unknown as { scope: string }).scope = 'whole_goal_verified';
    else if (variant === 'owner') result.readback!.receipt.ownerId = `another-${randomUUID()}`;
    else if (variant === 'payload') result.readback!.item.content = 'A different statement that was not authorized.';
    else if (variant === 'manual_trust') result.readback!.item.provenance[0]!.trust = 'observed';
    else {
      // Coherent fresh observation after the ORIGINAL commit/item expiry, not
      // merely a mismatching expiry string or an observation outside the bracket.
      now = Date.parse(result.readback!.receipt.expiresAt) + 1; startedAt = now - 1;
      result.readback!.observedAt = new Date(now).toISOString();
      if (result.state?.phase !== 'verified') throw new Error('Fixture lacks a real verified state.');
      result.state.verification.observedAt = result.readback!.observedAt;
    }
    notSaved(completeUserFactMemory(f.supervision, { ...f.input, result, startedAt, now }));
  });

  it.each(['payload_span', 'raw_input_hash', 'calculation_receipt'] as const)('rejects a substituted %s purpose receipt', async variant => {
    const f = await fixture(), result = structuredClone(f.result);
    if (variant === 'payload_span') {
      result.receipt!.payloadSpan.start++; result.receipt!.payloadSpan.hash = hash(f.request.slice(result.receipt!.payloadSpan.start, result.receipt!.payloadSpan.end));
    } else if (variant === 'raw_input_hash') result.receipt!.originalRequestHash = hash('A different original raw request.');
    else {
      const computation = createComputationMemoryReceipt('Calculate 2 + 3, then remember the result.', {
        ownerId: f.binding.ownerId, conversationId: f.binding.conversationId, runId: f.binding.runId, evaluatedAt: f.binding.evaluatedAt,
      });
      expect(computation).not.toBeNull();
      (result as unknown as { receipt: unknown }).receipt = computation;
      if (result.state) (result.state as unknown as { receipt: unknown }).receipt = computation;
    }
    notSaved(completeUserFactMemory(f.supervision, { ...f.input, result }));
  });

  it('does not treat an actual commit identity and verified state snapshot as fresh readback', async () => {
    const f = await fixture(), result = { ...f.result, readback: undefined };
    expect(result.state?.phase).toBe('verified');
    notSaved(completeUserFactMemory(f.supervision, { ...f.input, result }));
  });
  it('rejects a cross-purpose outer result scope even when its actual item and receipt are valid', async () => {
    const f = await fixture(), result = { ...f.result, scope: 'calculation_memory_persistence_only' } as unknown as UserFactMemoryFlowResult;
    notSaved(completeUserFactMemory(f.supervision, { ...f.input, result }));
  });
});
