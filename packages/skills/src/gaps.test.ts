import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SkillGapObservationSchema, SkillGapQuerySchema, type SkillGapSignal } from '../../contracts/src/skill-gaps.ts';
import { commandChatMigration } from '../../../apps/server/src/command-chat.ts';
import { executionFixture } from '../../../tests/helpers/skill-execution.ts';
import { classifyGap, listSkillGaps, recordSkillGap } from './gaps.ts';
import { skillsMigration } from './migration.ts';

describe('evidence-based gap classification', () => {
  it.each([
    ['planner', 'SKILL_NOT_FOUND', 'missing_skill'],
    ['planner', 'tool_unavailable', 'missing_tool'],
    ['planner', 'tool_not_granted', 'missing_permission'],
    ['model', 'RESPONSE_TOO_LARGE', 'model_limitation'],
    ['planner', 'SKILL_COMPOSITION_INVALID', 'invalid_plan'],
    ['tool', 'AGENT_REF_STALE', 'stale_data'],
    ['environment', 'MODEL_UNAVAILABLE', 'environment_failure'],
    ['planner', 'isolation_gates_closed', 'sandbox_restriction'],
  ] as const)('classifies the known %s/%s fact as %s', (source, code, category) => {
    const classified = classifyGap({ source, code });
    expect(classified).toMatchObject({ category, reason: code, signal: { source, code }, action: { automatic: false } });
  });

  it.each([
    ['planner', 'tool_unavailable', 'missing_tool'], ['planner', 'tool_not_granted', 'missing_permission'],
    ['environment', 'NOT_CONFIGURED', 'environment_failure'], ['model', 'SCHEMA_TOO_LARGE', 'model_limitation'],
    ['planner', 'skill_inspection_stale', 'stale_data'], ['planner', 'SKILL_INSPECTION_FAILED', 'invalid_plan'],
    ['planner', 'SKILL_EXECUTABLE_GATES_CLOSED', 'sandbox_restriction'], ['tool', 'SKILL_TOOL_UNAVAILABLE', 'missing_tool'],
    ['tool', 'ASSISTANT_REF_UNKNOWN', 'invalid_plan'], ['tool', 'AGENT_APPROVAL_STALE', 'stale_data'],
    ['environment', 'PERMISSION_DENIED', 'environment_failure'], ['workflow', 'APPROVAL_REQUIRED', 'missing_permission'],
    ['planner', 'SKILL_TOOL_UNDECLARED', 'invalid_plan'], ['planner', 'SKILL_MODEL_SCOPE_REQUIRED', 'invalid_plan'],
    ['planner', 'SKILL_MODEL_PERMISSION_REQUIRED', 'invalid_plan'], ['tool', 'SKILL_TOOL_PERMISSION_REQUIRED', 'missing_permission'],
    ['planner', 'missing_skill_dependency', 'missing_skill'], ['planner', 'type_mismatch', 'invalid_plan'],
    ['planner', 'declared_conflict', 'invalid_plan'],
  ] as const)('keeps similar causes distinct for %s/%s', (source, code, category) => {
    expect(classifyGap({ source, code }).category).toBe(category);
  });

  it.each([
    null, { source: 'tool', code: 'AGENT_NETWORK_DENIED' }, { source: 'environment', code: 'INVALID_RESPONSE' },
    { source: 'model', code: 'MODEL_MISMATCH' }, { source: 'model', code: 'SKILL_NOT_FOUND' },
    { source: 'tool', code: 'private_token_value' }, { source: 'tool', code: 'UNKNOWN', message: 'missing_tool private secret' },
  ])('does not infer a cause from ambiguous, unknown, untrusted or extra text: %j', signal => {
    expect(classifyGap(signal as SkillGapSignal)).toMatchObject({ category: null, reason: 'insufficient_evidence', signal: null, action: { kind: 'inspect_evidence', automatic: false } });
  });

  it.each([{ source: 'workflow', code: 'EFFECT_UNKNOWN' }, { source: 'tool', code: 'AGENT_EFFECT_UNKNOWN' }] as const)('preserves unknown-effect evidence without inventing its cause or offering an automatic retry: %j', signal => {
    const result = classifyGap(signal);
    expect(result).toMatchObject({ category: null, reason: signal.code, signal, action: { kind: 'inspect_evidence', automatic: false } });
  });
  it('bounds public queries and accepts only terminal gap observations without raw user text', () => {
    expect(SkillGapQuerySchema.parse({})).toEqual({ limit: 20, offset: 0 });
    for (const query of [{ limit: 51 }, { limit: 0 }, { offset: -1 }, { offset: 100001 }, { category: 'invented' }, { text: 'secret' }]) expect(SkillGapQuerySchema.safeParse(query).success).toBe(false);
    expect(SkillGapObservationSchema.safeParse({ ownerId: 'fixture', chatRunId: randomUUID(), outcome: 'completed', signal: null }).success).toBe(false);
    expect(SkillGapObservationSchema.safeParse({ ownerId: 'fixture', chatRunId: randomUUID(), outcome: 'blocked', signal: null, goal: 'private' }).success).toBe(false);
  });
  it('recommends content review for a failed inspection rather than service configuration', () => {
    expect(classifyGap({ source: 'planner', code: 'SKILL_INSPECTION_FAILED' })).toMatchObject({ category: 'invalid_plan', action: { kind: 'review_skill_library', automatic: false } });
  });
});

