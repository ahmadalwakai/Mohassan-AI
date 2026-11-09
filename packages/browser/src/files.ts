import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { PNG } from 'pngjs';
import { z } from 'zod';
import { AgentBrowser, type AgentFileTarget } from './agent-browser.js';
import { BrowserError } from './network.js';

export const BROWSER_FILE_MAX_BYTES = 512 * 1024;
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const filename = z.string().min(1).max(100).regex(/^[\p{L}\p{N}][\p{L}\p{M}\p{N}._ -]*$/u).refine(value => !value.includes('..'));
export const BrowserFileGrantSchema = z.object({ direction: z.enum(['upload', 'download']), ref: z.string().regex(/^(?:f\d+)?e\d+$/), file: z.object({ name: filename, type: z.enum(['text/plain', 'text/markdown', 'text/csv', 'application/json', 'image/png']), base64: z.string().min(1).max(699052) }).strict().optional() }).strict();
const empty = z.object({}).strict();

/** Deliberately narrow: structural validation is not an antivirus verdict. PDF binary remains unsupported. */
export function inspectBrowserFile(bytes: Buffer, name: string, type: string) {
  filename.parse(name);
  if (!bytes.length || bytes.length > BROWSER_FILE_MAX_BYTES) throw new BrowserError('BROWSER_FILE_SIZE', 'حد الملف 512 كيلوبايت، ولا يُقبل ملف فارغ.');
  const ext = name.split('.').at(-1)!.toLowerCase();
  if (type === 'image/png') {
    if (ext !== 'png' || bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new BrowserError('BROWSER_FILE_TYPE', 'توقيع الصورة غير مقبول.');
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height || width > 8192 || height > 8192 || width * height > 4_000_000) throw new BrowserError('BROWSER_FILE_TYPE', 'أبعاد الصورة غير مقبولة.');
    try { PNG.sync.read(bytes, { checkCRC: true }); } catch { throw new BrowserError('BROWSER_FILE_TYPE', 'الصورة غير سليمة بنيويًا.'); }
  } else {
    const allowed: Record<string, string[]> = { 'text/plain': ['txt'], 'text/markdown': ['md'], 'text/csv': ['csv'], 'application/json': ['json'] };
    if (!allowed[type]?.includes(ext)) throw new BrowserError('BROWSER_FILE_TYPE', 'المسموح نص UTF-8 أو Markdown أو CSV أو JSON أو PNG مطابق للامتداد.');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new BrowserError('BROWSER_FILE_ENCODING', 'الملف ليس نص UTF-8 صالحًا.'); }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new BrowserError('BROWSER_FILE_TYPE', 'الملف النصي يحتوي بيانات ثنائية.');
    if (type === 'application/json') try { JSON.parse(text); } catch { throw new BrowserError('BROWSER_FILE_TYPE', 'JSON غير صالح.'); }
  }
  return { hash: hash(bytes), size: bytes.length, type, name, check: 'type_size_structure_v1' };
}

