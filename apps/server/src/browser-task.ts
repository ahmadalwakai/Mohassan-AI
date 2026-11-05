import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import sharp from 'sharp';
import { BrowserOpenResultSchema, BrowserTaskInputSchema, type BrowserOpenResult, type BrowserTaskInput } from '@mohassan/contracts';
import { BrowserError, SafeNetwork, migrateBrowser, type BrowserObservation, type NetworkPolicy, type createBrowserResearchControl } from '@mohassan/browser';

type BrowserControl = Pick<ReturnType<typeof createBrowserResearchControl>, 'create' | 'action' | 'detail' | 'close'>;
export interface BrowserTaskContext {
  ownerId: string;
  taskId: string;
  browserInput: BrowserTaskInput;
  signal: AbortSignal;
}
export interface BrowserTaskExecutionContext extends BrowserTaskContext {
  leaseToken: string;
  onProgress?: (stage: string, message: string) => Promise<void>;
}
export interface BrowserTaskConfig { browser: BrowserControl; networkPolicy?: NetworkPolicy }

const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const bytesHash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const contentHash = (observation: BrowserObservation) => digest({...observation, screenshot: null});
const cancelled = (signal: AbortSignal) => { if (signal.aborted) throw new BrowserError('BROWSER_TASK_CANCELLED', 'أُلغيت مهمة المتصفح قبل اعتماد النتيجة.', 409); };

export async function browserTaskMigration(db: Kysely<any>) {
  await migrateBrowser(db);
  await db.transaction().execute(async tx => {
    await sql`LOCK TABLE schema_migrations IN EXCLUSIVE MODE`.execute(tx);
    if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', '012_browser_task_receipts').executeTakeFirst()) return;
    await sql`CREATE TABLE browser_task_receipts (
      task_id text PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      owner_id text NOT NULL,
      lease_token text NOT NULL,
      session_id text REFERENCES browser_sessions(id),
      status text NOT NULL CHECK(status IN ('started','ready','failed')),
      input_hash text NOT NULL,
      observation jsonb,
      content_hash text,
      screenshot_hash text,
      result jsonb,
      result_hash text,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`.execute(tx);
    await sql`CREATE INDEX browser_task_receipts_owner_idx ON browser_task_receipts(owner_id,created_at DESC)`.execute(tx);
    await tx.insertInto('schema_migrations').values({version: '012_browser_task_receipts'}).execute();
  });
}