describe('transactional owner-scoped gap persistence', () => {
  let f: Awaited<ReturnType<typeof executionFixture>>;
  beforeAll(async () => { f = await executionFixture(); await commandChatMigration(f.store.db); });
  afterAll(async () => { await f?.store.close(); });
  async function chat(ownerId = f.owner, status = 'blocked', conversationOwner = ownerId) {
    const conversation = randomUUID(), run = randomUUID();
    await f.store.db.insertInto('chat_conversations').values({ id: conversation, owner_id: conversationOwner, title: 'Fixture metadata', status: 'idle' }).execute();
    await f.store.db.insertInto('chat_runs').values({ id: run, conversation_id: conversation, owner_id: ownerId, status, goal: 'Private fixture text must never enter skill_gaps.', lease_token: randomUUID(), lease_expires_at: new Date(Date.now() + 10000) }).execute();
    return run;
  }
  const save = (input: Parameters<typeof recordSkillGap>[1]) => f.store.db.transaction().execute(tx => recordSkillGap(tx, input));

  it('records one metadata row and audit event even under concurrent duplicate observations', async () => {
    const chatRunId = await chat(), observation = { ownerId: f.owner, chatRunId, outcome: 'blocked' as const, signal: { source: 'planner' as const, code: 'SKILL_NOT_FOUND' } };
    await Promise.all([save(observation), save(observation), save(observation)]);
    const rows = await f.store.db.selectFrom('skill_gaps').selectAll().where('chat_run_id', '=', chatRunId).execute();
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ category: 'missing_skill', outcome: 'blocked' });
    expect(JSON.stringify(rows)).not.toContain('Private fixture text');
    expect(await f.store.db.selectFrom('skill_audit').select('id').where('target_id', '=', chatRunId).where('event', '=', 'skill.gap_recorded').execute()).toHaveLength(1);
    await save({ ...observation, signal: null });
    expect((await f.store.db.selectFrom('skill_gaps').select('category').where('chat_run_id', '=', chatRunId).executeTakeFirstOrThrow()).category).toBe('missing_skill');
  });

  it('keeps the gap, audit and chat outcome within the caller transaction', async () => {
    const chatRunId = await chat(f.owner, 'running');
    await expect(f.store.db.transaction().execute(async tx => {
      await tx.updateTable('chat_runs').set({ status: 'failed' }).where('id', '=', chatRunId).execute();
      await recordSkillGap(tx, { ownerId: f.owner, chatRunId, outcome: 'failed', signal: { source: 'environment', code: 'NETWORK_ERROR' } });
      throw new Error('Controlled transaction abort');
    })).rejects.toThrow('Controlled transaction abort');
    expect((await f.store.db.selectFrom('chat_runs').select('status').where('id', '=', chatRunId).executeTakeFirstOrThrow()).status).toBe('running');
    expect(await f.store.db.selectFrom('skill_gaps').select('id').where('chat_run_id', '=', chatRunId).execute()).toEqual([]);
    expect(await f.store.db.selectFrom('skill_audit').select('id').where('target_id', '=', chatRunId).execute()).toEqual([]);
  });

  it('requires matching run ownership, conversation ownership and actual terminal status', async () => {
    for (const chatRunId of [await chat('foreign-owner'), await chat(f.owner, 'running'), await chat(f.owner, 'completed'), await chat(f.owner, 'blocked', 'foreign-owner')]) {
      await expect(save({ ownerId: f.owner, chatRunId, outcome: 'blocked', signal: null })).rejects.toMatchObject({ code: 'SKILL_GAP_RUN_INVALID' });
    }
  });

  it('refuses unowned task and skill references instead of leaking or trusting them', async () => {
    for (const reference of [{ taskId: randomUUID() }, { skillVersionId: randomUUID() }]) {
      const chatRunId = await chat();
      await expect(save({ ownerId: f.owner, chatRunId, outcome: 'blocked', signal: { source: 'workflow', code: 'APPROVAL_REQUIRED', ...reference } }))
        .rejects.toMatchObject({ code: 'SKILL_GAP_REFERENCE_INVALID' });
      expect(await f.store.db.selectFrom('skill_gaps').select('id').where('chat_run_id', '=', chatRunId).execute()).toEqual([]);
    }
  });

  it('records insufficient evidence without retaining an arbitrary code or claiming a cause', async () => {
    const chatRunId = await chat(f.owner, 'failed');
    await save({ ownerId: f.owner, chatRunId, outcome: 'failed', signal: { source: 'tool', code: 'private_token_value' } });
    expect(await f.store.db.selectFrom('skill_gaps').select(['category', 'reason', 'signal']).where('chat_run_id', '=', chatRunId).executeTakeFirstOrThrow())
      .toEqual({ category: null, reason: 'insufficient_evidence', signal: null });
  });

  it('does not retain a pending-approval diagnosis after the owned task changes state', async () => {
    const task = await f.parent({ plan: { nodes: [{ id: 'main', skillId: randomUUID(), inputs: {}, dependsOn: [] }], inputs: [] }, values: {} });
    for (const taskId of [task.id, undefined]) {
      const chatRunId = await chat(f.owner, 'partial');
      await save({ ownerId: f.owner, chatRunId, outcome: 'partial', signal: { source: 'workflow', code: 'APPROVAL_REQUIRED', ...(taskId ? { taskId } : {}) } });
      expect(await f.store.db.selectFrom('skill_gaps').select(['category', 'signal']).where('chat_run_id', '=', chatRunId).executeTakeFirstOrThrow()).toEqual({ category: null, signal: null });
    }
  });

  it('lists only owned diagnostics, bounds pages and leaves rows unchanged on reads and migration reruns', async () => {
    const chatRunId = await chat('other-owner', 'partial');
    const task = await f.parent({ plan: { nodes: [{ id: 'main', skillId: randomUUID(), inputs: {}, dependsOn: [] }], inputs: [] }, values: {} });
    await f.store.db.updateTable('tasks').set({ owner_id: 'other-owner', status: 'waiting_approval' }).where('id', '=', task.id).execute();
    await save({ ownerId: 'other-owner', chatRunId, outcome: 'partial', signal: { source: 'workflow', code: 'APPROVAL_PENDING', taskId: task.id } });
    const before = await f.store.db.selectFrom('skill_gaps').selectAll().orderBy('id').execute();
    const page = await listSkillGaps(f.store.db, 'other-owner', { limit: 1, offset: 0, category: 'missing_permission' });
    expect(page.total).toBe(1); expect(page.items).toHaveLength(1); expect(page.items[0]).toMatchObject({ chatRunId, category: 'missing_permission', action: { kind: 'review_permission', automatic: false } });
    expect((await listSkillGaps(f.store.db, 'empty-owner')).items).toEqual([]);
    expect((await listSkillGaps(f.store.db, f.owner)).items.every(item => item.chatRunId !== chatRunId)).toBe(true);
    await skillsMigration(f.store.db);
    expect(await f.store.db.selectFrom('skill_gaps').selectAll().orderBy('id').execute()).toEqual(before);
    expect(await f.store.db.selectFrom('schema_migrations').select('version').where('version', '=', '018_skill_gaps').execute()).toHaveLength(1);
  });
});