export async function migrateBrowserFiles(db: Kysely<any>) {
  await db.transaction().execute(async tx => {
    await sql`SELECT pg_advisory_xact_lock(7240397)`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS browser_file_grants (
      id text PRIMARY KEY, owner_id text NOT NULL, conversation_id text NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
      direction text NOT NULL, target jsonb NOT NULL, status text NOT NULL,
      filename text, media_type text, bytes_base64 text, content_hash text, byte_count integer,
      inspection text, response_status integer, error_code text,
      expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`.execute(tx);
    await sql`CREATE INDEX IF NOT EXISTS browser_file_owner ON browser_file_grants(owner_id,conversation_id,created_at DESC)`.execute(tx);
  });
}

export function createBrowserFileControl(db: Kysely<any>, browser: AgentBrowser, session: (ownerId: string, conversationId: string, requireIdle: boolean) => Promise<{ accountId: string | null }>) {
  const running = new Map<string, AbortController>();
  const tasks = new Set<Promise<unknown>>();
  let closing = false;
  const publicRow = (row: any) => ({ id: row.id, direction: row.direction, status: row.status, target: row.target as AgentFileTarget, filename: row.filename, type: row.media_type, hash: row.content_hash, size: row.byte_count, inspection: row.inspection, responseStatus: row.response_status, errorCode: row.error_code, expiresAt: new Date(row.expires_at).toISOString() });
  async function owned(ownerId: string, conversationId: string, id: string) {
    await session(ownerId, conversationId, false);
    const row = await db.selectFrom('browser_file_grants').selectAll().where('owner_id', '=', ownerId).where('conversation_id', '=', conversationId).where('id', '=', id).executeTakeFirst();
    if (!row) throw new BrowserError('BROWSER_FILE_NOT_FOUND', 'الملف غير موجود في هذه المحادثة.', 404);
    return row;
  }
  async function expire(ownerId: string) {
    await db.updateTable('browser_file_grants').set({ status: 'expired', bytes_base64: null, updated_at: sql`CURRENT_TIMESTAMP` }).where('owner_id', '=', ownerId).where('expires_at', '<=', sql`CURRENT_TIMESTAMP`).where('status', 'in', ['pending', 'quarantined', 'released']).execute();
  }
  async function list(ownerId: string, conversationId: string) {
    await session(ownerId, conversationId, false); await expire(ownerId);
    const rows = await db.selectFrom('browser_file_grants').selectAll().where('owner_id', '=', ownerId).where('conversation_id', '=', conversationId).orderBy('created_at', 'desc').limit(30).execute();
    return { files: rows.map(publicRow), maxBytes: BROWSER_FILE_MAX_BYTES, supported: ['txt', 'md', 'csv', 'json', 'png'] };
  }
  async function create(ownerId: string, conversationId: string, raw: unknown) {
    if (closing) throw new BrowserError('BROWSER_FILE_CLOSING', 'الخدمة تتوقف.', 503);
    const input = BrowserFileGrantSchema.parse(raw);
    if ((input.direction === 'upload') !== Boolean(input.file)) throw new BrowserError('BROWSER_FILE_INVALID', 'اختر ملفًا للرفع فقط.');
    const account = await session(ownerId, conversationId, true); await expire(ownerId);
    const target = await browser.describeFileTarget(ownerId, conversationId, input.ref, input.direction);
    if (target.accountId !== account.accountId) throw new BrowserError('BROWSER_FILE_ACCOUNT_CHANGED', 'تغير حساب المتصفح.', 409);
    let bytes: Buffer | undefined, inspection: ReturnType<typeof inspectBrowserFile> | undefined;
    if (input.file) {
      bytes = Buffer.from(input.file.base64, 'base64');
      if (bytes.toString('base64') !== input.file.base64) throw new BrowserError('BROWSER_FILE_ENCODING', 'ترميز الملف غير صالح.');
      inspection = inspectBrowserFile(bytes, input.file.name, input.file.type);
    }
    const row = await db.transaction().execute(async tx => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`browser-files:${ownerId}`}))`.execute(tx);
      const count = await tx.selectFrom('browser_file_grants').select(eb => eb.fn.countAll<number>().as('count')).where('owner_id', '=', ownerId).where('status', 'in', ['pending', 'dispatching', 'quarantined', 'released']).executeTakeFirstOrThrow();
      const pending = await tx.selectFrom('browser_file_grants').select(eb => eb.fn.countAll<number>().as('count')).where('owner_id', '=', ownerId).where('status', 'in', ['pending', 'dispatching']).executeTakeFirstOrThrow();
      if (Number(count.count) >= 20 || Number(pending.count) >= 10) throw new BrowserError('BROWSER_FILE_QUOTA', 'احذف بعض الملفات أو المنح قبل إضافة ملف جديد.', 409);
      return tx.insertInto('browser_file_grants').values({ id: randomUUID(), owner_id: ownerId, conversation_id: conversationId, direction: input.direction, target: JSON.stringify(target), status: 'pending', filename: input.file?.name ?? null, media_type: input.file?.type ?? null, bytes_base64: bytes?.toString('base64') ?? null, content_hash: inspection?.hash ?? null, byte_count: inspection?.size ?? null, inspection: inspection?.check ?? null, expires_at: new Date(Date.now() + 10 * 60000) }).returningAll().executeTakeFirstOrThrow();
    });
    return publicRow(row);
  }
  async function perform(ownerId: string, conversationId: string, id: string) {
    if (closing) throw new BrowserError('BROWSER_FILE_CLOSING', 'الخدمة تتوقف.', 503);
    const row = await owned(ownerId, conversationId, id), account = await session(ownerId, conversationId, true), target = row.target as AgentFileTarget;
    if (row.status !== 'pending' || new Date(row.expires_at).getTime() <= Date.now()) throw new BrowserError('BROWSER_FILE_GRANT_USED', 'المنحة منتهية أو استُخدمت؛ لا إعادة تلقائية.', 409);
    if (account.accountId !== target.accountId) throw new BrowserError('BROWSER_FILE_ACCOUNT_CHANGED', 'تغير حساب المتصفح.', 409);
    const claimed = await db.updateTable('browser_file_grants').set({ status: 'dispatching', updated_at: sql`CURRENT_TIMESTAMP` }).where('id', '=', id).where('status', '=', 'pending').where('expires_at', '>', sql`CURRENT_TIMESTAMP`).returning('id').executeTakeFirst();
    if (!claimed) throw new BrowserError('BROWSER_FILE_GRANT_USED', 'هذه المنحة قيد التنفيذ أو مستهلكة.', 409);
    const controller = new AbortController(); running.set(id, controller);
    let dispatched = false;
    const assertActive = async () => {
      controller.signal.throwIfAborted();
      const current = await owned(ownerId, conversationId, id), currentAccount = await session(ownerId, conversationId, true);
      if (current.status !== 'dispatching' || new Date(current.expires_at).getTime() <= Date.now() || currentAccount.accountId !== target.accountId) throw new BrowserError('BROWSER_FILE_REVOKED', 'انتهت صلاحية نقل الملف.', 409);
    };
    try {
      const bytes = row.bytes_base64 ? Buffer.from(row.bytes_base64, 'base64') : undefined;
      if (bytes && inspectBrowserFile(bytes, row.filename, row.media_type).hash !== row.content_hash) throw new BrowserError('BROWSER_FILE_CHANGED', 'تغيرت بصمة الملف.', 409);
      const response = await browser.transferFile(ownerId, conversationId, target, { ...(bytes ? { file: { name: row.filename, type: row.media_type, bytes } } : {}), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]), assertActive, dispatched: async () => { await assertActive(); dispatched = true; }, maxBytes: BROWSER_FILE_MAX_BYTES });
      let update: any;
      if (row.direction === 'download') {
        if (response.status !== 200) throw new BrowserError('BROWSER_FILE_HTTP', 'لم يرجع المصدر ملفًا كاملًا (HTTP 200).', 502);
        const type = (response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        const ext: Record<string, string> = { 'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'application/json': 'json', 'image/png': 'png' };
        if (!ext[type]) throw new BrowserError('BROWSER_FILE_TYPE', 'نوع التنزيل غير مدعوم؛ لم يُحرر الملف.');
        const name = `download-${id.slice(0, 8)}.${ext[type]}`;
        const checked = inspectBrowserFile(response.body, name, type);
        update = { status: 'quarantined', bytes_base64: response.body.toString('base64'), filename: name, media_type: type, content_hash: checked.hash, byte_count: checked.size, inspection: checked.check };
      } else update = { status: 'responded', bytes_base64: null };
      await assertActive();
      const saved = await db.updateTable('browser_file_grants').set({ ...update, response_status: response.status, updated_at: sql`CURRENT_TIMESTAMP` }).where('id', '=', id).where('status', '=', 'dispatching').returningAll().executeTakeFirst();
      if (!saved) throw new BrowserError('BROWSER_FILE_REVOKED', 'سُحبت صلاحية الملف أثناء النقل.', 409);
      return publicRow(saved);
    } catch (error) {
      await db.updateTable('browser_file_grants').set({ status: dispatched && row.direction === 'upload' ? 'unknown' : 'failed', bytes_base64: null, error_code: error instanceof BrowserError ? error.code : 'BROWSER_FILE_FAILED', updated_at: sql`CURRENT_TIMESTAMP` }).where('id', '=', id).where('status', '=', 'dispatching').execute();
      throw error;
    } finally { running.delete(id); }
  }
  async function revoke(ownerId: string, conversationId: string, id: string) {
    await owned(ownerId, conversationId, id);
    running.get(id)?.abort();
    await db.updateTable('browser_file_grants').set({ status: sql`CASE WHEN direction='upload' AND status='dispatching' THEN 'unknown' WHEN direction='upload' AND status IN ('responded','unknown','failed') THEN status ELSE 'revoked' END`, bytes_base64: null, updated_at: sql`CURRENT_TIMESTAMP` }).where('id', '=', id).execute();
    return { ok: true };
  }
  async function release(ownerId: string, conversationId: string, id: string, raw: unknown) {
    empty.parse(raw); const row = await owned(ownerId, conversationId, id);
    if (row.status !== 'quarantined' || !row.bytes_base64 || new Date(row.expires_at).getTime() <= Date.now()) throw new BrowserError('BROWSER_FILE_NOT_VERIFIED', 'الملف غير متاح للتحرير من الحجر.', 409);
    if (inspectBrowserFile(Buffer.from(row.bytes_base64, 'base64'), row.filename, row.media_type).hash !== row.content_hash) throw new BrowserError('BROWSER_FILE_CHANGED', 'تغيرت بصمة الملف.', 409);
    const saved = await db.updateTable('browser_file_grants').set({ status: 'released', updated_at: sql`CURRENT_TIMESTAMP` }).where('id', '=', id).where('status', '=', 'quarantined').where('content_hash', '=', row.content_hash).returningAll().executeTakeFirst();
    if (!saved) throw new BrowserError('BROWSER_FILE_REVOKED', 'سُحبت صلاحية الملف.', 409);
    return publicRow(saved);
  }
  async function content(ownerId: string, conversationId: string, id: string) {
    const row = await owned(ownerId, conversationId, id);
    if (row.status !== 'released' || !row.bytes_base64 || new Date(row.expires_at).getTime() <= Date.now()) throw new BrowserError('BROWSER_FILE_QUARANTINED', 'حرر الملف المفحوص من الحجر أولًا.', 403);
    const bytes = Buffer.from(row.bytes_base64, 'base64');
    if (inspectBrowserFile(bytes, row.filename, row.media_type).hash !== row.content_hash) throw new BrowserError('BROWSER_FILE_CHANGED', 'تغيرت بصمة الملف.', 409);
    return { name: row.filename as string, type: row.media_type as string, bytes };
  }
  return { list, create, revoke, release, content,
    targets: async (ownerId: string, conversationId: string) => { await session(ownerId, conversationId, true); return browser.fileTargets(ownerId, conversationId); },
    execute: (ownerId: string, conversationId: string, id: string, raw: unknown) => { empty.parse(raw); const task = perform(ownerId, conversationId, id); tasks.add(task); void task.finally(() => tasks.delete(task)).catch(() => {}); return task; },
    recover: () => db.updateTable('browser_file_grants').set({ status: 'unknown', bytes_base64: null, error_code: 'BROWSER_FILE_RESTARTED', updated_at: sql`CURRENT_TIMESTAMP` }).where('status', '=', 'dispatching').execute(),
    sweep: () => db.updateTable('browser_file_grants').set({ status: 'expired', bytes_base64: null, updated_at: sql`CURRENT_TIMESTAMP` }).where('expires_at', '<=', sql`CURRENT_TIMESTAMP`).where('status', 'in', ['pending', 'quarantined', 'released']).execute(),
    shutdown: async () => { closing = true; for (const controller of running.values()) controller.abort(); await Promise.allSettled(tasks); },
  };
}
