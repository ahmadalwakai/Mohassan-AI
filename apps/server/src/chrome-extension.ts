import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';
import { BrowserError } from '@mohassan/browser';
import { ChromeBindingSchema, ChromeCampaignSchema, ChromeClientSchema, ChromeJobSchema, ChromePreferenceSchema, ChromeResultSchema, type ChromeBinding, type ChromeExtensionStatus, type ChromeJob } from '@mohassan/contracts';
import { parseAdsDraft } from './assistant/tools.js';

const FRESH_MS = 90_000;
const LEASE_MS = 10 * 60_000;
const activeStates = ['queued', 'running'] as const;
type Tx = Transaction<any>;
const failure = (code: string, message: string, status = 409) => new BrowserError(code, message, status);
const iso = (value: string | Date) => new Date(value).toISOString();
const json = (value: any) => typeof value === 'string' ? JSON.parse(value) : value;
const bindingOf = (row: any): ChromeBinding | null => row?.binding ? ChromeBindingSchema.parse(json(row.binding)) : null;
const sameTarget = (a: ChromeBinding, b: ChromeBinding) => a.clientId === b.clientId && a.tabId === b.tabId && a.customerId === b.customerId && a.currency === b.currency;
const toJob = (row: any): ChromeJob => ChromeJobSchema.parse({ id: row.id, clientId: row.client_id, tabId: row.tab_id, customerId: row.customer_id, currency: row.currency, leaseId: row.lease_id, status: row.status, campaign: json(row.campaign), message: row.message, steps: json(row.steps), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });

/** Server-only fence; never accepted in an HTTP body or exposed to the extension. */
export interface ChromeChatSource { runId: string; leaseToken: string }

/** Caller holds chat_runs first. Do not acquire the owner lock or open a nested transaction. */
export async function stopChromeJobsForRun(tx: Kysely<any>, ownerId: string, runId: string) {
  await tx.updateTable('chrome_extension_jobs').set({
    status: sql`CASE WHEN status = 'queued' THEN 'stopped' ELSE 'needs_attention' END`,
    message: sql`CASE WHEN status = 'queued' THEN 'أُلغيت مهمة Chrome قبل بدء التعبئة لإيقاف المحادثة.' ELSE 'أُوقفت المحادثة وطُلب إيقاف Chrome. قد تكون الخطوة الجارية قد نُفّذت؛ راجع التبويب.' END`,
    updated_at: sql`CURRENT_TIMESTAMP`,
  }).where('owner_id', '=', ownerId).where('source_run_id', '=', runId).where('status', 'in', [...activeStates]).execute();
}

