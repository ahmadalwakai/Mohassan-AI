import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp, open, realpath, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { redactCredentialText } from '@mohassan/cognitive';
import { GoogleAdsCustomerIdSchema } from '@mohassan/contracts';
import { redactSecrets } from '@mohassan/providers';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { memberDocumentLocation } from './member-data-document-path.js';
import { memberDataRegistry } from './member-data-registry.js';
import { createMemberDataZip } from './member-data-zip.js';

export const MEMBER_EXPORT_MAX_BYTES = 64 * 1024 * 1024;

const readme = `بيانات حسابك في محسن AI

يحتوي المجلد data على ملف JSON لكل جدول متاح للتصدير، وتُعرض سجلات حسابك وحده فيه.
تجد مرفقات المحادثة في files/chat-images وملفات PDF في files/documents.
يحتوي files/transfers على الملفات المرفوعة التي لا تزال محفوظة والتنزيلات التي تم تحريرها.
توجد الصور المحفوظة من المواقع والاستوديو في files/site-images وfiles/studio-images وfiles/studio-review-images.
يمكنك ربط الملفات بسجلاتها عبر معرّف الملف في اسمه أو في المجلد الذي يحتويه.
قد تظهر معلومات ملف في JSON بعد انتهاء صلاحية نسخته أو زوالها من التخزين.
تُحجب بيانات الاعتماد ورموز الجلسات، ويظهر حساب Google Ads المرتبط بالاسم فقط.
`;

class MemberExportError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly retryAfterSeconds?: number) {
    super(message);
  }
}

const fileChanged = () => new MemberExportError(409, 'MEMBER_EXPORT_FILE_CHANGED', 'تغيّر أحد الملفات المحفوظة وتعذر إكمال التنزيل.');

