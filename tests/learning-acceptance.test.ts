import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { recordExperience } from '@mohassan/learning';
import { Runtime } from '@mohassan/runtime';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { migrateAuth } from '../apps/server/src/auth.js';
import { registerMemoryRoutes } from '../apps/server/src/memory.js';

const ownerId = 'isolated-learning-owner';
const secret = 'fixture-private-learning-password';
const rawPage = 'fixture-raw-page-body';
const answer: Record<string, unknown> = { tool: 'answer', text: 'تمت المراجعة.', outcome: 'done' };
const waitForOwner = { tool: 'ask_user', text: 'كيف تريد المتابعة؟', options: ['تابع', 'توقّف'] };

let directory: string;
let origin: string;
let database: Awaited<ReturnType<typeof createDatabase>>;
let chat: Awaited<ReturnType<typeof createCommandChatControl>>;
let runtime: Runtime;
let decisions: Record<string, unknown>[] = [];
let skipCapture = false;

const site = createServer((request, response) => {
  if (request.url === '/redirect') {
    response.writeHead(302, { location: '/different' }).end();
    return;
  }
  response.writeHead(request.url === '/missing-page' ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' })
    .end(`<html lang="ar"><title>صفحة الاختبار</title><main>${rawPage}</main></html>`);
});

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mohassan-learning-l1-'));
  await new Promise<void>((resolve, reject) => {
    site.once('error', reject);
    site.listen(0, '127.0.0.1', resolve);
  });
  const address = site.address();
  if (!address || typeof address === 'string') throw new Error('No isolated browser fixture port');
  origin = `http://127.0.0.1:${address.port}`;
  database = await createDatabase();
  await migrate(database.db);
  runtime = new Runtime(database.db);
  class FixtureBrowser extends AgentBrowser {
    override async screen(owner: string, conversation: string) {
      return skipCapture ? null : super.screen(owner, conversation);
    }
  }
  chat = await createCommandChatControl(database.db, {
    browser: new FixtureBrowser({profileDir: directory, channel: null, testOrigins: [origin]}),
    apiKey: 'isolated-scripted-key', models: {fast: ['fixture'], deep: ['fixture'], vision: 'fixture'},
    async fetch(_url, init) {
      const { model } = JSON.parse(String(init?.body));
      const decision: Record<string, unknown> = decisions.shift() ?? answer;
      return Response.json({model, choices: [{finish_reason: 'stop', message: {content: JSON.stringify({
        thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null,
        options: null, sensitive: null, outcome: null, ...decision,
      })}}], usage: {prompt_tokens: 10, completion_tokens: 5}});
    },
    searchProvider: {name: 'isolated-search', async search() {
      return [{url: `${origin}/search`, title: 'مصدر تجريبي', snippet: `password=${secret} ${rawPage}`}];
    }},
    tools: {
      work: {
        async list() { return 'isolated-project'; },
        async code() { return {id: 'local-code', label: 'تعديل', prompt: 'هل توافق؟', detail: 'مقترح تجريبي'}; },
        async studio() { return {id: 'local-studio', label: 'تعديل', prompt: 'هل توافق؟', detail: 'مقترح تجريبي'}; },
        async approve() { throw new Error('Unexpected approval'); },
        async cancel() {},
        async outcome() { return {settled: true, text: 'مقترح فقط'}; },
      },
      computer: {
        async view() { return {title: 'اختبار', elements: [
          {ref: 'c1', type: 'button', name: 'عرض التفاصيل'}, {ref: 'c2', type: 'button', name: 'Delete'},
        ], jpeg: '', hasPasswordField: false, canAct: true}; },
        async perform() { return 'تم استلام الأمر التجريبي.'; },
      },
    },
  });
}, 60_000);

afterAll(async () => {
  await chat?.shutdown();
  await runtime?.stop();
  await database?.close();
  if (site.listening) await new Promise<void>(resolve => site.close(() => resolve()));
  if (directory) await rm(directory, {recursive: true, force: true});
});

