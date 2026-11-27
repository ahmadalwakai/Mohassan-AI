import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect } from 'kysely';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentBrowser, AgentAction, SearchProvider } from '@mohassan/browser';
import { migrate } from '@mohassan/database';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { migrateMemberDataRights } from '../apps/server/src/member-data-migration.js';
import { migrateMembers, roleOf } from '../apps/server/src/members.js';
import { monitorChat } from '../apps/server/src/monitors/chat.js';
import { migrateReminders } from '../apps/server/src/reminders/migration.js';

/**
 * The model-free hands through the real chat controller: a question is answered by reading its sources over HTTP
 * (no browser action at all), an unsupported request gets an honest reply before any search, a refused search ends
 * as a reply rather than a failed run, and a follow-up keeps the earlier topic. Measured causes: 0-baseline §8–§9.
 */
const owner = 'isolated-http-hands-owner';
let database: Kysely<any> | undefined;
let control: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;

afterEach(async () => {
  await control?.shutdown();
  await database?.destroy();
  control = undefined;
  database = undefined;
  vi.unstubAllEnvs();
});

const japan = 'https://ar.wikipedia.org/wiki/%D8%A7%D9%84%D9%8A%D8%A7%D8%A8%D8%A7%D9%86';
const tokyo = 'https://ar.wikipedia.org/wiki/%D8%B7%D9%88%D9%83%D9%8A%D9%88';
const texts: Record<string, { title: string; text: string }> = {
  [japan]: { title: 'اليابان - ويكيبيديا', text: 'اليابان دولة جزرية في شرق آسيا، عاصمتها طوكيو وهي أكبر مدنها.\nيبلغ عدد سكان اليابان نحو 125 مليون نسمة حسب إحصاء 2023 وهو في تناقص مستمر منذ سنوات.\n' },
  [tokyo]: { title: 'طوكيو - ويكيبيديا', text: 'طوكيو عاصمة اليابان وأكبر مدنها، وتقع على الساحل الشرقي لجزيرة هونشو في منطقة كانتو الواسعة.\n' },
};

async function harness(options: { member?: boolean; onRead?: (url: string, signal: AbortSignal) => Promise<void> } = {}) {
  let statements = 0;
  let transactions = 0;
  class CountingDialect extends PGliteDialect {
    override createDriver() {
      const driver = super.createDriver();
      const begin = driver.beginTransaction.bind(driver);
      vi.spyOn(driver, 'beginTransaction').mockImplementation((...args) => {
        transactions++;
        return begin(...args);
      });
      return driver;
    }
  }
  const db = database = new Kysely<any>({
    dialect: new CountingDialect({ pglite: new PGlite() }),
    plugins: [{
      transformQuery({ node }) { return node; },
      async transformResult({ result }) {
        statements++;
        return result;
      },
    }],
    log(event) { if (event.level === 'error') statements++; },
  });
  async function measure<T>(operation: () => Promise<T>) {
    const startStatements = statements;
    const startTransactions = transactions;
    const result = await operation();
    return { result, queries: statements - startStatements, transactions: transactions - startTransactions };
  }
  await migrate(db);
  await migrateAuth(db);
  await migrateMembers(db);
  await migrateMemberDataRights(db);
  await db.insertInto('user').values({ id: owner, name: 'HTTP hands owner', email: 'http-hands-owner@example.test' }).execute();
  if (options.member) await db.insertInto('workspace_members').values({ user_id: owner, role: 'member' }).execute();
  else await db.insertInto('workspace_owner').values({ id: 1, owner_id: owner }).execute();
  const queries: string[] = [];
  const actions: AgentAction[] = [];
  const reads: string[] = [];
  const searchProvider: SearchProvider = {
    name: 'isolated-public-search',
    async search(query) {
      queries.push(query);
      return [{ title: 'اليابان', url: japan, snippet: 'اليابان دولة جزرية عاصمتها طوكيو وعدد سكانها' }, { title: 'طوكيو', url: tokyo, snippet: 'طوكيو عاصمة اليابان' }];
    },
  };
  const browser = {
    setCheckpointStore() {},
    async bindAccount() {},
    async hasPage() { return false; },
    async observe() { throw new Error('No browser page should be observed'); },
    async activity() { return { sequence: 0, cursor: null }; },
    async screen() { return Buffer.alloc(1); },
    async act(_owner: string, _conversation: string, action: AgentAction) {
      actions.push(action);
      throw new Error(`Unexpected browser action: ${action.kind} ${action.text ?? ''}`);
    },
    async close() {},
  } as unknown as AgentBrowser;
  control = await createCommandChatControl(db, {
    models: { fast: [], deep: [], vision: '' }, browser, searchProvider,
    fullAccess: async ownerId => await roleOf(db, ownerId) === 'owner',
    async accountActive(ownerId, tx) {
      const role = await roleOf(tx, ownerId);
      if (role !== 'member') return role !== null;
      return Boolean(await tx.selectFrom('workspace_members').select('user_id').where('user_id', '=', ownerId)
        .where('role', '=', 'member').where('disabled_at', 'is', null).forShare().executeTakeFirst());
    },
    async readPage(url, signal) {
      reads.push(url);
      if (options.onRead) await options.onRead(url, signal);
      const found = texts[url];
      return found ? { url, title: found.title, text: found.text, status: 200 } : null;
    },
  });
  return { control, db, queries, actions, reads, measure };
}

