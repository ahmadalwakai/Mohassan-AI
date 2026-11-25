import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatConversation } from '@mohassan/contracts';
import { MemoryItemSchema, MemoryWorkspaceSchema } from '@mohassan/memory';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../apps/server/src/app.js';

// Development integration cases only. Requests come from the task or pinned
// repository tests, with deterministic substitutions. Never use for training.
const company = 'اسم شركتي النخبة للنقل';
const rememberCompany = 'تذكر أن اسم شركتي هو النخبة للنقل';
const companyQuestion = 'وش اسم شركتي؟';
const companyPayload = rememberCompany.slice('تذكر أن '.length);
const secondCompany = 'شركة السرو'; // assistant-memory-json-subject-audit.test.ts
const thirdCompany = 'النورس'; // assistant-memory-json-subject-audit.test.ts
const liveStatement = 'أنا ساكن في جدة';
const liveQuestion = 'where do I live?';
const birthdayStatement = "my wife's birthday is 3 May";
const phoneQuestion = 'what is my phone number?'; // assistant-own-fact-question.test.ts
const phone = '0501234567'; // assistant-own-fact-question.test.ts
const alternatePhone = '0551234567'; // sites-plan.test.ts
const secretRequest = 'تذكر أن رمز التحقق هو ١٢٣٤'; // assistant-legacy-memory-statement.test.ts
const secretValue = secretRequest.split(' ').at(-1)!;
const exactRequest = 'Remember that I prefer Arabic.'; // assistant-user-fact-memory-chat.test.ts
const exactLiteral = 'Remember exactly this note: "Open the browser, then send a message."'; // assistant-user-fact-memory-chat.test.ts
const benignLiteral = 'Remember exactly this note: «كلمة المرور تعني وسيلة للدخول»'; // assistant-user-fact-memory-receipt.test.ts
const exactResidence = 'Remember that I live in Muscat.'; // assistant-current-memory-declaration.test.ts

const origin = 'http://127.0.0.1:3000';
const applications: { directory: string; application?: Awaited<ReturnType<typeof createApplication>> }[] = [];