async function migrateChromeExtensionSchema(db: Kysely<any>) {
  await sql`CREATE TABLE IF NOT EXISTS chrome_extension_bindings (
    owner_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
    binding jsonb, connected boolean NOT NULL DEFAULT false, preferred_transport text NOT NULL DEFAULT 'api', last_seen_at timestamptz
  )`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS chrome_extension_jobs (
    id text PRIMARY KEY, owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    idempotency_key text NOT NULL, client_id text NOT NULL, tab_id integer NOT NULL, customer_id text NOT NULL, currency text NOT NULL,
    status text NOT NULL, lease_id text, lease_expires_at timestamptz, campaign jsonb NOT NULL,
    message text NOT NULL, steps jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
    UNIQUE(owner_id,idempotency_key)
  )`.execute(db);
  await sql`ALTER TABLE chrome_extension_jobs ADD COLUMN IF NOT EXISTS source_run_id text`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS chrome_extension_source_run ON chrome_extension_jobs(owner_id,source_run_id)`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS chrome_extension_one_active ON chrome_extension_jobs(owner_id) WHERE status IN ('queued','running')`.execute(db);
}
/** Existing authenticated Mohassan tab relays these routes. No public pairing route or Google credentials. */
export async function createChromeExtensionControl(db: Kysely<any>, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  await db.transaction().execute(migrateChromeExtensionSchema);

  async function locked<T>(ownerId: string, run: (tx: Tx) => Promise<T>): Promise<T> {
    return db.transaction().execute(async tx => {
      const owner = await tx.selectFrom('user').select('id').where('id', '=', ownerId).forUpdate().executeTakeFirst();
      if (!owner) throw failure('UNAUTHORIZED', 'سجّل الدخول للمتابعة.', 401);
      return run(tx);
    });
  }
  const readBinding = (tx: Tx, ownerId: string) => tx.selectFrom('chrome_extension_bindings').selectAll().where('owner_id', '=', ownerId).executeTakeFirst();
  const fresh = (row: any) => Boolean(row?.connected && row.last_seen_at && now() - new Date(row.last_seen_at).getTime() <= FRESH_MS && now() >= new Date(row.last_seen_at).getTime());
  async function expire(tx: Tx, ownerId: string, row: any) {
    const running = await tx.selectFrom('chrome_extension_jobs').selectAll().where('owner_id', '=', ownerId).where('status', '=', 'running').executeTakeFirst();
    if (running && (!fresh(row) || !running.lease_expires_at || new Date(running.lease_expires_at).getTime() <= now())) {
      await tx.updateTable('chrome_extension_jobs').set({ status: 'needs_attention', message: 'انقطع الاتصال أو انتهت مهلة التنفيذ. راجع تبويب Google Ads؛ لن تُعاد الخطوات تلقائيًا.', updated_at: new Date(now()) }).where('id', '=', running.id).where('owner_id', '=', ownerId).execute();
    }
  }
  async function snapshot(tx: Tx, ownerId: string): Promise<ChromeExtensionStatus> {
    const row = await readBinding(tx, ownerId);
    await expire(tx, ownerId, row);
    const latest = await tx.selectFrom('chrome_extension_jobs').selectAll().where('owner_id', '=', ownerId).orderBy('created_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
    return { connected: fresh(row), binding: bindingOf(row), lastSeenAt: row?.last_seen_at ? iso(row.last_seen_at) : null, latestJob: latest ? toJob(latest) : null, preferredTransport: row?.preferred_transport === 'chrome' ? 'chrome' : 'api' };
  }
  const status = (ownerId: string) => locked(ownerId, tx => snapshot(tx, ownerId));
  async function heartbeat(ownerId: string, raw: unknown) {
    const binding = ChromeBindingSchema.parse(raw);
    return locked(ownerId, async tx => {
      const old = await readBinding(tx, ownerId);
      await expire(tx, ownerId, old);
      const previous = bindingOf(old);
      if (previous?.clientId === binding.clientId && !old?.connected) throw failure('CHROME_CONNECTION_REVOKED', 'أُلغي هذا الربط. اربط التبويبين مجددًا من الإضافة لمتابعة العمل.');
      const active = await tx.selectFrom('chrome_extension_jobs').select('id').where('owner_id', '=', ownerId).where('status', 'in', [...activeStates]).executeTakeFirst();
      if (active && (!previous || !sameTarget(previous, binding))) throw failure('CHROME_TARGET_BUSY', 'أوقف المهمة الحالية وراجعها قبل تغيير التبويب أو الحساب.');
      await tx.insertInto('chrome_extension_bindings').values({ owner_id: ownerId, binding: JSON.stringify(binding), connected: true, preferred_transport: 'chrome', last_seen_at: new Date(now()) }).onConflict(oc => oc.column('owner_id').doUpdateSet({ binding: JSON.stringify(binding), connected: true, preferred_transport: 'chrome', last_seen_at: new Date(now()) })).execute();
      return snapshot(tx, ownerId);
    });
  }
  async function preference(ownerId: string, raw: unknown) {
    const { transport } = ChromePreferenceSchema.parse(raw);
    return locked(ownerId, async tx => {
      await expire(tx, ownerId, await readBinding(tx, ownerId));
      if (transport === 'api' && await tx.selectFrom('chrome_extension_jobs').select('id').where('owner_id', '=', ownerId).where('status', 'in', [...activeStates]).executeTakeFirst()) throw failure('CHROME_TARGET_BUSY', 'أوقف مهمة Chrome الحالية قبل تغيير طريقة التنفيذ.');
      await tx.insertInto('chrome_extension_bindings').values({ owner_id: ownerId, preferred_transport: transport }).onConflict(oc => oc.column('owner_id').doUpdateSet({ preferred_transport: transport, ...(transport === 'api' ? { connected: false } : {}) })).execute();
      return snapshot(tx, ownerId);
    });
  }
  async function disconnect(ownerId: string, raw: unknown) {
    const { clientId } = ChromeClientSchema.parse(raw);
    return locked(ownerId, async tx => {
      const row = await readBinding(tx, ownerId);
      if (bindingOf(row)?.clientId !== clientId) throw failure('CHROME_BINDING_CHANGED', 'تغير اتصال الإضافة؛ حدّث الحالة.');
      await tx.updateTable('chrome_extension_bindings').set({ connected: false }).where('owner_id', '=', ownerId).execute();
      await tx.updateTable('chrome_extension_jobs').set({ status: 'stopped', message: 'أُوقفت المهمة قبل استلامها من Chrome.', updated_at: new Date(now()) }).where('owner_id', '=', ownerId).where('status', '=', 'queued').execute();
      return snapshot(tx, ownerId);
    });
  }
  async function queueCampaign(ownerId: string, lines: string, idempotencyKey: string, source?: ChromeChatSource) {
    z.string().min(1).max(180).parse(idempotencyKey);
    const brief = parseAdsDraft(lines, 'حملة إلى Chrome بطلب المالك');
    const specifiedCurrency = /^CURRENCY:\s*(.+)$/im.exec(lines)?.[1]?.trim();
    const currency = specifiedCurrency ? ({ '£': 'GBP', '$': 'USD', '€': 'EUR', '₹': 'INR' } as Record<string, string>)[specifiedCurrency] ?? specifiedCurrency.toUpperCase() : null;
    if (currency && !/^[A-Z]{3}$/.test(currency)) throw failure('CHROME_CURRENCY_INVALID', 'تعذّر تحديد عملة الميزانية؛ حدّد رمز العملة.');
    return locked(ownerId, async tx => {
      // Lock order is owner -> chat run -> Chrome job. Chat cancellation locks conversation
      // -> chat run -> Chrome job and never owner, so either it fences this insert or stops it.
      if (source) {
        const run = await tx.selectFrom('chat_runs').select('id').where('id', '=', source.runId).where('owner_id', '=', ownerId).where('status', '=', 'running').where('lease_token', '=', source.leaseToken).where('lease_expires_at', '>', sql<Date>`CURRENT_TIMESTAMP`).forUpdate().executeTakeFirst();
        if (!run) throw failure('CHROME_CHAT_RUN_ENDED', 'توقفت المحادثة أو تغير إذن تنفيذها؛ لم تُرسل مهمة جديدة إلى Chrome.');
      }
      const duplicate = await tx.selectFrom('chrome_extension_jobs').selectAll().where('owner_id', '=', ownerId).where('idempotency_key', '=', idempotencyKey).executeTakeFirst();
      if (duplicate) return toJob(duplicate);
      const row = await readBinding(tx, ownerId);
      await expire(tx, ownerId, row);
      const binding = bindingOf(row);
      if (!fresh(row) || !binding) throw failure('CHROME_NOT_CONNECTED', 'اربط إضافة موحسن بتبويب Google Ads في Chrome ثم أعد المتابعة.');
      if (currency && currency !== binding.currency) throw failure('CHROME_CURRENCY_MISMATCH', `عملة الميزانية ${currency} تختلف عن عملة الحساب ${binding.currency}. راجع الحساب أو الميزانية.`);
      if (await tx.selectFrom('chrome_extension_jobs').select('id').where('owner_id', '=', ownerId).where('status', 'in', [...activeStates]).executeTakeFirst()) throw failure('CHROME_JOB_BUSY', 'توجد مهمة قائمة في Chrome؛ انتظر نتيجتها أو أوقفها أولًا.');
      const campaign = ChromeCampaignSchema.parse({ campaignName: `${brief.businessName} - ${brief.service}`.slice(0, 160), goal: brief.goal, type: 'search', customerId: binding.customerId, currency: binding.currency, dailyBudget: brief.dailyBudget, locations: brief.locations, countryCode: brief.countryCode, adLanguage: brief.adLanguage, keywords: brief.keywords, negativeKeywords: brief.negativeKeywords, headlines: brief.headlines, descriptions: brief.descriptions, finalUrl: brief.landingPageUrl, paths: brief.paths });
      const job = { id: randomUUID(), owner_id: ownerId, source_run_id: source?.runId ?? null, idempotency_key: idempotencyKey, client_id: binding.clientId, tab_id: binding.tabId, customer_id: binding.customerId, currency: binding.currency, status: 'queued', lease_id: null, campaign: JSON.stringify(campaign), message: 'أُرسلت الحملة إلى Chrome وهي تنتظر استلام الإضافة. لم يُثبت تنفيذها في الحساب بعد.', steps: '[]', created_at: new Date(now()), updated_at: new Date(now()) };
      await tx.insertInto('chrome_extension_jobs').values(job).execute();
      return toJob(job);
    });
  }
  async function claim(ownerId: string, raw: unknown) {
    const { clientId } = ChromeClientSchema.parse(raw);
    return locked(ownerId, async tx => {
      const row = await readBinding(tx, ownerId);
      await expire(tx, ownerId, row);
      const binding = bindingOf(row);
      if (!fresh(row) || !binding || binding.clientId !== clientId) throw failure('CHROME_BINDING_CHANGED', 'اتصال Chrome غير متاح أو تغير.');
      const queued = await tx.selectFrom('chrome_extension_jobs').selectAll().where('owner_id', '=', ownerId).where('status', '=', 'queued').executeTakeFirst();
      if (!queued) return { job: null };
      if (queued.client_id !== binding.clientId || queued.tab_id !== binding.tabId || queued.customer_id !== binding.customerId || queued.currency !== binding.currency) throw failure('CHROME_BINDING_CHANGED', 'تغير تبويب الحملة أو حسابها.');
      const update = { status: 'running', lease_id: randomUUID(), lease_expires_at: new Date(now() + LEASE_MS), message: 'استلمت إضافة Chrome المهمة. لم تكتمل تعبئة المعالج بعد.', updated_at: new Date(now()) };
      const claimed = await tx.updateTable('chrome_extension_jobs').set(update).where('id', '=', queued.id).where('owner_id', '=', ownerId).where('status', '=', 'queued').returningAll().executeTakeFirst();
      return { job: claimed ? toJob(claimed) : null };
    });
  }
  async function result(ownerId: string, id: string, raw: unknown) {
    z.uuid().parse(id);
    const input = ChromeResultSchema.parse(raw);
    return locked(ownerId, async tx => {
      const row = await readBinding(tx, ownerId);
      await expire(tx, ownerId, row);
      const job = await tx.selectFrom('chrome_extension_jobs').selectAll().where('id', '=', id).where('owner_id', '=', ownerId).executeTakeFirst();
      if (!job) throw failure('CHROME_JOB_NOT_FOUND', 'لم يُعثر على المهمة.', 404);
      const binding = bindingOf(row);
      if (!fresh(row) || !binding || binding.clientId !== input.clientId || job.client_id !== input.clientId || job.tab_id !== binding.tabId || job.customer_id !== binding.customerId || job.currency !== binding.currency || job.status !== 'running' || job.lease_id !== input.leaseId) throw failure('CHROME_RESULT_STALE', 'هذه النتيجة لا تخص التنفيذ الجاري؛ راجع حالة المهمة.');
      const completed = await tx.updateTable('chrome_extension_jobs').set({ status: input.status, message: input.message, steps: JSON.stringify(input.steps), updated_at: new Date(now()) }).where('id', '=', id).where('owner_id', '=', ownerId).where('status', '=', 'running').where('lease_id', '=', input.leaseId).returning('id').executeTakeFirst();
      if (!completed) throw failure('CHROME_RESULT_STALE', 'أُوقفت المهمة أثناء تسجيل النتيجة؛ راجع حالتها.');
      return snapshot(tx, ownerId);
    });
  }
  async function cancel(ownerId: string, id: string) {
    z.uuid().parse(id);
    return locked(ownerId, async tx => {
      const job = await tx.selectFrom('chrome_extension_jobs').selectAll().where('id', '=', id).where('owner_id', '=', ownerId).executeTakeFirst();
      if (!job) throw failure('CHROME_JOB_NOT_FOUND', 'لم يُعثر على المهمة.', 404);
      if (job.status === 'queued' || job.status === 'running') await tx.updateTable('chrome_extension_jobs').set({ status: job.status === 'queued' ? 'stopped' : 'needs_attention', message: job.status === 'queued' ? 'أُلغيت المهمة قبل بدء التعبئة.' : 'طُلب إيقاف التنفيذ. قد تكون الخطوة الجارية قد نُفّذت؛ راجع Google Ads قبل إعادة المحاولة.', updated_at: new Date(now()) }).where('id', '=', id).where('owner_id', '=', ownerId).execute();
      return snapshot(tx, ownerId);
    });
  }
  /** Only the authenticated owner's explicit review starts a fresh execution lease. */
  async function resume(ownerId: string, id: string, raw: unknown) {
    z.uuid().parse(id);
    const { clientId } = ChromeClientSchema.parse(raw);
    return locked(ownerId, async tx => {
      const row = await readBinding(tx, ownerId);
      await expire(tx, ownerId, row);
      const binding = bindingOf(row);
      const job = await tx.selectFrom('chrome_extension_jobs').selectAll().where('id', '=', id).where('owner_id', '=', ownerId).executeTakeFirst();
      if (!job) throw failure('CHROME_JOB_NOT_FOUND', 'لم يُعثر على المهمة.', 404);
      if (job.status !== 'needs_attention') throw failure('CHROME_RESUME_INVALID', 'هذه المهمة لا تنتظر مراجعة لاستئنافها.');
      if (!fresh(row) || !binding || binding.clientId !== clientId || job.client_id !== clientId || job.tab_id !== binding.tabId || job.customer_id !== binding.customerId || job.currency !== binding.currency) throw failure('CHROME_BINDING_CHANGED', 'استئناف المهمة يتطلب التبويب والحساب والربط نفسه.');
      if (await tx.selectFrom('chrome_extension_jobs').select('id').where('owner_id', '=', ownerId).where('status', 'in', [...activeStates]).executeTakeFirst()) throw failure('CHROME_JOB_BUSY', 'توجد مهمة أخرى قائمة في Chrome.');
      await tx.updateTable('chrome_extension_jobs').set({ status: 'queued', lease_id: null, lease_expires_at: null, message: 'طلبت استئناف المهمة بعد مراجعة الصفحة. تنتظر الإضافة فحص الخطوة الحالية.', updated_at: new Date(now()) }).where('id', '=', id).where('owner_id', '=', ownerId).execute();
      return snapshot(tx, ownerId);
    });
  }
  return { status, heartbeat, preference, disconnect, queueCampaign, claim, result, cancel, resume };
}
export type ChromeExtensionControl = Awaited<ReturnType<typeof createChromeExtensionControl>>;

export function registerChromeExtensionRoutes(app: FastifyInstance, { control, owner }: { control: ChromeExtensionControl; owner: (request: any) => Promise<{ id: string }> }) {
  app.get('/api/chrome-extension/status', async request => control.status((await owner(request)).id));
  app.post('/api/chrome-extension/heartbeat', async request => control.heartbeat((await owner(request)).id, request.body));
  app.post('/api/chrome-extension/preference', async request => control.preference((await owner(request)).id, request.body));
  app.post('/api/chrome-extension/disconnect', async request => control.disconnect((await owner(request)).id, request.body));
  app.post('/api/chrome-extension/jobs/claim', async request => control.claim((await owner(request)).id, request.body));
  app.post<{ Params: { id: string } }>('/api/chrome-extension/jobs/:id/result', async request => control.result((await owner(request)).id, request.params.id, request.body));
  app.post<{ Params: { id: string } }>('/api/chrome-extension/jobs/:id/cancel', async request => { z.object({}).strict().parse(request.body ?? {}); return control.cancel((await owner(request)).id, request.params.id); });
  app.post<{ Params: { id: string } }>('/api/chrome-extension/jobs/:id/resume', async request => control.resume((await owner(request)).id, request.params.id, request.body));
}