function expectQueryBudget(label: string, { queries, transactions }: { queries: number; transactions: number },
  maxQueries: number, maxTransactions: number) {
  console.info(label, { queries, transactions });
  expect.soft(queries, `${label} queries`).toBeLessThanOrEqual(maxQueries);
  expect.soft(transactions, `${label} transactions`).toBeLessThanOrEqual(maxTransactions);
}

it('answers a question by reading its sources over HTTP, with no browser action', async () => {
  const { control, db, queries, actions, reads } = await harness();
  const { id } = await control.create(owner, { goal: 'ما عاصمة اليابان؟' });
  await control.settled(id);
  const result = await control.detail(owner, id);
  expect(result.error).toBeNull();
  expect(result.status).toBe('idle');
  expect(queries).toEqual(['ما عاصمة اليابان']);
  expect(actions).toEqual([]);
  expect(result.browser).toBeNull();
  expect(reads).toContain(japan);
  expect(result.messages.at(-1)?.text).toContain('عاصمتها طوكيو');
  expect(result.messages.at(-1)?.text).toContain('**المصدر:**');
  const runs = await db.selectFrom('chat_runs').select('status').where('conversation_id', '=', id).execute();
  expect(runs.map(run => run.status)).toEqual(['completed']);
});

it('keeps the earlier topic in a follow-up that only points at it', async () => {
  const { control, queries } = await harness();
  const { id } = await control.create(owner, { goal: 'ما عاصمة اليابان؟' });
  await control.settled(id);
  await control.send(owner, id, { text: 'وكم عدد سكانها؟' });
  await control.settled(id);
  const result = await control.detail(owner, id);
  expect(result.error).toBeNull();
  expect(queries).toHaveLength(2);
  expect(queries[1]).toContain('اليابان');
  expect(result.messages.at(-1)?.text).toContain('125 مليون');
});

it('replies with an honest limit before any search for a request it cannot perform', async () => {
  const { control, queries, actions } = await harness();
  const { id } = await control.create(owner, { goal: 'ارسم لي صورة قطة' });
  await control.settled(id);
  const result = await control.detail(owner, id);
  expect(result.error).toBeNull();
  expect(result.status).toBe('idle');
  expect(queries).toEqual([]);
  expect(actions).toEqual([]);
  expect(result.messages.at(-1)?.text).toContain('لا أرسم الصور');
  const { id: second } = await control.create(owner, { goal: 'Book me a flight to Paris next Monday' });
  await control.settled(second);
  const booking = await control.detail(owner, second);
  expect(booking.error).toBeNull();
  expect(queries).toEqual([]);
  expect(booking.messages.at(-1)?.text).toContain('I do not book, buy, call or send');
});

it('takes a description of colours after a picture request as that picture, not as a search', async () => {
  // Real request rq091 (2026-11-22): a colour-on-background description after a logo was searched on its own words
  // and answered with a physics sentence from the article «لون». Own wording here, not the set's.
  const { control, queries, actions } = await harness();
  const { id } = await control.create(owner, { goal: 'can you draw pictures?' });
  await control.settled(id);
  await control.send(owner, id, { text: 'باللون الأخضر' });
  await control.settled(id);
  await control.send(owner, id, { text: 'أخضر على خلفية رمادية' });
  await control.settled(id);
  const result = await control.detail(owner, id);
  expect(result.error).toBeNull();
  expect(result.status).toBe('idle');
  expect(queries).toEqual([]);
  expect(actions).toEqual([]);
  const replies = result.messages.filter(message => message.role === 'assistant').map(message => message.text);
  expect(replies.at(-2)).toContain('فهمت «باللون الأخضر» وصفًا لشكل الصورة');
  expect(replies.at(-1)).toContain('فهمت «أخضر على خلفية رمادية» وصفًا لشكل الصورة');
  expect(replies.at(-1)).not.toContain('**المصدر:**');
  // A real question about a colour still reads its sources, and a bare colour with no picture before it is not taken as one.
  const { id: second } = await control.create(owner, { goal: 'ما لون السماء؟' });
  await control.settled(second);
  expect(queries.length).toBeGreaterThan(0);
  const { id: third } = await control.create(owner, { goal: 'باللون الأخضر' });
  await control.settled(third);
  expect((await control.detail(owner, third)).messages.at(-1)?.text).not.toContain('وصفًا لشكل الصورة');
});

it('turns a refused public search into a reply instead of a failed run', async () => {
  const { control, db, queries } = await harness();
  const { id } = await control.create(owner, { goal: 'افعل شيئًا مفيدًا' });
  await control.settled(id);
  const result = await control.detail(owner, id);
  expect(result.status).toBe('idle');
  expect(result.error).toBeNull();
  expect(queries).toEqual([]);
  expect(result.messages.at(-1)?.text).toContain('لم أبحث في الويب عن');
  const runs = await db.selectFrom('chat_runs').select('status').where('conversation_id', '=', id).execute();
  expect(runs.map(run => run.status)).not.toContain('failed');
});