async function setup(enabled?: true) {
  vi.stubEnv('MOHASSAN_STRUCTURED_MEMORY', enabled ? '1' : undefined);
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'mohassan-structured-memory-'));
  const fixture: (typeof applications)[number] = { directory };
  applications.push(fixture);
  const internalSecret = randomUUID(), setupToken = randomUUID(), authSecret = randomUUID();
  const noExternalCall = vi.fn(async (): Promise<never> => { throw new Error('External calls are outside this fixture.'); });
  const application = await createApplication({
    authSecret, internalSecret, setupToken, webOrigin: origin, production: false, runWorker: false,
    codingAllowedRoots: [directory], codingDataDir: join(directory, 'coding'),
    documentsDir: join(directory, 'documents'), browserProfileDir: join(directory, 'browser'),
    aiFetch: noExternalCall, browser: { searchProvider: { name: 'Structured memory fixture', search: noExternalCall } },
    memberDailyRuns: 100, testRequestLimit: 1000,
  });
  fixture.application = application;
  const { app, database: { db } } = application;
  const headers = (cookie?: string) => ({ origin, 'x-mohassan-internal': internalSecret, ...(cookie ? { cookie } : {}) });
  const credentials = (name: string) => ({ name, email: `${randomUUID()}@example.test`, password: randomUUID() });

  async function signIn(account: ReturnType<typeof credentials>) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: headers(),
      payload: { email: account.email, password: account.password } });
    expect(response.statusCode).toBe(200);
    const cookie = [response.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    expect(cookie).toBeTruthy();
    return cookie;
  }

  const owner = credentials('Structured memory owner');
  const created = await app.inject({ method: 'POST', url: '/api/setup', headers: headers(), payload: { ...owner, setupToken } });
  expect(created.statusCode).toBe(200);
  const ownerCookie = await signIn(owner);

  async function inviteMember(name: string) {
    const account = credentials(name);
    const invited = await app.inject({ method: 'POST', url: '/api/members/invites', headers: headers(ownerCookie),
      payload: { name, email: account.email } });
    expect(invited.statusCode).toBe(200);
    const token = new URL(invited.json().url).hash.replace('#invite=', '');
    const accepted = await app.inject({ method: 'POST', url: '/api/invites/accept', headers: headers(),
      payload: { token, name, password: account.password } });
    expect(accepted.statusCode).toBe(200);
    const cookie = await signIn(account);
    const access = await app.inject({ url: '/api/access', headers: headers(cookie) });
    expect(access.statusCode).toBe(200);
    expect(access.json().role).toBe('member');
    return cookie;
  }

  async function settle(cookie: string, id: string, allowQuestion = false) {
    return vi.waitFor(async () => {
      const response = await app.inject({ url: `/api/chat/conversations/${id}`, headers: headers(cookie) });
      expect(response.statusCode).toBe(200);
      const detail = response.json<ChatConversation>();
      expect(allowQuestion ? ['idle', 'waiting_user'] : ['idle']).toContain(detail.status);
      expect(detail.error).toBeNull();
      const text = detail.messages.findLast(message => message.role === 'assistant')?.text ?? detail.question?.prompt;
      expect(text).toBeTruthy();
      const run = await db.selectFrom('chat_runs').select(['id', 'status', 'created_at'])
        .where('conversation_id', '=', id).orderBy('created_at', 'desc').limit(1).executeTakeFirstOrThrow();
      expect(noExternalCall.mock.calls.length).toBe(0);
      return { text: text!, run, detail };
    }, { timeout: 10000, interval: 40 });
  }

  async function start(cookie: string, goal?: string) {
    const response = await app.inject({ method: 'POST', url: '/api/chat/conversations', headers: headers(cookie), payload: goal ? { goal } : {} });
    expect(response.statusCode).toBe(200);
    return response.json<ChatConversation>().id;
  }

  async function say(cookie: string, id: string, text: string, allowQuestion = false) {
    const response = await app.inject({ method: 'POST', url: `/api/chat/conversations/${id}/messages`, headers: headers(cookie), payload: { text } });
    expect(response.statusCode).toBe(200);
    return settle(cookie, id, allowQuestion);
  }

  async function items(cookie: string) {
    const response = await app.inject({ url: '/api/memory', headers: headers(cookie) });
    expect(response.statusCode).toBe(200);
    return MemoryWorkspaceSchema.parse(response.json()).items;
  }

  return { app, db, headers, ownerCookie, inviteMember, start, say, settle, items };
}

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  vi.unstubAllEnvs();
  for (const { directory, application } of applications) {
    await application?.app.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

describe('structured memory over the authenticated chat routes', () => {
  let fixture: Awaited<ReturnType<typeof setup>>, first: string, second: string;

  beforeAll(async () => {
    fixture = await setup(true);
    first = await fixture.inviteMember('Structured memory member A');
    second = await fixture.inviteMember('Structured memory member B');
  }, 60000);

  it('asks for consent on a bare statement and keeps memory isolated between two members', async () => {
    const { app, start, say, headers, items } = fixture;
    const firstId = await start(first), secondId = await start(second);
    const bare = await say(first, firstId, company);
    expect(bare.text).toMatch(/حفظ هذه المعلومة/u);
    expect((await items(first)).some(item => item.content === companyPayload)).toBe(false);

    const saved = await say(first, firstId, rememberCompany);
    expect(saved.run.status).toBe('completed');
    const stored = (await items(first)).find(item => item.content === companyPayload);
    expect(stored?.content).toBe(companyPayload);
    expect((await items(second)).some(item => item.content === companyPayload)).toBe(false);
    expect((await app.inject({ url: `/api/chat/conversations/${firstId}`, headers: headers(second) })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/memory/items/${stored!.id}`, headers: headers(second) })).statusCode).toBe(404);
    const absent = await say(second, secondId, companyQuestion);
    expect(absent.text).not.toContain(companyPayload);

    const sameProperty = rememberCompany.replace('النخبة للنقل', secondCompany);
    expect((await say(second, secondId, sameProperty)).run.status).toBe('completed');
    expect((await say(second, secondId, companyQuestion)).text).toContain(secondCompany);
    const recalled = await say(first, firstId, companyQuestion);
    expect(recalled.run.status).toBe('completed');
    expect(recalled.text).toContain(companyPayload);
    expect(recalled.text).toContain(stored!.createdAt.slice(0, 10));
    expect(recalled.text).not.toContain(secondCompany);
  }, 20000);

  it('uses the conversation to resolve a correction and keeps the earlier literal version', async () => {
    const { app, headers, ownerCookie, start, say, items } = fixture;
    const id = await start(ownerCookie);
    const correction = `لا، اسمها ${thirdCompany}`;
    expect((await say(ownerCookie, id, rememberCompany)).run.status).toBe('completed');
    expect((await say(ownerCookie, id, companyQuestion)).text).toContain(companyPayload);
    expect((await say(ownerCookie, id, correction)).run.status).toBe('completed');
    const current = (await items(ownerCookie)).find(item => item.content.includes(thirdCompany));
    expect(current?.content).toContain(thirdCompany);
    const detail = await app.inject({ url: `/api/memory/items/${current!.id}`, headers: headers(ownerCookie) });
    expect(detail.statusCode).toBe(200);
    const versions = MemoryItemSchema.array().parse(detail.json().versions);
    expect(versions).toHaveLength(2);
    expect(versions.map(version => version.status)).toEqual(['active', 'superseded']);
    expect(versions[0]?.content).toContain(thirdCompany);
    expect(versions[1]?.content).toBe(companyPayload);
    expect((await say(ownerCookie, id, companyQuestion)).text).toContain(thirdCompany);
  }, 20000);

  it('recalls an Arabic residence in English and honors an explicit address update', async () => {
    const { start, say } = fixture;
    const id = await start(first);
    expect((await say(first, id, `تذكر أن ${liveStatement}`)).run.status).toBe('completed');
    expect((await say(first, id, liveQuestion)).text).toContain(liveStatement);
    const replacement = 'Bristol'; // assistant-current-memory-declaration-chat.test.ts
    const update = await say(first, id, `غيّر عنواني إلى ${replacement}`);
    expect(update.run.status, update.text).toBe('completed');
    const recalled = await say(first, id, liveQuestion);
    expect(recalled.text).toContain(replacement);
    expect(recalled.text).not.toContain(liveStatement);
  }, 20000);

  it('requires an existing fact for a correction to change memory', async () => {
    const { items, start, say } = fixture;
    const before = await items(second);
    const replacement = 'Bristol'; // assistant-current-memory-declaration-chat.test.ts
    const corrected = await say(second, await start(second), `غيّر عنواني إلى ${replacement}`);
    expect(corrected.run.status).toBe('blocked');
    expect(await items(second)).toEqual(before);
  }, 20000);

  it('persists both time bounds and quotes the original timed statement on recall', async () => {
    const { db, ownerCookie, start, say, items } = fixture;
    const id = await start(ownerCookie);
    const day = 86400000;
    const since = new Date(Date.now() - day).toISOString().slice(0, 10), until = new Date(Date.now() + day).toISOString().slice(0, 10);
    const statement = `${liveStatement} منذ ${since} حتى ${until}`;
    expect((await say(ownerCookie, id, `تذكر أن ${statement}`)).run.status).toBe('completed');
    const stored = (await items(ownerCookie)).find(item => item.content === statement);
    expect(stored).toBeDefined();
    const fields = await db.selectFrom('memory_structured_versions').select(['value', 'valid_since', 'valid_until'])
      .where('item_id', '=', stored!.id).executeTakeFirstOrThrow();
    expect(fields).toEqual({ value: 'جدة', valid_since: since, valid_until: until });
    const recalled = await say(ownerCookie, id, liveQuestion);
    expect(recalled.run.status).toBe('completed');
    expect(recalled.text).toContain(`“${statement}”`);
    expect(recalled.text).toContain(stored!.createdAt.slice(0, 10));
  }, 20000);

  it('recalls an English family fact in response to a birthday question', async () => {
    const { items, start, say } = fixture;
    const id = await start(second);
    expect((await say(second, id, `Remember that ${birthdayStatement}`)).run.status).toBe('completed');
    const saved = (await items(second)).find(item => item.content === birthdayStatement);
    expect(saved).toBeDefined();
    const target = birthdayStatement.split(' is ')[0];
    const recalled = await say(second, id, `when is ${target}?`);
    expect(recalled.run.status).toBe('completed');
    expect(recalled.text).toContain(`“${birthdayStatement}”`);
    expect(recalled.text).toContain(saved!.createdAt.slice(0, 10));
  }, 20000);

  it('preserves exact literal-note and language-preference verification with the flag enabled', async () => {
    const { db, ownerCookie, start, say } = fixture;
    for (const [request, payload] of [
      [exactLiteral, exactLiteral.split('"')[1]],
      [benignLiteral, benignLiteral.split(/[«»]/u)[1]],
      [exactRequest, exactRequest.slice('Remember that '.length)],
    ] as const) {
      const saved = await say(ownerCookie, await start(ownerCookie), request);
      expect(saved.run.status).toBe('completed');
      const checked = await db.selectFrom('chat_runs').select('state').where('id', '=', saved.run.id).executeTakeFirstOrThrow();
      expect(checked.state.userFactMemory.phase).toBe('verified');
      expect(checked.state.userFactMemory.receipt.payload.text).toBe(payload);
    }
  }, 20000);

  it('forgets only the requesting member’s fact and removes its item', async () => {
    const { app, headers, items, start, say } = fixture;
    const statement = `تذكر أن رقمي هو ${phone}`;
    const firstId = await start(first), secondId = await start(second);
    expect((await say(first, firstId, statement)).run.status).toBe('completed');
    expect((await say(second, secondId, statement)).run.status).toBe('completed');
    expect((await say(first, firstId, phoneQuestion)).text).toContain(phone);
    const stored = (await items(first)).find(item => item.content.includes(phone));
    expect(stored).toBeDefined();
    expect((await say(first, firstId, statement.replace(phone, alternatePhone))).run.status).toBe('completed');
    const updated = (await items(first)).find(item => item.content.includes(alternatePhone));
    expect(updated?.version).toBe(2);
    expect((await say(first, firstId, 'انس رقم هاتفي')).run.status).toBe('completed');
    expect((await app.inject({ url: `/api/memory/items/${stored!.id}`, headers: headers(first) })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/memory/items/${updated!.id}`, headers: headers(first) })).statusCode).toBe(404);
    expect((await say(first, firstId, phoneQuestion)).text).not.toContain(phone);
    const freshRecall = await say(first, await start(first), phoneQuestion);
    expect(freshRecall.text).not.toContain(phone);
    expect(freshRecall.text).not.toContain(alternatePhone);
    expect((await say(second, secondId, phoneQuestion)).text).toContain(phone);
  }, 20000);

  it('refuses a credential in Arabic and preserves memory on a denied or quoted request', async () => {
    const { db, ownerCookie, start, settle, say, items } = fixture;
    const before = await items(ownerCookie);
    const id = await start(ownerCookie, secretRequest);
    const refused = await settle(ownerCookie, id);
    expect(refused.run.status).toBe('blocked');
    expect(refused.text).toMatch(/سر|رمز|كلم[ةه] مرور/u);
    expect(JSON.stringify(refused.detail).includes(secretValue)).toBe(false);
    const persisted = await db.selectFrom('chat_runs').select(['goal', 'state']).where('id', '=', refused.run.id).executeTakeFirstOrThrow();
    expect(JSON.stringify(persisted).includes(secretValue)).toBe(false);
    const sendRefused = await say(ownerCookie, id, secretRequest);
    expect(sendRefused.run.status).toBe('blocked');
    expect(JSON.stringify(sendRefused.detail).includes(secretValue)).toBe(false);
    // Denial suffix and quote delimiters from the pinned receipt tests.
    const denied = exactRequest.replace('I prefer Arabic.', "my wife's birthday is 3 May, but do not save anything.");
    expect((await say(ownerCookie, await start(ownerCookie), denied, true)).run.status).not.toBe('completed');
    expect((await say(ownerCookie, await start(ownerCookie), `«${rememberCompany}»`, true)).run.status).not.toBe('completed');
    expect(await items(ownerCookie)).toEqual(before);
  }, 20000);

  it('deduplicates secret refusals using the sanitized request digest', async () => {
    const { app, db, headers, start, settle } = fixture;
    const opened = await start(second);
    const otherSecret = secretRequest.replace(secretValue, Array.from(secretValue).reverse().join(''));
    const routes = [
      { scope: 'create', url: '/api/chat/conversations', field: 'goal' },
      { scope: `messages:${opened}`, url: `/api/chat/conversations/${opened}/messages`, field: 'text' },
    ];
    for (const { scope, url, field } of routes) {
      const key = randomUUID();
      const send = (text: string) => app.inject({ method: 'POST', url, headers: { ...headers(second), 'idempotency-key': key },
        payload: { [field]: text } });
      const accepted = await send(secretRequest);
      expect(accepted.statusCode).toBe(200);
      const id = accepted.json<ChatConversation>().id;
      const settled = await settle(second, id);
      expect(settled.run.status).toBe('blocked');
      const sanitized = settled.detail.messages.find(message => message.role === 'user')?.text;
      expect(typeof sanitized).toBe('string');
      expect(sanitized?.includes(secretValue)).toBe(false);
      const retry = await send(otherSecret);
      expect(retry.statusCode).toBe(200);
      expect(retry.json<ChatConversation>().id).toBe(id);
      expect((await send(rememberCompany)).statusCode).toBe(409);

      const digest = (text: string) => createHash('sha256').update(`${scope}\n${JSON.stringify({ [field]: text })}`).digest('hex');
      const receipt = await db.selectFrom('chat_request_keys').select(['body_hash', 'response'])
        .where('request_key', '=', key).executeTakeFirstOrThrow();
      expect(receipt.body_hash === digest(secretRequest)).toBe(false);
      expect(receipt.body_hash === digest(sanitized!)).toBe(true);
      expect(JSON.stringify(receipt.response).includes(secretValue)).toBe(false);
      const runs = await db.selectFrom('chat_runs').select('id').where('conversation_id', '=', id).execute();
      expect(runs).toEqual([{ id: settled.run.id }]);
    }
  }, 20000);

  it('rolls back verified memory if the terminal assistant message cannot be inserted', async () => {
    const { app, db, headers, items, ownerCookie, start, say } = fixture;
    const before = await items(ownerCookie);
    const id = await start(ownerCookie);
    const statement = `Remember that ${birthdayStatement}`;
    await db.transaction().execute(async tx => {
      await sql`CREATE FUNCTION reject_structured_reply() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM memory_structured_operations
            WHERE conversation_id = NEW.conversation_id AND outcome = 'saved') THEN
            RAISE EXCEPTION 'Fixture blocked the terminal memory reply';
          END IF;
          RETURN NEW;
        END;
      $$`.execute(tx);
      await sql`CREATE TRIGGER reject_structured_reply BEFORE INSERT ON chat_messages
        FOR EACH ROW WHEN (NEW.role = 'assistant') EXECUTE FUNCTION reject_structured_reply()`.execute(tx);
    });
    try {
      const sent = await app.inject({ method: 'POST', url: `/api/chat/conversations/${id}/messages`,
        headers: headers(ownerCookie), payload: { text: statement } });
      expect(sent.statusCode).toBe(200);
      await vi.waitFor(async () => {
        const response = await app.inject({ url: `/api/chat/conversations/${id}`, headers: headers(ownerCookie) });
        expect(response.statusCode).toBe(200);
        const detail = response.json<ChatConversation>();
        expect(detail.status).toBe('failed');
        expect(detail.messages.some(message => message.role === 'assistant')).toBe(false);
      }, { timeout: 10000, interval: 40 });
      expect(await items(ownerCookie)).toEqual(before);
      expect(await db.selectFrom('memory_structured_operations').select('run_id').where('conversation_id', '=', id).execute()).toEqual([]);
    } finally {
      await sql`DROP TRIGGER reject_structured_reply ON chat_messages`.execute(db);
      await sql`DROP FUNCTION reject_structured_reply()`.execute(db);
    }
    expect((await say(ownerCookie, id, statement)).run.status).toBe('completed');
    expect((await items(ownerCookie)).some(item => item.content === birthdayStatement)).toBe(true);
  }, 20000);

  it('refuses secrets when creating and correcting items through the memory API', async () => {
    const { app, headers, items } = fixture;
    const body = { title: 'Saved note', content: exactLiteral.split('"')[1], layer: 'semantic' };
    const created = await app.inject({ method: 'POST', url: '/api/memory/items', headers: headers(second), payload: body });
    expect(created.statusCode).toBe(200);
    const item = MemoryItemSchema.parse(created.json());
    const before = await items(second);
    for (const [url, payload] of [
      ['/api/memory/items', { ...body, content: secretRequest }],
      [`/api/memory/items/${item.id}/correct`, { ...body, content: secretRequest, expectedVersion: item.version, reason: 'Fixture correction' }],
    ] as const) {
      const response = await app.inject({ method: 'POST', url, headers: headers(second), payload });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
      expect(response.json().error.code).toBe('MEMORY_SECRET_REJECTED');
      expect(/سر|رمز|كلم[ةه] مرور/u.test(response.json().error.message)).toBe(true);
      expect(response.body.includes(secretValue)).toBe(false);
    }
    expect(await items(second)).toEqual(before);
  }, 20000);
});

