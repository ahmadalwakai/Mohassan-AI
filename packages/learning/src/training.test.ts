import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrate, type DatabaseHandle } from '@mohassan/database';
import { recordExperience } from './experience.ts';
import { evaluationCases } from './evaluation.ts';
import { auditTrainingReadiness, prepareRoutingTrainingDataset } from './training.ts';
import { safetyHoldoutV4Cases } from './safety-v4.ts';
import { safetyHoldoutV5Cases } from './safety-v5.ts';
import { memoryTrainingCases } from './memory-training.ts';
import { readTrainingCases } from './read-training.ts';

describe('training readiness audit', () => {
  let store: DatabaseHandle;
  beforeAll(async () => { store = await createDatabase(); await migrate(store.db); });
  afterAll(async () => { await store?.close(); });
  async function add(goal: string, extras: { sourceId?: string; ownerId?: string; outcome?: 'success' | 'failure' | 'unverified' } = {}) {
    const expected = { kind: 'test_result' as const, target: 'verified-fixture', value: true };
    await recordExperience(store.db, { ownerId: extras.ownerId ?? 'owner', sourceKind: 'runtime_task', sourceId: extras.sourceId ?? randomUUID(), goal, category: 'coding', terminalStatus: 'completed',
      expected: extras.outcome === 'unverified' ? undefined : expected,
      observation: extras.outcome === 'unverified' ? undefined : { ...expected, value: extras.outcome !== 'failure', reference: randomUUID() },
    });
  }
  it('reports real counts without leaking goals, excludes evaluation/secrets/duplicates and refuses missing role targets', async () => {
    await add('Fix isolated module alpha'); await add('Fix isolated module alpha'); await add(evaluationCases[0].prompt);
    await add('Fix isolated module beta', { sourceId: 'eval-run-123' }); await add('Fix isolated module gamma', { sourceId: 'reserved-test' });
    await add('Fix module with password=privatecredential123'); await add('Unverified result', { outcome: 'unverified' }); await add('Failure result', { outcome: 'failure' });
    await add('Other owner success', { ownerId: 'other' });
    const result = await auditTrainingReadiness(store.db, 'owner', { excludedSourceIds: new Set(['reserved-test']) });
    expect(result.counts).toEqual({ total: 8, verifiedSuccess: 6, verifiedFailure: 1, unverified: 1, scannedSuccesses: 6 });
    expect(result.exclusions).toEqual({ evaluation: 3, secrets: 1, incompleteEvidence: 0, emptyGoal: 0, duplicates: 1, nonCompleted: 0, invalidCategory: 0, conflictingLabels: 0 });
    expect(result.roles.routing).toMatchObject({ eligibleUnique: 1, ready: false });
    expect(result.roles.tool_call).toMatchObject({ eligibleUnique: 0, ready: false });
    expect(result.roles.arabic_style).toMatchObject({ eligibleUnique: 0, ready: false });
    expect(JSON.stringify(result)).not.toContain('Fix isolated'); expect(result.trainingStarted).toBe(false);
    expect((await auditTrainingReadiness(store.db, 'other')).counts.total).toBe(1);
  });
  it('requires all 500 unique verified examples and never starts training when the data threshold is met', async () => {
    for (let index = 0; index < 499; index++) await add(`Repair independently verified fixture module ${index}`, { ownerId: 'threshold' });
    expect((await auditTrainingReadiness(store.db, 'threshold')).roles.routing).toMatchObject({ eligibleUnique: 499, ready: false });
    await add('Repair independently verified fixture module 499', { ownerId: 'threshold' });
    const result = await auditTrainingReadiness(store.db, 'threshold');
    expect(result.roles.routing).toMatchObject({ eligibleUnique: 500, ready: true, reason: 'DATA_THRESHOLD_MET_REQUIRES_TRAINING_ENVIRONMENT_AND_EVALUATION' });
    expect(result.trainingStarted).toBe(false);
    const exported = await prepareRoutingTrainingDataset(store.db, 'threshold');
    expect(exported.status).toBe('prepared');
    expect(exported.dataset?.manifest).toMatchObject({ count: 500, trainingCount: 400, validationCount: 100, dataHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(exported.dataset?.rows).toHaveLength(500);
    expect(exported.dataset?.rows[0].split).toBe('training'); expect(exported.dataset?.rows.at(-1)?.split).toBe('validation');
    expect(exported.dataset?.rows.every(row => row.target === 'coding')).toBe(true);
    expect((await prepareRoutingTrainingDataset(store.db, 'threshold')).dataset?.manifest.dataHash).toBe(exported.dataset?.manifest.dataHash);
    const training = new Set(exported.dataset!.rows.filter(row => row.split === 'training').map(row => row.input));
    expect(exported.dataset!.rows.filter(row => row.split === 'validation').some(row => training.has(row.input))).toBe(false);
    expect(JSON.stringify(exported.dataset)).not.toContain('source_id');
    expect(exported.readiness.trainingStarted).toBe(false);
  });
  it('refuses export below the real data threshold and excludes all evaluation suites and descendants', async () => {
    const ownerId = 'contamination';
    for (const test of [safetyHoldoutV4Cases[0], safetyHoldoutV5Cases[0], memoryTrainingCases[0], readTrainingCases[0]]) await add(test.prompt, { ownerId });
    await add('An evaluation task with an unrelated goal', { ownerId, sourceId: safetyHoldoutV5Cases[1].id });
    await add('A child of a reserved benchmark', { ownerId, sourceId: 'child-task' });
    await store.db.updateTable('experiences').set({ parent_run_id: 'benchmark:parent' }).where('owner_id', '=', ownerId).where('source_id', '=', 'child-task').execute();
    await recordExperience(store.db, { ownerId, sourceKind: 'chat_run', sourceId: 'arbitrary-parent-id', goal: safetyHoldoutV4Cases[1].prompt, category: 'conversation', terminalStatus: 'failed' });
    await add('A child with an ordinary-looking parent ID', { ownerId, sourceId: 'other-child' });
    await store.db.updateTable('experiences').set({ parent_run_id: 'arbitrary-parent-id' }).where('owner_id', '=', ownerId).where('source_id', '=', 'other-child').execute();
    await add('Real independently observed result', { ownerId });
    const result = await prepareRoutingTrainingDataset(store.db, ownerId);
    expect(result).toMatchObject({ status: 'blocked', dataset: null, readiness: { roles: { routing: { eligibleUnique: 1, ready: false } }, exclusions: { evaluation: 7 } } });
    expect(JSON.stringify(result)).not.toContain('Real independently observed');
  });
  it('rejects partial successes, contradictory labels and malformed evidence from training', async () => {
    const ownerId = 'quality';
    await add('A partially completed operation', { ownerId, sourceId: 'partial' });
    await store.db.updateTable('experiences').set({ terminal_status: 'partial' }).where('owner_id', '=', ownerId).where('source_id', '=', 'partial').execute();
    await add('Same request with conflicting route', { ownerId, sourceId: 'route-a' });
    await add('Same request with conflicting route', { ownerId, sourceId: 'route-b' });
    await store.db.updateTable('experiences').set({ category: 'research' }).where('owner_id', '=', ownerId).where('source_id', '=', 'route-b').execute();
    await add('A result with an invalid proof', { ownerId, sourceId: 'invalid-proof' });
    await store.db.updateTable('experiences').set({ evidence: JSON.stringify({ expectedHash: 'a'.repeat(64), observedHash: 'b'.repeat(64) }) as any }).where('owner_id', '=', ownerId).where('source_id', '=', 'invalid-proof').execute();
    const result = await auditTrainingReadiness(store.db, ownerId);
    expect(result.roles.routing.eligibleUnique).toBe(0);
    expect(result.exclusions).toMatchObject({ nonCompleted: 1, conflictingLabels: 2, incompleteEvidence: 1 });
  });
  it('does not export another owner data or a secret discovered by the current redactor', async () => {
    const ownerId = 'current-policy'; await add('A confidential project called localprivatevalue', { ownerId });
    const result = await prepareRoutingTrainingDataset(store.db, ownerId, { redact: value => value.replace('localprivatevalue', '[redacted]') });
    expect(result.dataset).toBeNull(); expect(result.readiness.exclusions.secrets).toBe(1);
    expect(JSON.stringify(result)).not.toContain('localprivatevalue');
    expect((await prepareRoutingTrainingDataset(store.db, 'absent-owner')).readiness.counts.total).toBe(0);
  });
});
