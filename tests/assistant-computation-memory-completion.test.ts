import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import { createMemoryControl, memoryMigration } from '@mohassan/memory';
import { migrateAuth } from '../apps/server/src/auth.js';
import { runComputationMemoryFlow } from '../apps/server/src/assistant/computation-memory-flow.js';
import { completeComputationMemory } from '../apps/server/src/assistant/computation-memory-completion.js';
import { createChatSupervisor } from '../apps/server/src/assistant/chat-supervision.js';
import { createTaskSupervisor, reviewTaskCompletion, taskEvidenceHash, type TaskCriterion, type TaskSupervisorState } from '../apps/server/src/assistant/task-supervisor.js';

let store: Awaited<ReturnType<typeof createDatabase>>;
beforeAll(async () => { store = await createDatabase({}); await migrateAuth(store.db); await migrate(store.db); await memoryMigration(store.db); });
afterAll(async () => { await store?.close(); });

/** Actual exact-write/domain readback; no provider, browser, external data or owner account. */
async function fixture(valueOnly = false) {
  const now = Date.now(), ownerId = `completion-owner-${randomUUID()}`;
  await store.db.insertInto('user').values({ id: ownerId, name: 'Synthetic completion owner', email: `${ownerId}@example.test` }).execute();
  const request = `Calculate 2 + 3, then remember the result.${valueOnly ? ' Only the result.' : ''}`;
  const binding = { ownerId, conversationId: `completion-chat-${randomUUID()}`, runId: `completion-run-${randomUUID()}`, evaluatedAt: now - 1000 };
  const memory = createMemoryControl(store.db, { now: () => new Date(now) });
  const result = await runComputationMemoryFlow({ request, binding, policy: { accountAllowed: true, quota: { used: 0, limit: 3 } } }, {
    signal: new AbortController().signal, assertActive: async () => {}, isExecutionEnded: () => false, checkpoint: async () => {}, scrubExact: value => value, now: () => now,
    writeExact: (owner, input) => memory.writeExact(owner, input), reconcileExact: (owner, input) => memory.reconcileExact(owner, input),
  });
  expect(result.status).toBe('verified');
  const supervision = createChatSupervisor(binding.runId, request, undefined, now - 1, binding);
  return { result, binding, request, now, supervision, input: { result, binding, request, startedAt: now - 1, now } };
}
const altered = (test: Awaited<ReturnType<typeof fixture>>, criteria: TaskCriterion[], extra: { id?: string; objective?: string; revision?: number } = {}) =>
  createTaskSupervisor({ id: test.binding.runId, objective: test.request, now: test.now - 1, criteria, ...extra });

describe('calculation-memory completion requires the exact full-goal contract', () => {
  it('completes only after actual persisted readback verifies both host-declared criteria', async () => {
    const test = await fixture();
    const answer = completeComputationMemory(test.supervision, test.input);
    expect(answer).toEqual({ status: 'completed', text: '2 + 3 = 5\nSaved the verified result in your memory.' });
    expect(reviewTaskCompletion(test.supervision, { now: test.now, answerHash: taskEvidenceHash(answer.text) })).toMatchObject({ status: 'verified', allowCompletion: true, missingCriteria: [] });
    expect(test.supervision.steps.at(-1)?.observations.map(item => item.criterionId).sort()).toEqual(['computed-answer', 'computed-memory-save']);
  });

  it('preserves the exact scalar display while the actual stored payload keeps explanatory context', async () => {
    const test = await fixture(true), answer = completeComputationMemory(test.supervision, test.input);
    expect(answer).toEqual({ status: 'completed', text: '5' });
    expect(test.result.readback?.item.content).toBe('2 + 3 = 5');
  });

  it.each(['unscoped', 'computed_only', 'effect_only'] as const)('does not promote a valid persistence result through a %s contract', async mode => {
    const test = await fixture();
    const criteria = mode === 'unscoped' ? [] : test.supervision.contract.criteria.filter(item => item.kind === (mode === 'computed_only' ? 'answer_evidence' : 'effect'));
    const wrong = altered(test, criteria);
    expect(completeComputationMemory(wrong, test.input).status).toBe('partial');
  });

  it.each(['computed-answer', 'computed-memory-save'])('requires %s to remain a required criterion', async id => {
    const test = await fixture();
    const wrong = altered(test, test.supervision.contract.criteria.map(item => ({ ...item, required: item.id === id ? false : item.required })));
    expect(completeComputationMemory(wrong, test.input).status).toBe('partial');
  });

  it.each(['run', 'objective', 'revision', 'computed_target', 'effect_target', 'effect_expectation'] as const)('rejects a stale/mismatched %s contract', async field => {
    const test = await fixture();
    const criteria = test.supervision.contract.criteria.map(item => field === 'computed_target' && item.kind === 'answer_evidence' ? { ...item, target: 'computation:another-request' }
      : field === 'effect_target' && item.kind === 'effect' ? { ...item, target: 'memory:result:another-operation' }
        : field === 'effect_expectation' && item.kind === 'effect' ? { ...item, expectationHash: '0'.repeat(64) } : item);
    const wrong = altered(test, criteria, field === 'run' ? { id: 'another-run' } : field === 'objective' ? { objective: 'Calculate 8 + 2, then remember the result.' }
      : field === 'revision' ? { revision: 2 } : {});
    expect(completeComputationMemory(wrong, test.input).status).toBe('partial');
  });

  it('keeps an unresolved effect explicit even when the requested display was scalar-only', async () => {
    const test = await fixture(true);
    const result = { ...test.result, status: 'partial' as const, persistence: 'unknown' as const, readback: undefined };
    const answer = completeComputationMemory(test.supervision, { ...test.input, result });
    expect(answer.status).toBe('partial');
    expect(answer.text).toBe('5\nI could not confirm that the result was saved in memory. I did not repeat the write.');
  });

  it('cannot substitute a wrong-owner receipt or stale/future readback for the current flow', async () => {
    for (const change of ['owner', 'past', 'future'] as const) {
      const test = await fixture();
      const result = structuredClone(test.result);
      if (change === 'owner') result.receipt!.ownerId = 'another-owner';
      else result.readback!.observedAt = new Date(test.now + (change === 'past' ? -5000 : 5000)).toISOString();
      expect(completeComputationMemory(test.supervision, { ...test.input, result }).status).toBe('partial');
    }
  });
});