it('bounds database queries for idle detail and browser polls', async () => {
  vi.stubEnv('MOHASSAN_MONITORS_ENABLED', 'owner');
  const { control, db, measure } = await harness();
  await migrateReminders(db);
  await monitorChat(db)!.initialize();
  const { id } = await control.create(owner, { goal: 'Calculate 241 + 178' });
  await control.settled(id);

  const detail = await measure(() => control.detail(owner, id));
  const activity = await measure(() => control.browserActivity(owner, id));
  const screen = await measure(() => control.screen(owner, id));

  expect(detail.result.status).toBe('idle');
  expect(detail.result.capabilities?.smartMonitors).toBe(true);
  expect(activity.result).toEqual({ sequence: 0, cursor: null });
  expect(screen.result).toEqual(Buffer.alloc(1));
  expectQueryBudget('idle detail', detail, 8, 0);
  expectQueryBudget('activity', activity, 1, 0);
  expectQueryBudget('screen', screen, 1, 0);

  // The detail history window at 29448ae, retrieved 2026-11-27.
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/command-chat.ts
  const window = 300;
  const additional = Array.from({ length: window + 1 }, (_, index) => ({
    id: randomUUID(), conversation_id: id, role: 'user', text: String(index),
  }));
  await db.insertInto('chat_messages').values(additional).execute();
  const longDetail = await measure(() => control.detail(owner, id));
  expect(longDetail.result.messages).toHaveLength(window);
  expect(longDetail.result.olderMessages).toBe(detail.result.messages.length + additional.length - window);
  expectQueryBudget('idle detail with older messages', longDetail, 8, 0);

  await db.transaction().execute(async tx => {
    await tx.updateTable('workspace_owner').set({ owner_id: null }).where('id', '=', 1).execute();
    await tx.insertInto('workspace_members').values({ user_id: owner, role: 'member' }).execute();
  });
  expect((await control.detail(owner, id)).capabilities?.smartMonitors).toBeUndefined();
});

// The same fixture at 29448ae measured 141 statements / 27 driver transactions
// for the web turn and 63 / 9 for compute. The web ceiling preserves at least a 30% reduction.
it.each([
  { path: 'web', goal: 'ما عاصمة اليابان؟', answer: 'عاصمتها طوكيو', maxQueries: 100, maxTransactions: 16 },
  { path: 'compute', goal: 'Calculate 241 + 178', answer: String(241 + 178), maxQueries: 62, maxTransactions: 7 },
])('bounds the database work of a $path turn', async ({ path, goal, answer, maxQueries, maxTransactions }) => {
  const { control, measure, queries, reads } = await harness();
  const turn = await measure(async () => {
    const { id } = await control.create(owner, { goal });
    await control.settled(id);
    return id;
  });

  const result = await control.detail(owner, turn.result);
  expect(result.status).toBe('idle');
  expect(result.messages.at(-1)?.text).toContain(answer);
  if (path === 'web') {
    expect(queries).toHaveLength(1);
    expect(reads).toContain(japan);
  } else {
    expect(queries).toEqual([]);
    expect(reads).toEqual([]);
  }
  expectQueryBudget(`${path} turn`, turn, maxQueries, maxTransactions);
});

it('discards an in-flight HTTP read when member deletion becomes pending', async () => {
  let releaseRead!: () => void;
  const blockedRead = new Promise<void>(resolve => { releaseRead = resolve; });
  const { control, db, actions, reads } = await harness({
    member: true,
    async onRead(_url, signal) {
      if (signal.aborted) return;
      signal.addEventListener('abort', releaseRead, { once: true });
      try { await blockedRead; } finally { signal.removeEventListener('abort', releaseRead); }
    },
  });
  let id: string;
  try {
    ({ id } = await control.create(owner, { goal: 'ما عاصمة اليابان؟' }));
    await vi.waitFor(() => expect(reads).toContain(japan));
    const working = await control.detail(owner, id);
    expect(working.status).toBe('running');
    expect(working.steps).toContainEqual(expect.objectContaining({ text: expect.stringContaining('البحث عن') }));
    expect(working.progress).toContain('يبحث عن');

    const requestedAt = new Date();
    await db.transaction().execute(async tx => {
      await tx.selectFrom('workspace_members').select('user_id').where('user_id', '=', owner).forUpdate().executeTakeFirstOrThrow();
      await tx.insertInto('member_deletion_requests').values({
        user_id: owner, requested_at: requestedAt, purge_after: new Date(requestedAt.getTime() + 60_000),
      }).execute();
    });
  } finally {
    releaseRead();
  }
  await control.settled(id);
  const result = await control.detail(owner, id);
  expect(result.status).toBe('failed');
  expect(result.run?.verdict?.reason).toBe('interrupted');
  expect(result.messages.map(message => message.role)).toEqual(['user']);
  expect(reads).toEqual([japan]);
  expect(actions).toEqual([]);
});