it('records 20 isolated terminal tasks once with goal-bound evidence and redaction', async () => {
  const expected = new Map<string, {category: string; outcome: string; terminal_status: string}>();
  async function runChat(goal: string, category: string, options: {
    decisions?: Record<string, unknown>[]; end?: 'cancel' | 'interrupt'; outcome?: string; status?: string;
  } = {}) {
    decisions = options.decisions ?? [];
    const conversation = await chat.create(ownerId, {goal});
    await chat.settled(conversation.id);
    const run = await database.db.selectFrom('chat_runs').select('id').where('conversation_id', '=', conversation.id).executeTakeFirstOrThrow();
    if (options.end === 'cancel') {
      await chat.cancel(ownerId, conversation.id);
      await chat.cancel(ownerId, conversation.id);
    }
    if (options.end === 'interrupt') {
      await database.db.updateTable('chat_runs').set({lease_expires_at: new Date(0)}).where('id', '=', run.id).execute();
      await chat.detail(ownerId, conversation.id);
      await chat.detail(ownerId, conversation.id);
    }
    expected.set(run.id, {category, outcome: options.outcome ?? 'unverified', terminal_status: options.status ?? 'completed'});
    return run.id as string;
  }

  const ordinary = await runChat('أجب عن سؤال عادي.', 'conversation');
  await runChat('أخبرني بالنتيجة.', 'conversation', {decisions: [{...answer, text: 'أؤكد أن المهمة نجحت وتم التحقق منها.'}]});
  const redacted = await runChat(`لأغراض الاختبار password=${secret}`, 'conversation', {decisions: [{...answer, plan: [`password=${secret}`]}]});
  await runChat('اطلب تحديد الخيار.', 'conversation', {decisions: [waitForOwner], end: 'cancel', status: 'cancelled'});
  await runChat('انتظر جوابي.', 'conversation', {decisions: [waitForOwner], end: 'interrupt', status: 'interrupted'});
  await runChat(`افتح ${origin}/first`, 'browser', {outcome: 'verified_success'});
  const captured = await runChat(`افتح ${origin}/capture واعرض لقطة من الصفحة`, 'browser', {outcome: 'verified_success'});
  skipCapture = true;
  await runChat(`افتح ${origin}/missing واعرض لقطة من الصفحة`, 'browser', {outcome: 'verified_failure', status: 'partial'});
  skipCapture = false;
  await runChat(`افتح ${origin}/redirect`, 'browser');
  await runChat(`افتح ${origin}/missing-page`, 'browser', {outcome: 'verified_failure'});
  for (const query of ['مكتبة', 'مدرسة']) {
    await runChat(`ابحث عن ${query}.`, 'research', {decisions: [{tool: 'search', text: query}, answer]});
  }
  for (const tool of ['code_change', 'studio_change']) {
    await runChat('جهّز تعديلًا للمراجعة.', 'coding', {decisions: [{tool, url: 'project', text: 'تعديل العنوان'}], end: 'cancel', status: 'cancelled'});
  }
  await runChat('اقرأ النافذة.', 'computer', {decisions: [{tool: 'computer_view'}, answer]});
  await runChat('اعرض التفاصيل في النافذة.', 'computer', {decisions: [{tool: 'computer_view'}, {tool: 'computer_click', ref: 'c1'}, answer]});
  await runChat('أعد إجراء الحذف للموافقة.', 'computer', {decisions: [{tool: 'computer_view'}, {tool: 'computer_click', ref: 'c2'}], end: 'cancel', status: 'cancelled'});

  for (const [autonomy, shouldCancel] of [['scoped', false], ['shadow', false], ['scoped', true]] as const) {
    const title = `فحص محلي ${autonomy} ${shouldCancel}`;
    const task = await runtime.createTask(ownerId, {title, goal: title, capabilityId: 'system.diagnostic', autonomy}, title);
    if (shouldCancel) await runtime.cancel(ownerId, task.id);
    else await runtime.tick();
    expected.set(task.id, {category: 'conversation', terminal_status: shouldCancel ? 'cancelled' : 'completed',
      outcome: shouldCancel || autonomy === 'shadow' ? 'unverified' : 'verified_success'});
  }

  await recordExperience(database.db, {ownerId, sourceKind: 'chat_run', sourceId: ordinary, terminalStatus: 'completed',
    goal: 'replayed source must not overwrite', category: 'conversation', attempt: 1});
  const rows = await database.db.selectFrom('experiences').selectAll().where('owner_id', '=', ownerId).execute();
  expect(rows).toHaveLength(20);
  for (const row of rows) expect(row, row.goal).toMatchObject(expected.get(row.source_id)!);
  expect(rows.find(row => row.source_id === ordinary)?.goal).toBe('أجب عن سؤال عادي.');
  expect(rows.find(row => row.source_id === redacted)?.models[0]).toMatchObject({inputTokens: 10, outputTokens: 5, usageKnown: true});
  expect(rows.find(row => row.source_id === captured)?.artifact_hashes).toHaveLength(2);
  expect(JSON.stringify(rows)).not.toMatch(new RegExp(`${secret}|${rawPage}`));
}, 60_000);

