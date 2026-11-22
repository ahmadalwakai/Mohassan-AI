/** Isolated CHILD PROCESS only. No shared Vitest/global clock, production DB or network. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { createDatabase, migrate } from '@mohassan/database';
import { createMemoryControl, memoryMigration } from '@mohassan/memory';
import { migrateAuth } from '../../apps/server/src/auth.ts';
import { createCommandChatControl } from '../../apps/server/src/command-chat.ts';
import { createAssistantTools } from '../../apps/server/src/assistant/tools.ts';

const mode = process.argv[2];
assert(['note-save', 'calculation-save', 'note-status', 'calculation-status', 'formatted-recall', 'preferred-recall'].includes(mode));
const formatted = mode === 'formatted-recall';
const preferred = mode === 'preferred-recall', recall = formatted || preferred;
const timing = process.argv[3] ?? 'expired'; assert(['fresh', 'expired', 'model-expired'].includes(timing));
assert(timing !== 'model-expired' || formatted);
const OWNER = 'isolated-publication-clock-owner';
const request = preferred ? 'From my memory, what is my preferred language?' : formatted ? 'From my memory, return my home city only.'
  : mode.startsWith('note') ? 'Remember exactly this note: PUBLICATION-CLOCK-724.' : 'Calculate 2 + 3, then remember the result.';
const question = mode.startsWith('note') ? 'Did you save the note?' : 'Did you save the result?';
const targetField = recall ? 'supervision' : mode === 'note-save' ? 'userFactMemory' : mode === 'calculation-save' ? 'computationMemory'
  : mode === 'note-status' ? 'userFactMemoryVerification' : 'memoryVerification';
const NativeDate = Date;
let offset = 0, clockAdvanced = false, hookUsed = false;
const auditNow = () => NativeDate.now() + offset;
// This proxy is confined to this disposable child. Dates with explicit arguments
// retain their original interpretation; zero-argument construction/now share one clock.
const ClockDate = new Proxy(NativeDate, {
  construct(target, args) { return Reflect.construct(target, args.length ? args : [auditNow()]); },
  apply() { return new NativeDate(auditNow()).toString(); },
  get(target, field) { return field === 'now' ? auditNow : Reflect.get(target, field, target); },
});
globalThis.Date = ClockDate;
let database, control;
const hook = { count: 0, beforeReview: null, beforeLease: null, afterLease: null, afterSqlNow: null, runId: null,
  advanceMs: timing === 'fresh' ? 0 : 300001, fixtureLeaseRenewal: false, phase: null, proofCheckpointAt: null };
let writes = 0, reads = 0, forbiddenCalls = 0, accountChecksAfterAdvance = 0, setupWrites = 0, lexicalReads = 0, modelCalls = 0;
let sourceReadStartedAt, sourceReadFinishedAt, modelStartedAt;
const forbidden = async () => { forbiddenCalls++; throw new Error('No browser, legacy memory, external search or model belongs to this audit.'); };

function wrappedUpdate(tx, table, builder, proof) {
  return new Proxy(builder, { get(target, member) {
    const value = Reflect.get(target, member, target);
    if (['execute', 'executeTakeFirst', 'executeTakeFirstOrThrow'].includes(String(member))) return async (...args) => {
      if (proof && !hookUsed) {
        const runId = proof.supervision.contract.id;
        const run = await tx.selectFrom('chat_runs').select(['id', 'owner_id', 'status', 'lease_token', 'lease_expires_at'])
          .where('id', '=', runId).where('owner_id', '=', OWNER).where('status', '=', 'running').executeTakeFirstOrThrow();
        assert.equal(run.id, runId); assert.equal(run.owner_id, OWNER); assert.equal(run.status, 'running');
        hookUsed = true; hook.count++; hook.phase = 'publication_checkpoint'; hook.beforeReview = proof.completionReview;
        hook.beforeLease = new NativeDate(run.lease_expires_at).toISOString(); hook.runId = runId;
        hook.proofCheckpointAt = Date.now();
        offset += hook.advanceMs; clockAdvanced = hook.advanceMs > 0;
        // Model a host/connection wait with legitimate heartbeats, rather than
        // a five-minute lock stall (which correctly expires the 60-second lease).
        // Renew only this exact live owner/run/token, for the normal MAX 60s.
        // No assertActive/account check is removed or replaced: the real next
        // publication transaction must subsequently pass those unchanged fences.
        let lease = run.lease_expires_at;
        if (clockAdvanced) {
          const renewed = await tx.updateTable('chat_runs').set({ lease_expires_at: sql`clock_timestamp() + interval '60 seconds'` })
            .where('id', '=', runId).where('owner_id', '=', OWNER).where('lease_token', '=', run.lease_token).where('status', '=', 'running')
            .returning('lease_expires_at').executeTakeFirstOrThrow();
          lease = renewed.lease_expires_at; hook.fixtureLeaseRenewal = true;
        }
        const wall = await sql`SELECT clock_timestamp() AS sql_now`.execute(tx);
        hook.afterLease = new NativeDate(lease).toISOString();
        hook.afterSqlNow = new NativeDate(wall.rows[0].sql_now).toISOString();
        assert(Date.parse(hook.afterLease) > Date.parse(hook.afterSqlNow));
      }
      return value.apply(target, args);
    };
    if (typeof value !== 'function') return value;
    return (...args) => {
      let next = proof;
      if (member === 'set' && table === 'chat_runs' && typeof args[0]?.state === 'string') {
        const parsed = JSON.parse(args[0].state);
        if (parsed[targetField] && parsed.completionReview?.allowCompletion === true) next = parsed;
      }
      return wrappedUpdate(tx, table, value.apply(target, args), next);
    };
  } });
}
function wrappedDb(db) {
  return new Proxy(db, { get(target, member) {
    if (member === 'transaction') return () => {
      const transactionBuilder = target.transaction();
      return new Proxy(transactionBuilder, { get(builder, field) {
        if (field === 'execute') return callback => builder.execute(tx => callback(new Proxy(tx, { get(connection, key) {
          if (key === 'updateTable') return table => wrappedUpdate(connection, table, connection.updateTable(table));
          const value = Reflect.get(connection, key, connection); return typeof value === 'function' ? value.bind(connection) : value;
        } })));
        const value = Reflect.get(builder, field, builder); return typeof value === 'function' ? value.bind(builder) : value;
      } });
    };
    const value = Reflect.get(target, member, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
}

try {
  database = await createDatabase({}); assert.equal(database.mode, 'embedded');
  await migrateAuth(database.db); await migrate(database.db); await memoryMigration(database.db);
  await database.db.insertInto('user').values({ id: OWNER, name: 'Synthetic publication owner', email: 'publication-clock@example.test' }).execute();
  await sql`CREATE TABLE fixture_publication_access(owner_id text PRIMARY KEY,active boolean NOT NULL)`.execute(database.db);
  await database.db.insertInto('fixture_publication_access').values({ owner_id: OWNER, active: true }).execute();
  const domain = createMemoryControl(database.db);
  const converted = createAssistantTools({ memory: domain,
    coding: { available: false, workspace: async () => ({ projects: [] }) },
    studio: { workspace: async () => ({ sessions: [] }), detail: forbidden }, studioChange: false,
    runtime: { createTask: forbidden, approve: forbidden, cancel: forbidden, detail: forbidden },
    windows: { enabled: false, view: forbidden, act: forbidden, command: forbidden },
  }).memory;
  if (recall) {
    const payload = preferred ? 'I prefer Arabic.' : 'My home city is Bristol.';
    await domain.writeExact(OWNER, { operationKey: createHash('sha256').update(`synthetic-${mode}-setup`).digest('hex'),
      payload, payloadHash: createHash('sha256').update(payload).digest('hex') }); setupWrites++;
  }
  control = await createCommandChatControl(wrappedDb(database.db), {
    browser: { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
      act: forbidden, screen: forbidden, observe: forbidden, prepareAction: forbidden },
    tools: { memory: { async search(owner, query) {
      if (!recall) return forbidden();
      lexicalReads++; sourceReadStartedAt = Date.now();
      const result = await converted.search(owner, query); sourceReadFinishedAt = Date.now(); return result;
    }, save: forbidden,
      async writeExact(owner, input, options) { writes++; assert.equal(typeof options?.fence, 'function'); return domain.writeExact(owner, input, options); },
      async reconcileExact(owner, input, options) { reads++; return domain.reconcileExact(owner, input, options); } } },
    recordExperiences: false, fullAccess: async () => true, leaseMs: 60000,
    accountActive: async (owner, tx) => {
      if (clockAdvanced) accountChecksAfterAdvance++;
      return Boolean(await tx.selectFrom('fixture_publication_access').select('owner_id').where('owner_id', '=', owner).where('active', '=', true).forShare().executeTakeFirst());
    },
    models: recall ? { fast: ['formatted-clock-fixture'], deep: ['formatted-clock-fixture'], vision: '' } : { fast: [], deep: [], vision: '' },
    createProvider: model => ({ id: 'formatted-clock-fixture', async generate() {
      modelCalls++; modelStartedAt = Date.now();
      if (preferred) return forbidden();
      assert.equal(formatted, true); assert.equal(lexicalReads, 1);
      if (timing === 'model-expired' && !hookUsed) {
        const run = await database.db.selectFrom('chat_runs').select(['id', 'lease_token', 'lease_expires_at'])
          .where('owner_id', '=', OWNER).where('status', '=', 'running').executeTakeFirstOrThrow();
        hookUsed = true; hook.count++; hook.phase = 'model_after_memory_read'; hook.runId = run.id;
        hook.beforeLease = new NativeDate(run.lease_expires_at).toISOString();
        assert(Number.isFinite(sourceReadFinishedAt)); assert(Date.now() >= sourceReadFinishedAt);
        offset += hook.advanceMs; clockAdvanced = true;
        const renewed = await database.db.updateTable('chat_runs').set({ lease_expires_at: sql`clock_timestamp() + interval '60 seconds'` })
          .where('id', '=', run.id).where('owner_id', '=', OWNER).where('lease_token', '=', run.lease_token).where('status', '=', 'running')
          .returning('lease_expires_at').executeTakeFirstOrThrow();
        const wall = await sql`SELECT clock_timestamp() AS sql_now`.execute(database.db);
        hook.fixtureLeaseRenewal = true; hook.afterLease = new NativeDate(renewed.lease_expires_at).toISOString();
        hook.afterSqlNow = new NativeDate(wall.rows[0].sql_now).toISOString();
      }
      return { model, usage: { inputTokens: 1, outputTokens: 1 }, text: JSON.stringify({ thought: null, plan: null, note: null, url: null,
        ref: null, submit: null, options: null, sensitive: null, tool: 'answer', text: 'Bristol', outcome: 'done' }) };
    } }),
    searchProvider: { name: 'forbidden-publication-network', search: forbidden },
  });
  const { id } = await control.create(OWNER, { goal: request }); await control.settled(id);
  if (mode.endsWith('status')) {
    const original = await database.db.selectFrom('chat_runs').select('status').where('conversation_id', '=', id).executeTakeFirstOrThrow();
    assert.equal(original.status, 'completed'); assert.equal(clockAdvanced, false);
    await control.send(OWNER, id, { text: question }); await control.settled(id);
  }
  const row = await database.db.selectFrom('chat_runs').selectAll().where('id', '=', hook.runId).executeTakeFirstOrThrow();
  const detail = await control.detail(OWNER, id), state = row.state;
  const wall = await sql`SELECT clock_timestamp() AS sql_now`.execute(database.db);
  const finalSqlNow = new NativeDate(wall.rows[0].sql_now).toISOString(), leaseExpiresAt = new NativeDate(row.lease_expires_at).toISOString();
  const observations = state.supervision.steps.flatMap(step => step.observations).map(observation => observation.observedAt);
  const latestObservation = Math.max(...observations), logicalNow = Date.now();
  const account = await database.db.selectFrom('fixture_publication_access').select('active').where('owner_id', '=', OWNER).executeTakeFirstOrThrow();
  const items = await database.db.selectFrom('memory_items').select('id').where('owner_id', '=', OWNER).execute();
  const operations = await database.db.selectFrom('memory_exact_operations').select('operation_key').where('owner_id', '=', OWNER).execute();
  const report = { mode, timing, targetField, status: row.status, text: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text,
    contractMode: state.supervision.contract.mode, criterionAges: state.supervision.contract.criteria.map(c => ({ id: c.id, maxAgeMs: c.maxAgeMs })),
    completionReview: state.completionReview, hook, logicalNow, latestObservation, observationAgeMs: logicalNow - latestObservation,
    logicalRunAgeMs: logicalNow - new NativeDate(row.created_at).getTime(), finalSqlNow, leaseExpiresAt,
    leaseStillActive: Date.parse(leaseExpiresAt) > Date.parse(finalSqlNow), currentAccountActive: account.active, accountChecksAfterAdvance,
    writes, reads, setupWrites, lexicalReads, modelCalls, sourceReadStartedAt, sourceReadFinishedAt, modelStartedAt, forbiddenCalls, itemCount: items.length, operationCount: operations.length,
    clockScope: 'This disposable child process only; EXPIRED fixture heartbeat-equivalent renews exact owner/run/token for normal60s; FRESH control performs no renewal/advance; real publication fences unchanged.' };
  process.stdout.write('MEMORY_PUBLICATION_AUDIT=' + JSON.stringify(report) + '\n');
  assert.equal(hook.count, 1);
  if (timing === 'model-expired') assert.equal(hook.beforeReview, null);
  else assert.equal(hook.beforeReview.allowCompletion, true);
  assert(report.leaseStillActive); assert.equal(report.currentAccountActive, true);
  assert(report.logicalRunAgeMs < 15 * 60000);
  if (timing !== 'fresh') { assert(accountChecksAfterAdvance > 0); assert(report.observationAgeMs > 300000); }
  else { assert.equal(accountChecksAfterAdvance, 0); assert(report.observationAgeMs < 300000); }
  assert.equal(forbiddenCalls, 0); assert.equal(writes, recall ? 0 : 1); assert.equal(setupWrites, recall ? 1 : 0);
  assert.equal(items.length, 1); assert.equal(operations.length, 1);
  if (formatted) {
    assert.equal(modelCalls, 1); assert.equal(lexicalReads, 1);
    // The controller captures immediately after the adapter Promise resolves;
    // that can be a later millisecond than the adapter's own completion sample.
    assert(latestObservation >= sourceReadFinishedAt && latestObservation <= modelStartedAt);
  }
  if (preferred) {
    assert.equal(modelCalls, 0); assert.equal(lexicalReads, 1);
    assert(latestObservation >= sourceReadFinishedAt && latestObservation <= hook.proofCheckpointAt);
  }
} finally {
  await control?.shutdown(); await database?.close(); globalThis.Date = NativeDate;
}