// The registry allow-lists top-level columns. These checks also cover credentials in JSON objects and text.
const secretFields = new Set([
  'token', 'tokenhash', 'authorization', 'proxyauthorization', 'cookie', 'cookies', 'setcookie',
  'credential', 'credentials', 'privatekey', 'codeverifier', 'pkceverifier', 'csrf', 'csrftoken',
]);
const secretFieldSuffix = /(?:sessiontoken|accesstoken|refreshtoken|oauthtoken|idtoken|invitetoken|bearertoken|leasetoken|workflowtoken|activetoken|password|apikey|clientsecret|cookie)(?:hash)?s?$/u;
const credentialQuery = /([?&#](?:invite|token|access_token|refresh_token|session_token|api_key|password)=)[^&#\s"'<>]+/giu;
const cleanText = (value: string) => redactCredentialText(redactSecrets(value)).replace(credentialQuery, '$1[REDACTED]');
const adsIdFields = new Set(['customerid', 'logincustomerid', 'managercustomerid']);
// Google Ads customer IDs and resource paths used by the real draft and publication code (retrieved 2026-11-25).
// https://github.com/ahmadalwakai/Mohassan-AI/blob/c2a0ff7/packages/contracts/src/google-ads.ts
// https://github.com/ahmadalwakai/Mohassan-AI/blob/c2a0ff7/packages/google-ads/src/draft.ts
const adsResourceId = /(\bcustomers\/)\d{10}(?!\d)/gu;

function exportReplacer(linkedIds: readonly (string | null)[]) {
  const ids = linkedIds.filter(id => GoogleAdsCustomerIdSchema.safeParse(id).success);
  const linkedIdPattern = ids.length ? new RegExp(`(?<!\\d)(?:${ids.join('|')})(?!\\d)`, 'gu') : null;
  return (key: string, value: unknown): unknown => {
    const field = key.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    if (secretFields.has(field) || field.startsWith('sealed') || secretFieldSuffix.test(field) || adsIdFields.has(field)) return undefined;
    if (typeof value === 'string') {
      // The Ads connection uses the ID as its name when Google supplied no descriptive name.
      if (key === 'account_name' && linkedIds.includes(value)) return null;
      const text = cleanText(value).replace(adsResourceId, '$1[REDACTED]');
      return linkedIdPattern ? text.replace(linkedIdPattern, '[REDACTED]') : text;
    }
    if (typeof value === 'bigint') return String(value);
    return value;
  };
}

function fileSegment(value: string, fallback: string): string {
  return cleanText(value).normalize('NFC').replace(/[^\p{L}\p{N}_. -]/gu, '_').slice(0, 160).replace(/^[. ]+|[. ]+$/gu, '') || fallback;
}

// SQL cursors keep results bounded on PostgreSQL and embedded PGlite without a driver extension.
// https://www.postgresql.org/docs/current/sql-declare.html (retrieved 2026-11-25)
// https://www.postgresql.org/docs/current/sql-fetch.html (retrieved 2026-11-25)
async function* exportRows<Row>(tx: Kysely<any>, query: RawBuilder<Row>, signal?: AbortSignal, batchSize = 8): AsyncGenerator<Row> {
  signal?.throwIfAborted();
  await sql`DECLARE member_data_rows NO SCROLL CURSOR FOR ${query}`.execute(tx);
  try {
    while (true) {
      signal?.throwIfAborted();
      const { rows } = await sql<Row>`FETCH FORWARD ${sql.lit(batchSize)} FROM member_data_rows`.execute(tx);
      yield* rows;
      if (rows.length < batchSize) return;
    }
  } finally {
    await sql`CLOSE member_data_rows`.execute(tx);
  }
}

async function* jsonRows(rows: AsyncIterable<unknown>, replace: ReturnType<typeof exportReplacer>): AsyncGenerator<Buffer> {
  yield Buffer.from('[');
  let delimiter = '\n';
  for await (const row of rows) {
    yield Buffer.from(delimiter + JSON.stringify(row, replace));
    delimiter = ',\n';
  }
  yield Buffer.from('\n]\n');
}

function checkedBytes(encoded: string, hash?: string | null): Buffer {
  const bytes = Buffer.from(encoded, 'base64');
  if (hash && createHash('sha256').update(bytes).digest('hex') !== hash) throw fileChanged();
  return bytes;
}

async function* documentBytes(file: FileHandle, hash: string): AsyncGenerator<Buffer> {
  const checksum = createHash('sha256');
  for await (const chunk of file.createReadStream()) {
    const bytes = chunk as Buffer;
    checksum.update(bytes);
    yield bytes;
  }
  if (checksum.digest('hex') !== hash) throw fileChanged();
}

async function openDocument(dir: string, accountId: string, row: { id: string; path: string }): Promise<FileHandle | null> {
  const expected = memberDocumentLocation(dir, accountId, row.id);
  if (!expected || expected !== resolve(row.path)) return null;
  try {
    const root = await realpath(dir);
    const location = join(root, basename(dirname(expected)), `${row.id}.pdf`);
    if (await realpath(location) !== location) return null;
    const flags = process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
    const file = await open(location, flags);
    try {
      if ((await file.stat()).isFile()) return file;
    } catch (error) {
      await file.close();
      throw error;
    }
    await file.close();
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

type Zip = ReturnType<typeof createMemberDataZip>;

async function exportFiles(tx: Kysely<any>, zip: Zip, accountId: string, documentsDir: string, signal?: AbortSignal) {
  const documents = sql<{ id: string; path: string; name: string; content_hash: string }>`
    SELECT id, path, name, content_hash FROM pdf_documents WHERE owner_id = ${accountId}`;
  for await (const row of exportRows(tx, documents, signal)) {
    const file = await openDocument(documentsDir, accountId, row);
    if (!file) continue;
    try {
      await zip.entry(`files/documents/${row.id}/${fileSegment(row.name, 'document.pdf')}`, documentBytes(file, row.content_hash));
    } finally {
      await file.close();
    }
  }

  // Keep the browser file release boundary intact for downloads, including while a sweep is pending.
  const transfers = sql<{ id: string; filename: string; bytes_base64: string; content_hash: string }>`
    SELECT grant_row.id, grant_row.filename, grant_row.bytes_base64, grant_row.content_hash
    FROM browser_file_grants AS grant_row JOIN chat_conversations AS chat ON chat.id = grant_row.conversation_id
    WHERE grant_row.owner_id = ${accountId} AND chat.owner_id = ${accountId}
      AND grant_row.bytes_base64 IS NOT NULL AND grant_row.expires_at > CURRENT_TIMESTAMP
      AND (grant_row.direction = 'upload' OR (grant_row.direction = 'download' AND grant_row.status = 'released'))`;
  for await (const row of exportRows(tx, transfers, signal)) {
    const name = fileSegment(row.filename, 'file');
    await zip.entry(`files/transfers/${fileSegment(row.id, 'transfer')}/${name}`, [checkedBytes(row.bytes_base64, row.content_hash)]);
  }

  type Image = { id: string; mime_type: string; data_base64: string; content_hash: string | null; small_base64: string | null };
  const images = [
    ['chat-images', sql<Image>`SELECT id, mime_type, data_base64, content_hash, NULL AS small_base64 FROM chat_images WHERE owner_id = ${accountId}`],
    ['site-images', sql<Image>`SELECT data.id, data.mime_type, data.data_base64, NULL AS content_hash, data.small_base64
      FROM site_images AS data JOIN sites AS site ON site.id = data.site_id WHERE data.owner_id = ${accountId} AND site.owner_id = ${accountId}`],
    ['studio-images', sql<Image>`SELECT id, mime_type, data_base64, content_hash, NULL AS small_base64 FROM studio_images WHERE owner_id = ${accountId}`],
    ['studio-review-images', sql<Image>`SELECT id, 'image/png' AS mime_type, data_base64, content_hash, NULL AS small_base64 FROM studio_review_images WHERE owner_id = ${accountId}`],
  ] as const;
  for (const [folder, query] of images) {
    for await (const row of exportRows(tx, query, signal, 1)) {
      const extension = row.mime_type === 'image/jpeg' ? 'jpg' : 'png';
      const path = `files/${folder}/${fileSegment(row.id, 'image')}`;
      await zip.entry(`${path}.${extension}`, [checkedBytes(row.data_base64, row.content_hash)]);
      if (row.small_base64) await zip.entry(`${path}-small.${extension}`, [checkedBytes(row.small_base64)]);
    }
  }
}

export function createMemberDataExport(db: Kysely<any>, options: { documentsDir?: string; maxBytes?: number } = {}) {
  const documentsDir = options.documentsDir ?? resolve('.data/documents');
  const maxBytes = Math.min(MEMBER_EXPORT_MAX_BYTES, options.maxBytes ?? MEMBER_EXPORT_MAX_BYTES);

  async function prepare(accountId: string, signal?: AbortSignal): Promise<{ stream: Readable; bytes: number }> {
    signal?.throwIfAborted();
    const claim = await sql<{ user_id: string }>`
      INSERT INTO member_data_exports (user_id, requested_at) VALUES (${accountId}, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id) DO UPDATE SET requested_at = EXCLUDED.requested_at
      WHERE member_data_exports.requested_at <= EXCLUDED.requested_at - INTERVAL '1 hour'
      RETURNING user_id`.execute(db);
    if (!claim.rows.length) {
      const { rows } = await sql<{ seconds: number }>`
        SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM requested_at + INTERVAL '1 hour' - CURRENT_TIMESTAMP)))::integer AS seconds
        FROM member_data_exports WHERE user_id = ${accountId}`.execute(db);
      throw new MemberExportError(429, 'MEMBER_EXPORT_RATE_LIMIT', 'يمكن طلب تنزيل البيانات مرة واحدة كل ساعة.', rows[0]?.seconds ?? 1);
    }

    const directory = await mkdtemp(join(tmpdir(), 'mohassan-member-export-'));
    const removeStage = () => rm(directory, { recursive: true, force: true });
    let file: FileHandle | undefined;
    try {
      file = await open(join(directory, 'export.zip'), 'wx+', 0o600);
      // POSIX keeps the descriptor usable after unlink and releases the bytes even on a process crash.
      if (process.platform !== 'win32') await removeStage();
      const zip = createMemberDataZip(file, maxBytes, signal);
      await zip.entry('README.txt', [Buffer.from(readme)]);
      await db.transaction().execute(async tx => {
        await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`.execute(tx);
        const { rows: [ads] } = await sql<{ customer_id: string | null; login_customer_id: string | null }>`
          SELECT customer_id, login_customer_id FROM google_ads_connections WHERE owner_id = ${accountId}`.execute(tx);
        const replace = exportReplacer(ads ? [ads.customer_id, ads.login_customer_id] : []);
        for (const entry of memberDataRegistry) {
          if (!entry.export) continue;
          const columns = sql.join(entry.export.map(column => sql.ref(`data.${column}`)));
          // Predicates come from the registry. Account IDs always go through bound parameters.
          const predicate = sql.join(entry.accountPredicate.split('$1').map(part => sql.raw(part)), sql`${accountId}`);
          const query = sql`SELECT ${columns} FROM ${sql.table(entry.table)} AS data WHERE (${predicate})`;
          await zip.entry(`data/${entry.table}.json`, jsonRows(exportRows(tx, query, signal), replace));
        }
        await exportFiles(tx, zip, accountId, documentsDir, signal);
      });
      const bytes = await zip.finish();
      const stream = file.createReadStream({ start: 0, signal });
      stream.once('close', () => { void removeStage().catch(() => {}); });
      return { stream, bytes };
    } catch (error) {
      try { await file?.close(); } finally { await removeStage(); }
      throw error;
    }
  }

  return { prepare };
}