export async function createBrowserTaskControl(db: Kysely<any>, config: BrowserTaskConfig) {
  await browserTaskMigration(db);
  const network = new SafeNetwork(config.networkPolicy);

  function scope(raw: unknown) {
    const input = BrowserTaskInputSchema.parse(raw), url = network.validate(input.url).href;
    const origins = [...new Set([new URL(url).origin, ...(input.allowedOrigins ?? []).map(value => {
      const checked = network.validate(value);
      if (checked.href !== checked.origin + '/') throw new BrowserError('BROWSER_ORIGIN_REQUIRED', 'حدد أصل الموقع فقط ضمن نطاق مهمة المتصفح.');
      return checked.origin;
    })])].sort();
    if (origins.length > 6) throw new BrowserError('BROWSER_TASK_SCOPE_LIMIT', 'تحتاج جلسة القراءة ستة مواقع مسموحة أو أقل.');
    return {url, origins, hash: digest({url, origins})};
  }

  async function taskFor(context: BrowserTaskContext, running = false, transaction: Kysely<any> = db) {
    cancelled(context.signal);
    const task = await transaction.selectFrom('tasks').selectAll().where('id', '=', context.taskId).where('owner_id', '=', context.ownerId).executeTakeFirst();
    if (!task || task.capability_id !== 'browser.open' || task.cancellation_requested || !task.browser_input || scope(task.browser_input).hash !== scope(context.browserInput).hash) throw new BrowserError('BROWSER_TASK_SCOPE_DENIED', 'لم تتطابق مهمة المتصفح مع المالك والنطاق المعتمد.', 409);
    if (running && (task.status !== 'running' || !task.lease_token || task.lease_token !== (context as BrowserTaskExecutionContext).leaseToken || !task.lease_expires_at || new Date(task.lease_expires_at).getTime() <= Date.now())) throw new BrowserError('BROWSER_TASK_LEASE_DENIED', 'انتهى إذن تنفيذ مهمة المتصفح.', 409);
    return task;
  }

  async function screenshotBytes(value: string | null): Promise<Buffer | null> {
    if (value === null) return null;
    if (typeof value !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 700000) throw new BrowserError('BROWSER_TASK_SCREENSHOT_INVALID', 'لم تصل لقطة JPEG صالحة من جلسة المتصفح.', 409);
    const encoded = value.slice('data:image/jpeg;base64,'.length), bytes = Buffer.from(encoded, 'base64');
    if (bytes.length === 0 || bytes.length >= 500000 || bytes.toString('base64') !== encoded) throw new BrowserError('BROWSER_TASK_SCREENSHOT_INVALID', 'تجاوزت لقطة المتصفح حدود الصورة المسموحة.', 409);
    try {
      const metadata = await sharp(bytes, {limitInputPixels: 4096 * 4096, failOn: 'error'}).metadata();
      if (metadata.format !== 'jpeg' || !metadata.width || !metadata.height || metadata.width > 4096 || metadata.height > 4096) throw new Error('Invalid image');
    } catch { throw new BrowserError('BROWSER_TASK_SCREENSHOT_INVALID', 'تعذر التحقق من صورة لقطة المتصفح.', 409); }
    return bytes;
  }

  async function savedObservation(ownerId: string, sessionId: string, observation: BrowserObservation, allowedOrigins: string[]) {
    const session = await db.selectFrom('browser_sessions').selectAll().where('id', '=', sessionId).where('owner_id', '=', ownerId).executeTakeFirst();
    const history = await db.selectFrom('browser_observations').select('data').where('session_id', '=', sessionId).where('id', '=', observation.id).executeTakeFirst();
    if (!session || !history || digest(history.data) !== contentHash(observation) || digest([...session.allowed_origins].sort()) !== digest(allowedOrigins)) throw new BrowserError('BROWSER_TASK_EVIDENCE_CHANGED', 'لم تتطابق المشاهدة مع سجل المتصفح المستقل.', 409);
    network.validate(observation.url, allowedOrigins);
    if (!observation.title?.trim() && !observation.text?.trim()) throw new BrowserError('BROWSER_TASK_EMPTY', 'لم تصل صفحة مقروءة تسمح بتوثيق نتيجة الفتح.', 502);
  }

  async function execute(_goal: string, context: BrowserTaskExecutionContext): Promise<BrowserOpenResult> {
    const approved = scope(context.browserInput);
    await taskFor(context, true);
    try {
      await db.insertInto('browser_task_receipts').values({task_id: context.taskId, owner_id: context.ownerId, lease_token: context.leaseToken, status: 'started', input_hash: approved.hash}).execute();
    } catch { throw new BrowserError('BROWSER_TASK_ATTEMPT_EXISTS', 'توجد محاولة متصفح محفوظة لهذه المهمة؛ لا تُكرر تلقائيًا.', 409); }
    let sessionId: string | undefined;
    const abort = () => { if (sessionId) void config.browser.close(context.ownerId, sessionId).catch(() => {}); };
    context.signal.addEventListener('abort', abort, {once: true});
    try {
      await taskFor(context, true);
      await context.onProgress?.('browser_loading', 'جارٍ فتح الصفحة داخل جلسة المتصفح المستقلة.');
      const session = await config.browser.create(context.ownerId, {title: `${new URL(approved.url).hostname} — مهمة متصفح`.slice(0, 100), allowedOrigins: approved.origins});
      const openedSessionId: string = session.id;
      sessionId = openedSessionId;
      await db.updateTable('browser_task_receipts').set({session_id: sessionId, updated_at: new Date()}).where('task_id', '=', context.taskId).where('lease_token', '=', context.leaseToken).execute();
      await taskFor(context, true);
      let current = await config.browser.action(context.ownerId, openedSessionId, {action: 'navigate', url: approved.url, expectedObservationId: null});
      await taskFor(context, true);
      // A second bounded observation can recover a transient screenshot failure.
      if (current.observation && !current.observation.screenshot) {
        await context.onProgress?.('browser_observed', 'قُرئت الصفحة؛ جارٍ محاولة التقاط صورة حديثة.');
        current = await config.browser.action(context.ownerId, openedSessionId, {action: 'read', expectedObservationId: current.observation.id});
        await taskFor(context, true);
      }
      const observation = current.observation;
      if (!observation) throw new BrowserError('BROWSER_TASK_EMPTY', 'لم تصل مشاهدة محفوظة من المتصفح.', 502);
      await savedObservation(context.ownerId, openedSessionId, observation, approved.origins);
      const image = await screenshotBytes(observation.screenshot), imageHash = image ? bytesHash(image) : null;
      const result = BrowserOpenResultSchema.parse({kind: 'browser_open', outcome: 'opened', sessionId, observationId: observation.id, url: observation.url, title: observation.title, observedAt: observation.observedAt,
        contentHash: contentHash(observation), screenshotHash: imageHash, screenshotAvailable: Boolean(image), screenshotUrl: image ? `/api/browser/tasks/${context.taskId}/screenshot` : null,
        summary: image ? 'فُتحت الصفحة داخل المتصفح وحُفظت لقطة موثقة للعرض.' : 'فُتحت الصفحة وحُفظ النص المقروء، لكن لم تتوفر لقطة قابلة للعرض.'});
      await db.transaction().execute(async tx => {
        await tx.selectFrom('tasks').select('id').where('id', '=', context.taskId).forUpdate().executeTakeFirstOrThrow();
        await taskFor(context, true, tx);
        await tx.updateTable('browser_task_receipts').set({status: 'ready', observation: JSON.stringify(observation), content_hash: result.contentHash, screenshot_hash: imageHash, result: JSON.stringify(result), result_hash: digest(result), updated_at: new Date()}).where('task_id', '=', context.taskId).where('owner_id', '=', context.ownerId).where('lease_token', '=', context.leaseToken).execute();
      });
      return result;
    } catch (error) {
      if (sessionId) await config.browser.close(context.ownerId, sessionId).catch(() => {});
      await db.updateTable('browser_task_receipts').set({status: 'failed', updated_at: new Date()}).where('task_id', '=', context.taskId).where('owner_id', '=', context.ownerId).where('lease_token', '=', context.leaseToken).execute();
      throw error;
    } finally { context.signal.removeEventListener('abort', abort); }
  }

  async function verify(raw: unknown, context: BrowserTaskContext): Promise<BrowserOpenResult | null> {
    try {
      const result = BrowserOpenResultSchema.parse(raw), task = await taskFor(context), approved = scope(context.browserInput);
      const receipt = await db.selectFrom('browser_task_receipts').selectAll().where('task_id', '=', context.taskId).where('owner_id', '=', context.ownerId).where('status', '=', 'ready').executeTakeFirst();
      if (!receipt || !receipt.observation || receipt.session_id !== result.sessionId || receipt.input_hash !== approved.hash || receipt.result_hash !== digest(result) || digest(receipt.result) !== receipt.result_hash || !['running', 'verifying', 'completed'].includes(task.status) || task.status !== 'completed' && task.lease_token !== receipt.lease_token) return null;
      const observation = receipt.observation as BrowserObservation;
      if (observation.id !== result.observationId || observation.url !== result.url || observation.title !== result.title || observation.observedAt !== result.observedAt || contentHash(observation) !== receipt.content_hash || receipt.content_hash !== result.contentHash) return null;
      await savedObservation(context.ownerId, result.sessionId, observation, approved.origins);
      const bytes = await screenshotBytes(observation.screenshot), hash = bytes ? bytesHash(bytes) : null;
      if (hash !== receipt.screenshot_hash || hash !== result.screenshotHash || Boolean(bytes) !== result.screenshotAvailable || result.screenshotUrl !== (bytes ? `/api/browser/tasks/${context.taskId}/screenshot` : null)) return null;
      cancelled(context.signal);
      return result;
    } catch { return null; }
  }

  async function screenshot(ownerId: string, taskId: string) {
    const task = await db.selectFrom('tasks').selectAll().where('id', '=', taskId).where('owner_id', '=', ownerId).executeTakeFirst();
    const receipt = await db.selectFrom('browser_task_receipts').selectAll().where('task_id', '=', taskId).where('owner_id', '=', ownerId).where('status', '=', 'ready').executeTakeFirst();
    if (!task?.browser_input || !receipt?.result || !await verify(receipt.result, {ownerId, taskId, browserInput: task.browser_input, signal: AbortSignal.timeout(5000)})) throw new BrowserError('BROWSER_TASK_SCREENSHOT_NOT_FOUND', 'لم يُعثر على لقطة متصفح موثقة لهذه المهمة.', 404);
    const bytes = await screenshotBytes((receipt.observation as BrowserObservation).screenshot);
    if (!bytes) throw new BrowserError('BROWSER_TASK_SCREENSHOT_NOT_FOUND', 'لم تتوفر لقطة لهذه المشاهدة.', 404);
    return {bytes, mimeType: 'image/jpeg' as const, hash: receipt.screenshot_hash as string};
  }

  return {execute, verify, screenshot};
}