it('defaults to the existing literal-note path and shadows a structured candidate without its text', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const { ownerCookie, start, say, items } = await setup();
  const id = await start(ownerCookie);
  const ordinary = await say(ownerCookie, id, rememberCompany);
  expect(ordinary.run.status).toBe('blocked');
  expect(await items(ownerCookie)).toHaveLength(0);
  const shadow = info.mock.calls.filter(entry => JSON.stringify(entry).includes('structured_memory_shadow'));
  expect(shadow.length).toBeGreaterThan(0);
  expect(JSON.stringify(shadow)).not.toContain('النخبة للنقل');
  const literal = await say(ownerCookie, id, exactRequest);
  expect(literal.run.status).toBe('completed');
  expect((await items(ownerCookie)).map(item => item.content)).toEqual(['I prefer Arabic.']);
  expect((await say(ownerCookie, id, exactResidence)).run.status).toBe('completed');
  const statement = exactResidence.slice('Remember that '.length);
  const legacy = (await items(ownerCookie)).find(item => item.content === statement);
  expect(legacy).toBeDefined();
  vi.stubEnv('MOHASSAN_STRUCTURED_MEMORY', '1');
  const recalled = await say(ownerCookie, id, liveQuestion);
  expect(recalled.run.status).toBe('completed');
  expect(recalled.text).toContain(`“${statement}”`);
  expect(recalled.text).toContain(legacy!.createdAt.slice(0, 10));
}, 60000);
