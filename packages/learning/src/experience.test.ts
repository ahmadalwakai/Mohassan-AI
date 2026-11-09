import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrate, type DatabaseHandle } from '@mohassan/database';
import { memoryMigration } from '@mohassan/memory';
import { classifyExperience, recordExperience, recordExperienceFeedback, type ExperienceInput } from './experience.ts';

const expected = { kind: 'page_observation', target: 'order_status', value: 'confirmed' } as const;
const observed = { ...expected, reference: 'private-page-observation-id' };

describe('experience recorder', () => {
  let store: DatabaseHandle;
  beforeAll(async () => {
    store = await createDatabase();
    await migrate(store.db);
    await migrate(store.db);
    await memoryMigration(store.db);
  });
  afterAll(async () => { await store?.close(); });

  function input(overrides: Partial<ExperienceInput> = {}): ExperienceInput {
    return {
      ownerId: 'experience-owner', sourceKind: 'chat_run', sourceId: randomUUID(),
      goal: 'تحقق من النتيجة المطلوبة', category: 'browser', terminalStatus: 'completed', ...overrides,
    };
  }

  function find(row: ExperienceInput) {
    return store.db.selectFrom('experiences').selectAll()
      .where('owner_id', '=', row.ownerId).where('source_kind', '=', row.sourceKind).where('source_id', '=', row.sourceId);
  }

  it('matches the observed target and evidence kind before deciding success or failure', () => {
    expect(classifyExperience(expected, observed)).toBe('verified_success');
    expect(classifyExperience(expected, { ...observed, value: 'pending' })).toBe('verified_failure');
    expect(classifyExperience(expected, { ...observed, target: 'unrelated_banner' })).toBe('unverified');
    expect(classifyExperience(expected, { ...observed, kind: 'api_readback' })).toBe('unverified');
    expect(classifyExperience(expected, { ...observed, reference: '' })).toBe('unverified');
    expect(classifyExperience(expected)).toBe('unverified');
  });

  it('records a single source across replays and retries, including a cancellation before the first attempt', async () => {
    const row = input({ sourceKind: 'runtime_task', attempt: 0, terminalStatus: 'cancelled' });
    await recordExperience(store.db, row);
    await recordExperience(store.db, { ...row, terminalStatus: 'interrupted' });
    expect(await find(row).executeTakeFirst()).toMatchObject({
      attempt: 0, terminal_status: 'cancelled', outcome: 'unverified', evidence_kind: 'none',
    });
    await recordExperience(store.db, { ...row, attempt: 1, terminalStatus: 'failed', expected, observation: { ...observed, value: null } });
    await recordExperience(store.db, row);
    expect(await find(row).execute()).toEqual([expect.objectContaining({
      attempt: 1, terminal_status: 'failed', outcome: 'verified_failure', evidence_kind: 'page_observation',
    })]);
    const migrations = await store.db.selectFrom('schema_migrations').select('version')
      .where('version', '=', '026_experiences').execute();
    expect(migrations).toHaveLength(1);
  });

  it('stores bounded action and evidence hashes and redacts sensitive text before insertion', async () => {
    const secrets = ['gsk_fixturecredential1234567890', '١٢٣٤٥٦', '4111 1111 1111 1111', 'device-secret-from-vault',
      'private-page-observation-id', 'screenshot-private-base64', 'query-secret', 'raw-page-contents'];
    const screenshotHash = 'A'.repeat(64);
    const row = input({
      goal: 'api_key=gsk_fixturecredential1234567890 رمز التحقق ١٢٣٤٥٦ 4111 1111 1111',
      plan: ['افتح https://example.test/?token=query-secret ثم افحص الحالة', 'device-secret-from-vault'],
      trail: [{ step: 1, action: 'open https://example.test/?token=query-secret', result: 'raw-page-contents', changed: true }],
      models: [
        { model: 'openai/gpt-oss-20b', inputTokens: 12, outputTokens: 8, usageKnown: true },
        { model: 'openai/gpt-oss-120b', inputTokens: 100, outputTokens: 10, usageKnown: false },
      ],
      artifactHashes: [screenshotHash, screenshotHash.toLowerCase(), 'screenshot-private-base64'],
      expected, observation: observed,
      redact: text => text.replaceAll('device-secret-from-vault', '[محجوب]'),
    });
    await recordExperience(store.db, row);
    const saved = await find(row).executeTakeFirstOrThrow();
    expect(saved).toMatchObject({
      outcome: 'verified_success',
      evidence_kind: 'page_observation',
      evidence: { referenceHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      trail: [{ step: 1, action: 'open', changed: true, resultHash: expect.stringMatching(/^[a-f0-9]{64}$/) }],
      artifact_hashes: [screenshotHash.toLowerCase()],
      models: [
        { model: 'openai/gpt-oss-20b', inputTokens: 12, outputTokens: 8, usageKnown: true },
        { model: 'openai/gpt-oss-120b', inputTokens: null, outputTokens: null, usageKnown: false },
      ],
    });
    for (const secret of secrets) expect(JSON.stringify(saved)).not.toContain(secret);
  });

  it('participates in the caller transaction', async () => {
    const row = input({ terminalStatus: 'interrupted' });
    await expect(store.db.transaction().execute(async tx => {
      await recordExperience(tx, row);
      throw new Error('terminal transition rolled back');
    })).rejects.toThrow('terminal transition rolled back');
    expect(await find(row).executeTakeFirst()).toBeUndefined();
  });

  it('keeps satisfaction separate from explicit owner confirmation, scopes by owner, and fences retries', async () => {
    const row = input();
    await recordExperience(store.db, row);
    const { ownerId, sourceKind, sourceId } = row;
    const request = { ownerId, sourceKind, sourceId, submissionKey: randomUUID(), expectedAttempt: 1, rating: 5 };
    const rating = await recordExperienceFeedback(store.db, request);
    expect(rating.outcome).toBe('unverified');
    expect(await recordExperienceFeedback(store.db, request)).toEqual(rating);
    await expect(recordExperienceFeedback(store.db, { ...request, rating: 1 })).rejects.toMatchObject({ statusCode: 409 });
    await expect(recordExperienceFeedback(store.db, { ...request, ownerId: 'other-owner' })).rejects.toMatchObject({ statusCode: 404 });
    const confirmation = { ...request, submissionKey: randomUUID(), confirmed: 'success' as const };
    expect((await recordExperienceFeedback(store.db, confirmation)).outcome).toBe('verified_success');
    expect(await find(row).executeTakeFirst()).toMatchObject({ evidence_kind: 'owner_confirmed' });
    await recordExperience(store.db, { ...row, attempt: 2, expected, observation: { ...observed, value: 'pending' } });
    await expect(recordExperienceFeedback(store.db, confirmation)).rejects.toMatchObject({ code: 'EXPERIENCE_ATTEMPT_CHANGED', statusCode: 409 });
    expect((await recordExperienceFeedback(store.db, { ...confirmation, expectedAttempt: 2, submissionKey: randomUUID() })).outcome)
      .toBe('verified_failure');
    expect(await find(row).executeTakeFirst()).toMatchObject({ evidence_kind: 'page_observation' });
    const feedback = await store.db.selectFrom('experience_feedback').selectAll().where('source_id', '=', sourceId).execute();
    expect(feedback.map(entry => entry.attempt).sort()).toEqual([1, 1, 2]);
  });

  it('only links a saved memory rating from a task belonging to the same source and owner', async () => {
    const row = input();
    await recordExperience(store.db, row);
    const taskId = randomUUID();
    await store.db.insertInto('tasks').values({
      id: taskId, owner_id: row.ownerId, experience_parent_run_id: row.sourceId, title: 'اختبار',
      goal: row.goal, capability_id: 'browser.open', autonomy: 'scoped', status: 'completed',
      input_hash: 'fixture', idempotency_key: randomUUID(),
    }).execute();
    const memoryFeedbackId = randomUUID();
    await store.db.insertInto('memory_feedback').values({
      id: memoryFeedbackId, task_id: taskId, owner_id: row.ownerId, kind: 'task_correction',
      comment: 'تقييم اختباري', rating: 4, persisted_preference: false, submission_key: randomUUID(),
    }).execute();
    const request = {
      ownerId: row.ownerId, sourceKind: row.sourceKind, sourceId: row.sourceId,
      submissionKey: randomUUID(), memoryFeedbackId,
    };
    const { id, outcome } = await recordExperienceFeedback(store.db, request);
    expect(outcome).toBe('unverified');
    expect(await store.db.selectFrom('experience_feedback').selectAll().where('id', '=', id).executeTakeFirst()).toMatchObject({
      rating: 4, memory_feedback_id: memoryFeedbackId,
    });
    const other = input();
    await recordExperience(store.db, other);
    await expect(recordExperienceFeedback(store.db, { ...request, sourceId: other.sourceId, submissionKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'EXPERIENCE_FEEDBACK_UNLINKED' });
  });
});
