import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ActivationConsoleSnapshotSchema } from '@mohassan/contracts';
import { createApplication } from '../apps/server/src/app.js';
import { registerActivationConsumer } from '../apps/server/src/activation-runtime.js';

const api = '/api/activation-console';
const origin = 'http://127.0.0.1:3000';
const fixtureSecret = 'activation-service-fixture-string-0001';
const setupToken = 'activation-setup-fixture-string-000001';
const owner = { name: 'Activation owner', email: 'activation-owner@example.test', password: 'Activation-Owner-Fixture-Password-42' };
const member = { name: 'Activation member', email: 'activation-member@example.test', password: 'Activation-Member-Fixture-Password-42' };
const consumer = registerActivationConsumer('MOHASSAN_ANSWER_SELECTION', '1', null);

function sealedReport(decision: 'pass' | 'stop') {
  const pin = { path: 'fixture/record', sha256: 'a'.repeat(64) };
  const record = `${JSON.stringify({
    schema_version: 1, version: 1, previous_report: null, gate_id: 'answer-selection', adapter: 'classifier', case_count: 2,
    counts: { overall: { passed: 1, total: 2 } }, decision, checks: [{ rule: 'minimum_passes.overall', status: decision }],
    hashes: { registration: pin, seal: pin, cases: pin, candidate: pin, start: pin, view: pin, packet: pin, packet_receipt: pin,
      evidence: { candidate: { receipt: pin, predictions: pin, provenance: pin, native_manifest: null, task_files: [] } }, verdicts: [] },
    times: { sealed_at: '2026-11-20T12:00:00Z', decided_at: '2026-11-20T12:30:00Z' },
  })}\n`;
  return { record, sha256: createHash('sha256').update(record).digest('hex') };
}

