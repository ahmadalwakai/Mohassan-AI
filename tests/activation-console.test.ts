import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivationConsoleSnapshotSchema } from '@mohassan/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../apps/server/src/app.js';
import { maskActivationValue } from '../apps/server/src/activation-console/runtime.js';

const path = '/api/activation-console';
const origin = 'http://127.0.0.1:3000';
const internalSecret = 'activation-fixture-internal-secret-000001';
const setupToken = 'activation-fixture-setup-token-000001';
const authSecret = 'activation-fixture-auth-secret-000001';
const credentialURL = 'https://fixture.invalid/models/access-example-credential?token=fixture-query';
const owner = { name: 'Fixture Owner', email: 'owner@activation.example.test', password: 'Synthetic-Owner-Fixture-42' };
const member = { name: 'Fixture Member', email: 'member@activation.example.test', password: 'Synthetic-Member-Fixture-42' };

describe('activation console in a disposable application', () => {
  let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  let directory: string | undefined;
  let ownerCookie: string;
  let memberCookie: string;
  let ownerId: string;
  let memberId: string;

  function request(url: string, cookie = '', payload?: object) {
    return application!.app.inject({ url, method: payload ? 'POST' : 'GET',
      headers: { origin, 'x-mohassan-internal': internalSecret, ...(cookie ? { cookie } : {}) }, payload });
  }
  async function login({ email, password }: typeof owner) {
    const result = await request('/api/auth/sign-in/email', '', { email, password });
    expect(result.statusCode).toBe(200);
    return [result.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
  }

  beforeAll(async () => {
    vi.stubEnv('MOHASSAN_MONITORS_ENABLED', 'off');
    vi.stubEnv('MOHASSAN_MONITORS_V2', '1');
    vi.stubEnv('MOHASSAN_REASONING', '0');
    vi.stubEnv('RUN_WORKER', 'true');
    vi.stubEnv('MOHASSAN_MODEL_WORKER', '0');
    vi.stubEnv('MOHASSAN_MODEL_COUNCIL', 'off');
    vi.stubEnv('MOHASSAN_MODEL_RELATIONS', 'off');
    vi.stubEnv('MOHASSAN_MODELS_ROOT', undefined);
    vi.stubEnv('BETTER_AUTH_SECRET', authSecret);
    vi.stubEnv('FREELLMAPI_API_KEY', 'fixture-provider-key-which-must-stay-masked');
    vi.stubEnv('LOCAL_MODEL_URL', credentialURL);
    directory = await mkdtemp(join(tmpdir(), 'mohassan-activation-'));
    vi.stubEnv('MOHASSAN_JUDGE_LOG_DIR', directory);
    application = await createApplication({ authSecret, internalSecret, setupToken, webOrigin: origin, production: false,
      runWorker: false, browserProfileDir: join(directory, 'browser') });
    expect((await request('/api/setup', '', { ...owner, setupToken })).statusCode).toBe(200);
    ownerCookie = await login(owner);
    ownerId = (await request('/api/access', ownerCookie)).json().user.id;
    const invite = await request('/api/members/invites', ownerCookie, { name: member.name, email: member.email });
    expect(invite.statusCode).toBe(200);
    const token = new URL(invite.json().url).hash.replace('#invite=', '');
    expect((await request('/api/invites/accept', '', { name: member.name, password: member.password, token })).statusCode).toBe(200);
    memberCookie = await login(member);
    memberId = (await request('/api/access', memberCookie)).json().user.id;
  });

  afterAll(async () => {
    await application?.app.close();
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('allows the owner and denies the member and anonymous sessions', async () => {
    const [own, limited, anonymous] = await Promise.all([request(path, ownerCookie), request(path, memberCookie), request(path)]);
    expect(own.statusCode).toBe(200);
    expect(own.headers['cache-control']).toBe('private, no-store');
    expect(ActivationConsoleSnapshotSchema.parse(own.json()).switches.length).toBeGreaterThan(0);
    expect(limited.statusCode).toBe(403);
    expect(anonymous.statusCode).toBe(401);
    expect(limited.body).not.toContain('MOHASSAN_REASONING');
    expect(anonymous.body).not.toContain('MOHASSAN_REASONING');
    expect((await request(`${path}/state`, ownerCookie, { capabilityId: 'reasoning', enabled: true })).statusCode).toBe(404);
  });

  it('masks key, token and URL values before serializing switch state', async () => {
    const response = await request(path, ownerCookie);
    const switches = ActivationConsoleSnapshotSchema.parse(response.json()).switches;
    const row = (name: string) => switches.find(entry => entry.name === name);
    expect(row('BETTER_AUTH_SECRET')).toMatchObject({ currentValue: 'set', configuredValue: 'set' });
    expect(row('FREELLMAPI_API_KEY')).toMatchObject({ currentValue: 'not set', configuredValue: 'set' });
    expect(row('LOCAL_MODEL_URL')).toMatchObject({ currentValue: 'set', configuredValue: 'set' });
    expect(response.body.includes(authSecret) || response.body.includes(credentialURL)
      || response.body.includes('fixture-provider-key-which-must-stay-masked')).toBe(false);
    expect(maskActivationValue('//fixture:user-secret@fixture.invalid')).toBe('set');
    expect(maskActivationValue('mailto:contact@fixture.invalid?token=synthetic')).toBe('set');
    expect(maskActivationValue(undefined, true)).toBe('not set');
  });

  it('distinguishes request-time switch values, startup settings, and dependencies', async () => {
    vi.stubEnv('MOHASSAN_MONITORS_ENABLED', 'owner');
    vi.stubEnv('MOHASSAN_REASONING', '1');
    try {
      const switches = ActivationConsoleSnapshotSchema.parse((await request(path, ownerCookie)).json()).switches;
      const row = (name: string) => switches.find(entry => entry.name === name);
      expect(row('RUN_WORKER')).toMatchObject({ currentValue: 'off', configuredValue: 'true' });
      expect(row('MOHASSAN_MONITORS_V2')).toMatchObject({ currentValue: 'off', configuredValue: '1' });
      expect(row('MOHASSAN_REASONING')).toMatchObject({ currentValue: 'on', configuredValue: '1' });
      expect(row('MOHASSAN_MODEL_COUNCIL')).toMatchObject({ currentValue: 'off' });
      expect(row('MOHASSAN_MODELS_ROOT')?.currentValue).toContain(process.cwd());
    } finally {
      vi.stubEnv('MOHASSAN_MONITORS_ENABLED', 'off');
      vi.stubEnv('MOHASSAN_REASONING', '0');
    }
  });

  it('aggregates the available evidence with no conversation or log content in the response', async () => {
    const ownConversation = randomUUID(), otherConversation = randomUUID();
    const at = new Date(Date.now() - 1000);
    const db = application!.database.db;
    await db.insertInto('chat_conversations').values([
      { id: ownConversation, owner_id: ownerId, title: 'Own fixture' },
      { id: otherConversation, owner_id: memberId, title: 'Other fixture' },
    ]).execute();
    await db.insertInto('activation_observations').values([ownerId, memberId].map(ownerId => ({
      id: randomUUID(), capability_id: 'structured-memory', owner_id: ownerId, created_at: at,
      changed: null, error: false, baseline: 'private fixture persisted detail',
    }))).execute();
    const judge = (conversationId: string) => ({ at, conversationId, decision: 'fix', reply: 'private fixture conversation reply',
      conversationReview: { action: 'note', applied: false } });
    await writeFile(join(directory!, 'shadow.jsonl'), `${JSON.stringify(judge(ownConversation))}\n${JSON.stringify(judge(otherConversation))}\n{`);
    channel('console.info').publish([JSON.stringify({ event: 'plan_compiler_shadow', status: 'compile_failed', text: 'private fixture console detail' })]);
    const response = await request(path, ownerCookie);
    const switches = ActivationConsoleSnapshotSchema.parse(response.json()).switches;
    const observation = (name: string) => switches.find(entry => entry.name === name)?.observation;
    expect(observation('MOHASSAN_JUDGE_SHADOW')).toMatchObject({ eventCount: 1, lastObservedAt: at.toISOString() });
    expect(observation('MOHASSAN_CONVERSATION_REVIEW_APPLY')).toMatchObject({ eventCount: 1, comparedCount: 1, disagreements: 1 });
    expect(observation('MOHASSAN_PLAN_COMPILER')).toMatchObject({ eventCount: 1, comparedCount: 0, errors: 1 });
    expect(observation('MOHASSAN_STRUCTURED_MEMORY')).toMatchObject({ eventCount: 1, lastObservedAt: at.toISOString() });
    expect(response.body).not.toContain('private fixture');
    expect(response.body).not.toContain(ownConversation);
    expect(response.body).not.toContain(otherConversation);
  });
});