it('exposes owned feedback, including an early task rating and a separately confirmed chat outcome', async () => {
  const app = Fastify();
  try {
    await migrateAuth(database.db);
    await database.db.insertInto('user').values({id: ownerId, name: 'Test owner', email: 'learning-owner@example.test'}).execute();
    await registerMemoryRoutes(app, {db: database.db, owner: async request => ({id: request.headers['x-fixture-owner'] ?? ownerId})});
    const conversation = await chat.create(ownerId, {goal: 'أجب عن السؤال للتحقق اليدوي.'});
    await chat.settled(conversation.id);
    const run = await database.db.selectFrom('chat_runs').select('id').where('conversation_id', '=', conversation.id).executeTakeFirstOrThrow();
    const task = await runtime.createTask(ownerId, {title: 'فحص مرتبط', goal: 'افحص البيئة المحلية.', capabilityId: 'system.diagnostic', autonomy: 'scoped'}, 'linked-learning-task', run.id);
    const early = await app.inject({method: 'POST', url: '/api/memory/feedback', payload: {
      taskId: task.id, kind: 'task_correction', comment: 'تقييم مبكر', rating: 4, submissionKey: 'learning-early-rating',
    }});
    expect(early.statusCode).toBe(200);
    await runtime.tick();

    const feedbackUrl = `/api/learning/experiences/chat_run/${run.id}/feedback`;
    const rating = {submissionKey: 'learning-chat-rating', expectedAttempt: 1, rating: 5};
    const confirmation = {submissionKey: 'learning-chat-confirm', expectedAttempt: 1, confirmed: 'success'};
    const other = await app.inject({method: 'POST', url: feedbackUrl, payload: confirmation, headers: {'x-fixture-owner': 'other-owner'}});
    expect(other.statusCode).toBe(404);
    expect((await app.inject({method: 'POST', url: feedbackUrl, payload: rating})).json().outcome).toBe('unverified');
    expect((await app.inject({method: 'POST', url: feedbackUrl, payload: confirmation})).json().outcome).toBe('verified_success');
    const list = await app.inject({url: '/api/learning/experiences'});
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({sourceId: task.id, parentRunId: run.id, rating: 4, evidenceKind: 'test_result'}),
      expect.objectContaining({sourceId: run.id, rating: 5, evidenceKind: 'owner_confirmed'}),
    ]));
    expect((await app.inject({url: '/api/learning/experiences', headers: {'x-fixture-owner': 'other-owner'}})).json().items).toEqual([]);
  } finally {
    await app.close();
  }
});

it('keeps an evaluation conversation out of the experience store', async () => {
  const evaluation = await createCommandChatControl(database.db, {
    browser: new AgentBrowser({profileDir: join(directory, 'evaluation'), channel: null, allowedOrigins: [origin]}),
    apiKey: 'isolated-scripted-key', models: {fast: ['fixture'], deep: ['fixture'], vision: 'fixture'},
    recordExperiences: false,
    async fetch() {
      return Response.json({model: 'fixture', choices: [{finish_reason: 'stop', message: {content: JSON.stringify({
        thought: null, plan: null, note: null, url: null, ref: null, submit: null, options: null, sensitive: null, ...answer,
      })}}], usage: {prompt_tokens: 10, completion_tokens: 5}});
    },
  });
  try {
    const conversation = await evaluation.create(ownerId, {goal: 'حالة تقييم اصطناعية.'});
    await evaluation.settled(conversation.id);
    const run = await database.db.selectFrom('chat_runs').select(['id', 'status']).where('conversation_id', '=', conversation.id).executeTakeFirstOrThrow();
    expect(run.status).toBe('completed');
    expect(await database.db.selectFrom('experiences').select('source_id').where('source_id', '=', run.id).execute()).toEqual([]);
  } finally {
    await evaluation.shutdown();
  }
});