describe('owner activation console', () => {
  let application: Awaited<ReturnType<typeof createApplication>>;
  let ownerCookie: string, memberCookie: string, ownerId: string, memberId: string;
  let conversation: string, memberConversation: string;
  let dataDir: string;
  const db = () => application.database.db;
  const headers = (cookie: string) => ({ origin, cookie, 'x-mohassan-internal': fixtureSecret });
  async function request(url: string, payload?: object, cookie = ownerCookie) {
    return application.app.inject({ method: payload ? 'POST' : 'GET', url, headers: headers(cookie), ...(payload ? { payload } : {}) });
  }
  async function login(credentials: typeof owner) {
    const response = await request('/api/auth/sign-in/email', { email: credentials.email, password: credentials.password }, '');
    expect(response.statusCode).toBe(200);
    return [response.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
  }
  async function event(conversationId: string, kind: string, data: object, ageMs = 1000) {
    const id = randomUUID();
    await db().insertInto('chat_events').values({ id, conversation_id: conversationId, kind, message: 'internal event',
      data: JSON.stringify(data), created_at: new Date(Date.now() - ageMs) }).execute();
    return `event:${id}`;
  }
  async function snapshot(query = '') {
    const response = await request(`${api}${query}`);
    expect(response.statusCode, response.body).toBe(200);
    return ActivationConsoleSnapshotSchema.parse(response.json());
  }
  const setState = (enabled: boolean, extra = {}) => request(`${api}/state`, { capabilityId: 'answer-selection', enabled, ...extra });
  const vote = (sampleId: string, label: string, trainingAllowed?: boolean) => request(`${api}/reviews`, { sampleId, label, trainingAllowed });
  const disagreement = { baseline: 'abstain', ranker: 'answer' };

  beforeAll(async () => {
    const gate = sealedReport('pass');
    dataDir = await mkdtemp(join(tmpdir(), 'mohassan-activation-'));
    await writeFile(join(dataDir, 'activation-console.json'), JSON.stringify({ minimumReviews: 2,
      gates: { 'answer-selection': { gateId: 'answer-selection', sha256: gate.sha256 } } }));
    vi.stubEnv('MOHASSAN_JUDGE_LOG_DIR', dataDir);
    try {
      application = await createApplication({ authSecret: 'activation-auth-fixture-string-000001', internalSecret: fixtureSecret,
        setupToken, production: false, runWorker: false, webOrigin: origin, dataDir });
    } finally {
      vi.unstubAllEnvs();
    }
    expect((await request('/api/setup', { ...owner, setupToken }, '')).statusCode).toBe(200);
    ownerCookie = await login(owner);
    ownerId = (await request('/api/access')).json().user.id;
    const invite = await request('/api/members/invites', { name: member.name, email: member.email });
    expect(invite.statusCode).toBe(200);
    const token = new URL(invite.json().url).hash.replace('#invite=', '');
    expect((await request('/api/invites/accept', { name: member.name, password: member.password, token }, '')).statusCode).toBe(200);
    memberCookie = await login(member);
    memberId = (await request('/api/access', undefined, memberCookie)).json().user.id;
    conversation = randomUUID();
    memberConversation = randomUUID();
    await db().insertInto('chat_conversations').values([
      { id: conversation, owner_id: ownerId, title: 'Owner fixture' },
      { id: memberConversation, owner_id: memberId, title: 'Member fixture' },
    ]).execute();
  }, 60_000);
  afterAll(async () => { await application?.app.close(); if (dataDir) await rm(dataDir, { recursive: true, force: true }); });

  it('ignores missing/unknown capabilities and uses the selected time window', async () => {
    expect((await snapshot()).capabilities).toEqual([]);
    await event(conversation, 'unknown_capability_shadow', disagreement);
    await event(conversation, 'answer_selection_shadow', disagreement, 8 * 86_400_000);
    expect((await snapshot()).capabilities).toEqual([]);
    expect((await snapshot('?days=14')).capabilities.map(item => item.id)).toEqual(['answer-selection']);
    expect((await request(`${api}?days=0`)).statusCode).toBe(400);
  });

  it('denies members and anonymous requests on every console operation', async () => {
    for (const [url, payload] of [[api], [`${api}/reviews`, {}], [`${api}/state`, {}]] as const) {
      expect((await request(url, payload, memberCookie)).statusCode).toBe(403);
      expect((await request(url, payload, '')).statusCode).toBe(401);
    }
  });

  it('aggregates comparisons, excludes member samples, and redacts exact owner replies', async () => {
    const messageId = randomUUID();
    const memberMessage = randomUUID();
    await db().insertInto('chat_messages').values([
      { id: messageId, conversation_id: conversation, role: 'assistant', text: `Summary. Password: hunter1234 ${fixtureSecret} https://host.test/token/very-secret\nAuthorization: Basic YWJjOmRlZg==\nCookie: first=private1; second=private2` },
      { id: memberMessage, conversation_id: memberConversation, role: 'assistant', text: 'member-only content' },
    ]).execute();
    const ownerSample = await event(conversation, 'answer_selection_shadow', { ...disagreement, replyId: messageId });
    const foreign = await event(memberConversation, 'answer_selection_shadow', { ...disagreement, replyId: memberMessage });
    const crossLink = await event(conversation, 'answer_selection_shadow', { ...disagreement, replyId: memberMessage });
    await event(conversation, 'answer_selection_shadow', { baseline: 'answer', ranker: 'answer', sameSource: true, sameQuote: true });
    await event(conversation, 'answer_selection_shadow', { baseline: 'answer', ranker: 'error', error: 'private diagnostic' });
    await event(conversation, 'judge.conversationReview', { decision: 'send', conversationReview: { action: 'fix', ms: 6 } });
    const result = await snapshot();
    expect(result.capabilities.find(item => item.id === 'answer-selection')).toMatchObject({ eventCount: 5, comparedCount: 4,
      disagreements: 3, disagreementRate: 0.75, errors: 1, categories: [{ category: 'new_answer', count: 3 }] });
    expect(result.capabilities.find(item => item.id === 'conversation-reviewer')?.latency).toEqual({ count: 1, meanMs: 6 });
    expect(result.samples.find(item => item.id === ownerSample)).toMatchObject({ baseline: 'Summary. [محجوب] [محجوب] [محجوب]\n[محجوب]\n[محجوب]', baselineKind: 'reply' });
    expect(result.samples.find(item => item.id === crossLink)).toMatchObject({ baseline: 'abstain', baselineKind: 'decision' });
    expect(result.samples.map(item => item.id)).not.toContain(foreign);
    expect((await vote(foreign, 'better')).statusCode).toBe(404);
    for (const denied of ['member-only content', 'hunter1234', 'very-secret', 'YWJjOmRlZg==', 'private1', 'private2', 'private diagnostic', fixtureSecret]) {
      expect(JSON.stringify(result)).not.toContain(denied);
    }
  });

  it('reads run-ledger disagreements and reviews only the same account’s structured observations', async () => {
    const runId = randomUUID();
    const ledger = { version: 1, legacy: { action: 'abstain' }, chosen: { action: 'ask' }, disagrees: true, legacyObserved: true };
    await db().insertInto('chat_runs').values({ id: runId, conversation_id: conversation, owner_id: ownerId, status: 'completed',
      goal: 'test fixture', lease_token: randomUUID(), lease_expires_at: new Date(), updated_at: new Date(Date.now() - 1000),
      state: JSON.stringify({ agentRun: { deliberation: ledger, earlierDeliberation: [ledger] } }) }).execute();
    const ownId = randomUUID(), foreignId = randomUUID();
    await db().insertInto('activation_observations').values([
      { id: ownId, owner_id: ownerId }, { id: foreignId, owner_id: memberId },
    ].map(item => ({ ...item, capability_id: 'arabic-understanding', created_at: new Date(Date.now() - 1000),
      changed: true, category: 'route', baseline: 'new', shadow: 'follow_up', error: false }))).execute();
    const result = await snapshot();
    expect(result.capabilities.find(item => item.id === 'deliberation')).toMatchObject({ eventCount: 1, disagreements: 1 });
    expect(result.capabilities.find(item => item.id === 'arabic-understanding')).toMatchObject({ eventCount: 2, disagreements: 2, disagreementRate: null });
    expect(result.samples.some(item => item.id.startsWith(`run:${runId}:`))).toBe(true);
    expect(result.samples.map(item => item.id)).toContain(`observation:${ownId}`);
    expect(result.samples.map(item => item.id)).not.toContain(`observation:${foreignId}`);
    expect((await vote(`observation:${foreignId}`, 'better')).statusCode).toBe(404);
    expect((await vote(`observation:${ownId}`, 'better')).statusCode).toBe(200);
  });

  it('corroborates an owner judge candidate against a stored reply before displaying it', async () => {
    const timestamp = Date.now();
    const reply = 'The confirmed fixture reply.';
    await db().insertInto('chat_messages').values({ id: randomUUID(), conversation_id: conversation, role: 'assistant',
      text: reply, created_at: new Date(timestamp - 500) }).execute();
    const observed = { at: new Date(timestamp - 1000).toISOString(), decision: 'send', applied: false, truth: { decision: 'withhold' } };
    await writeFile(join(dataDir, 'shadow.jsonl'), [
      { ...observed, conversationId: conversation, runId: randomUUID(), reply },
      { ...observed, conversationId: conversation, runId: randomUUID(), reply: 'unpublished candidate' },
      { ...observed, conversationId: memberConversation, runId: randomUUID(), reply: 'member JSONL content' },
    ].map(line => JSON.stringify(line)).join('\n') + '\n');
    const result = await snapshot();
    expect(result.capabilities.find(item => item.id === 'truth-checks')).toMatchObject({ eventCount: 3, disagreements: 3 });
    expect(result.samples.filter(item => item.capabilityId === 'truth-checks')).toEqual(expect.arrayContaining([
      expect.objectContaining({ baseline: reply, baselineKind: 'reply', shadow: 'withhold' }),
      expect.objectContaining({ baseline: 'send', baselineKind: 'decision', shadow: 'withhold' }),
    ]));
    expect(JSON.stringify(result)).not.toMatch(/unpublished candidate|member JSONL content/);
  });

  it('requires enough favorable reviews and the independently pinned passing gate, then switches off in one call', async () => {
    expect((await setState(true, { reason: 'Rollout' })).json().error.code).toBe('ACTIVATION_REVIEWS_REQUIRED');
    const first = await event(conversation, 'answer_selection_shadow', disagreement);
    const second = await event(conversation, 'answer_selection_shadow', disagreement);
    const third = await event(conversation, 'answer_selection_shadow', disagreement);
    const fourth = await event(conversation, 'answer_selection_shadow', disagreement);
    expect((await vote(first, 'worse')).statusCode).toBe(200);
    expect((await vote(second, 'same')).statusCode).toBe(200);
    expect((await setState(true, { reason: 'Rollout' })).json().error.code).toBe('ACTIVATION_REVIEWS_REQUIRED');
    expect((await vote(third, 'better', true)).statusCode).toBe(200);
    expect((await vote(third, 'better', true)).statusCode).toBe(200);
    expect((await vote(third, 'worse')).statusCode).toBe(409);
    expect((await vote(fourth, 'same')).statusCode).toBe(200);
    const reviewed = await db().selectFrom('activation_reviews').select(['sample_id', 'training_allowed']).execute();
    expect(reviewed.filter(row => row.training_allowed).map(row => row.sample_id)).toEqual([third]);
    expect((await snapshot()).samples.some(item => reviewed.some(row => row.sample_id === item.id))).toBe(false);
    expect((await setState(true, { reason: 'Rollout' })).json().error.code).toBe('ACTIVATION_GATE_REQUIRED');
    expect((await setState(true, { reason: 'Rollout', gate: sealedReport('stop') })).json().error.code).toBe('ACTIVATION_GATE_REQUIRED');
    const gate = sealedReport('pass');
    expect((await setState(true, { gate })).json().error.code).toBe('ACTIVATION_REASON_REQUIRED');
    expect((await setState(true, { reason: `Reviewed. ${fixtureSecret}`, gate })).statusCode).toBe(200);
    expect((await snapshot()).capabilities.find(item => item.id === 'answer-selection')).toMatchObject({ enabled: true, gateSha256: gate.sha256 });
    expect(consumer('fixture')).toBe('fixture');
    expect((await setState(false)).statusCode).toBe(200);
    expect((await setState(false)).statusCode).toBe(200);
    const state = await snapshot();
    expect(state.audit).toHaveLength(2);
    expect(state.audit[1]).toMatchObject({ enabled: true, actorId: ownerId, reason: 'Reviewed. [محجوب]', gateSha256: gate.sha256,
      evidence: { minimumReviews: 2, better: 1, worse: 1, same: 2 } });
    expect(state.audit[0]).toMatchObject({ enabled: false, actorId: ownerId });
    expect(state.capabilities.find(item => item.id === 'answer-selection')).toMatchObject({ enabled: false, gateSha256: gate.sha256 });
  });

  it('enforces append-only audit history in the database', async () => {
    await expect(sql`UPDATE activation_changes SET reason = 'changed'`.execute(db())).rejects.toThrow('append-only');
    await expect(sql`DELETE FROM activation_changes`.execute(db())).rejects.toThrow('append-only');
    await expect(sql`TRUNCATE activation_changes`.execute(db())).rejects.toThrow('append-only');
  });

  it('requires a server-configured pin for a known gate', async () => {
    const evidence = { legacyDecision: { kind: 'new' }, decision: { type: 'follow_up' }, agreement: { type: false } };
    expect((await vote(await event(conversation, 'conversation.agreement', evidence), 'better')).statusCode).toBe(200);
    expect((await vote(await event(conversation, 'conversation.agreement', evidence), 'same')).statusCode).toBe(200);
    const response = await request(`${api}/state`, { capabilityId: 'conversation-state', enabled: true, reason: 'Reviewed' });
    expect(response.json().error.code).toBe('ACTIVATION_GATE_UNPINNED');
  });
});
