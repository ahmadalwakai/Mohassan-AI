import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { cleanLearningText, evaluateLearningSubject, LearningContentError, learningHash, lockLearningOwner, normalizeLearningText, requireLearningEvaluation, type LearningContentEvaluator } from './lessons.ts';
import { knowledgeChunks, knowledgeQueryTerms, selectKnowledgeChunks, LEARNING_CONTEXT_POLICY, type KnowledgeContextDocument } from './context.ts';
import { extractPdfText, PDF_EXTRACTION_POLICY, PDF_LIMITS } from './pdf.ts';

export const KnowledgeImportSchema = z.object({ path: z.string().trim().min(1).max(2000), title: z.string().trim().min(1).max(200).optional() }).strict();
export interface KnowledgeControlOptions { allowedRoots: readonly string[] | ((ownerId: string) => readonly string[] | Promise<readonly string[]>); evaluate?: LearningContentEvaluator; now?: () => Date; redact?: (value: string) => string; }
const maxBytes = 256_000;
const textExtractionPolicy = 'utf8-v1';
const inside = (root: string, target: string) => { const relative = path.relative(root, target); return relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); };

export async function knowledgeMigration(db: Kysely<any>) {
  const apply = async (tx: Kysely<any>) => {
    await sql`SELECT pg_advisory_xact_lock(7240392)`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS learning_documents (
      id text PRIMARY KEY, owner_id text NOT NULL, source_key text NOT NULL, source_path text NOT NULL, title text NOT NULL,
      version integer NOT NULL, status text NOT NULL CHECK(status IN ('candidate','verified','active','retired')),
      source_hash text NOT NULL, content_hash text NOT NULL, text text NOT NULL, chunks jsonb NOT NULL,
      evaluation_id text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
      UNIQUE(owner_id,source_key,version)
    )`.execute(tx);
    await sql`ALTER TABLE learning_documents ADD COLUMN IF NOT EXISTS extraction_policy text NOT NULL DEFAULT 'utf8-v1'`.execute(tx);
    await sql`CREATE INDEX IF NOT EXISTS learning_documents_owner_status ON learning_documents(owner_id,status)`.execute(tx);
  };
  return db.isTransaction ? apply(db) : db.transaction().execute(apply);
}

export function createKnowledgeControl(db: Kysely<any>, options: KnowledgeControlOptions) {
  const now = () => options.now?.() ?? new Date();
  const transaction = <T>(action: (tx: Kysely<any>) => Promise<T>) => db.isTransaction ? action(db) : db.transaction().execute(action);
  async function owned(connection: Kysely<any>, ownerId: string, id: string) {
    const row = await connection.selectFrom('learning_documents').selectAll().where('id', '=', id).where('owner_id', '=', ownerId).executeTakeFirst();
    if (!row) throw new LearningContentError('KNOWLEDGE_NOT_FOUND', 'لم يُعثر على المستند.', 404); return row;
  }
  async function readBytes(ownerId: string, rawPath: string) {
    let requested = path.resolve(rawPath);
    const ext = path.extname(requested).toLowerCase();
    if (path.basename(requested).toUpperCase() === 'SKILL.MD') throw new LearningContentError('KNOWLEDGE_SKILL_IMPORT_REQUIRED', 'استورد SKILL.md من مكتبة المهارات للحفاظ على الحجر والصلاحيات.');
    if (!['.txt', '.md', '.markdown', '.pdf'].includes(ext)) throw new LearningContentError('KNOWLEDGE_FORMAT_UNSUPPORTED', 'الاستيراد يدعم النص وMarkdown وPDF النصي غير المشفر.');
    const byteLimit = ext === '.pdf' ? PDF_LIMITS.bytes : maxBytes;
    const configured = typeof options.allowedRoots === 'function' ? await options.allowedRoots(ownerId) : options.allowedRoots;
    const roots = await Promise.all(configured.map(async root => { try { return { configured: path.resolve(root), canonical: await realpath(path.resolve(root)) }; } catch { return null; } }));
    const match = roots.find(entry => entry && (inside(entry.configured, requested) || inside(entry.canonical, requested)));
    if (!match) throw new LearningContentError('KNOWLEDGE_PATH_DENIED', 'المستند خارج مجلدات المعرفة المسموحة.', 403);
    const root = match.canonical;
    if (inside(match.configured, requested)) requested = path.join(root, path.relative(match.configured, requested));
    if (requested === root) throw new LearningContentError('KNOWLEDGE_PATH_DENIED', 'يلزم اختيار ملف داخل مجلد المعرفة.', 403);
    let cursor = root;
    for (const part of path.relative(root, requested).split(path.sep)) { cursor = path.join(cursor, part); const stat = await lstat(cursor); if (stat.isSymbolicLink()) throw new LearningContentError('KNOWLEDGE_LINK_DENIED', 'الروابط الرمزية لا تصلح كمصدر معرفة.', 403); }
    const canonical = await realpath(requested);
    if (!inside(root, canonical) || canonical !== requested && normalizeLearningText(canonical) !== normalizeLearningText(requested)) throw new LearningContentError('KNOWLEDGE_PATH_CHANGED', 'تغيّر مسار المستند أثناء القراءة.', 409);
    const handle = await open(canonical, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > byteLimit) throw new LearningContentError('KNOWLEDGE_SIZE_LIMIT', ext === '.pdf' ? 'يجب أن يكون PDF ملفًا بحجم لا يتجاوز 10 ميغابايت.' : 'يجب أن يكون المستند ملفًا نصيًا بحجم لا يتجاوز 256 كيلوبايت.');
      const buffer = Buffer.alloc(Math.min(before.size + 1, byteLimit + 1));
      let total = 0;
      while (total < buffer.length) { const read = await handle.read(buffer, total, buffer.length - total, total); if (!read.bytesRead) break; total += read.bytesRead; }
      const after = await handle.stat(), current = await lstat(canonical);
      if (total > byteLimit || current.isSymbolicLink() || current.ino !== before.ino || after.ino !== before.ino || current.size !== before.size || current.mtimeMs !== before.mtimeMs || before.size !== after.size || before.mtimeMs !== after.mtimeMs || total !== before.size || await realpath(canonical) !== canonical) throw new LearningContentError('KNOWLEDGE_SOURCE_CHANGED', 'تغيّر المستند أثناء القراءة؛ أعد المحاولة.', 409);
      const bytes = buffer.subarray(0, total);
      return { path: canonical, hash: createHash('sha256').update(bytes).digest('hex'), bytes, extractionPolicy: ext === '.pdf' ? PDF_EXTRACTION_POLICY : textExtractionPolicy };
    } finally { await handle.close(); }
  }
  async function readSource(ownerId: string, rawPath: string, signal?: AbortSignal) {
    const source = await readBytes(ownerId, rawPath);
    let text: string;
    if (source.extractionPolicy === PDF_EXTRACTION_POLICY) {
      text = await extractPdfText(source.bytes, { signal });
      // Parsing is asynchronous. Re-read within the same grants before accepting its result.
      const current = await readBytes(ownerId, source.path);
      if (current.hash !== source.hash) throw new LearningContentError('KNOWLEDGE_SOURCE_CHANGED', 'تغيّر المستند أثناء الاستخراج؛ أعد المحاولة.', 409);
    } else {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(source.bytes); } catch { throw new LearningContentError('KNOWLEDGE_ENCODING_UNSUPPORTED', 'يجب حفظ النص بترميز UTF-8.'); }
      if (!text.trim() || text.includes('\u0000')) throw new LearningContentError('KNOWLEDGE_TEXT_REQUIRED', 'المستند فارغ أو ليس نصًا صالحًا.');
    }
    return { path: source.path, hash: source.hash, extractionPolicy: source.extractionPolicy, text: cleanLearningText(text, maxBytes, options.redact) };
  }
  async function fresh(row: any): Promise<boolean> {
    // Read and hash bounded source bytes, never parse an unchanged PDF on retrieval.
    // Parser policy changes retire existing content and require a new evaluation.
    try { const current = await readBytes(row.owner_id, row.source_path); return current.hash === row.source_hash && current.extractionPolicy === row.extraction_policy && learningHash(cleanLearningText(row.text, maxBytes, options.redact)) === row.content_hash; }
    catch (error: any) { if (error instanceof LearningContentError || ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error?.code)) return false; throw error; }
  }
  async function retireStale(ownerId: string, row: any) {
    if (await fresh(row)) return false;
    await db.updateTable('learning_documents').set({ status: 'retired', updated_at: now() }).where('id', '=', row.id).where('owner_id', '=', ownerId).execute(); return true;
  }
  async function ingest(ownerId: string, raw: z.infer<typeof KnowledgeImportSchema>, signal?: AbortSignal) {
    const parsed = KnowledgeImportSchema.safeParse(raw); if (!parsed.success) throw new LearningContentError('KNOWLEDGE_IMPORT_INVALID', 'بيانات استيراد المستند غير صالحة.');
    const assertImportActive = () => { if (signal?.aborted) throw new LearningContentError('KNOWLEDGE_PDF_ABORTED', 'أُلغي استيراد المستند.', 409); };
    assertImportActive();
    const source = await readSource(ownerId, parsed.data.path, signal), sourceKey = learningHash(source.path), contentHash = learningHash(source.text);
    return transaction(async tx => {
      await lockLearningOwner(tx, ownerId);
      assertImportActive();
      const previous = await tx.selectFrom('learning_documents').selectAll().where('owner_id', '=', ownerId).where('source_key', '=', sourceKey).orderBy('version', 'desc').executeTakeFirst();
      assertImportActive();
      if (previous && previous.source_hash === source.hash && previous.content_hash === contentHash && previous.extraction_policy === source.extractionPolicy && previous.status !== 'retired') return previous;
      await tx.updateTable('learning_documents').set({ status: 'retired', updated_at: now() }).where('owner_id', '=', ownerId).where('source_key', '=', sourceKey).where('status', '!=', 'retired').execute();
      assertImportActive();
      const inserted = await tx.insertInto('learning_documents').values({ id: randomUUID(), owner_id: ownerId, source_key: sourceKey, source_path: source.path, title: cleanLearningText(parsed.data.title ?? path.basename(source.path), 200, options.redact), version: (previous?.version ?? 0) + 1, status: 'candidate', source_hash: source.hash, content_hash: contentHash, extraction_policy: source.extractionPolicy, text: source.text, chunks: JSON.stringify(knowledgeChunks(source.text)), evaluation_id: null, created_at: now(), updated_at: now() }).returningAll().executeTakeFirstOrThrow();
      // A disconnect while SQL was awaiting its result must roll back both the
      // withdrawal of the previous version and insertion of the new candidate.
      assertImportActive();
      return inserted;
    });
  }
  async function evaluate(ownerId: string, id: string, onStarted?: (receiptId: string) => void) {
    const row = await owned(db, ownerId, id);
    if (!['candidate', 'verified', 'active'].includes(row.status)) throw new LearningContentError('KNOWLEDGE_STATE_INVALID', 'لا يمكن تقييم مستند مسحوب.', 409);
    if (await retireStale(ownerId, row)) throw new LearningContentError('KNOWLEDGE_STALE', 'تغيّر المصدر أو حُذف؛ استورد نسخته الحالية.', 409);
    const receipt = await evaluateLearningSubject(db, { kind: 'knowledge', id, ownerId, hash: row.content_hash, text: row.text, title: row.title, sourceHash: row.source_hash, source: `knowledge:${row.id}:${row.version}` }, options.evaluate, false, now, onStarted);
    await transaction(async tx => {
      await lockLearningOwner(tx, ownerId); const current = await owned(tx, ownerId, id);
      if (current.status !== row.status || current.content_hash !== row.content_hash || !await fresh(current)) throw new LearningContentError('KNOWLEDGE_CHANGED', 'تغيّر المستند أثناء التقييم.', 409);
      await tx.updateTable('learning_documents').set({ status: receipt.report.passed ? current.status === 'active' ? 'active' : 'verified' : 'candidate', evaluation_id: receipt.id, updated_at: now() }).where('id', '=', id).where('owner_id', '=', ownerId).execute();
    });
    return receipt;
  }
  async function activate(ownerId: string, id: string) {
    return transaction(async tx => {
      await lockLearningOwner(tx, ownerId); const row = await owned(tx, ownerId, id);
      if (row.status !== 'verified') throw new LearningContentError('KNOWLEDGE_NOT_VERIFIED', 'يلزم تقييم المستند قبل تفعيله.', 409);
      if (!await fresh(row)) throw new LearningContentError('KNOWLEDGE_STALE', 'تغيّر المصدر أو حُذف؛ استورد نسخته الحالية.', 409);
      await requireLearningEvaluation(tx, ownerId, row, 'knowledge', now(), LEARNING_CONTEXT_POLICY);
      await tx.updateTable('learning_documents').set({ status: 'retired', updated_at: now() }).where('owner_id', '=', ownerId).where('source_key', '=', row.source_key).where('status', '=', 'active').execute();
      return tx.updateTable('learning_documents').set({ status: 'active', updated_at: now() }).where('id', '=', id).where('owner_id', '=', ownerId).returningAll().executeTakeFirstOrThrow();
    });
  }
  async function retire(ownerId: string, id: string) { return transaction(async tx => { await lockLearningOwner(tx, ownerId); await owned(tx, ownerId, id); return tx.updateTable('learning_documents').set({ status: 'retired', updated_at: now() }).where('id', '=', id).where('owner_id', '=', ownerId).returningAll().executeTakeFirstOrThrow(); }); }
  async function retrieve(ownerId: string, query: string, limit = 5) {
    if (!knowledgeQueryTerms(query).length) return [];
    const rows = await db.selectFrom('learning_documents').selectAll().where('owner_id', '=', ownerId).where('status', '=', 'active').orderBy('updated_at', 'desc').limit(100).execute();
    const documents: KnowledgeContextDocument[] = [];
    for (const row of rows) {
      if (await retireStale(ownerId, row)) continue;
      try { await requireLearningEvaluation(db, ownerId, row, 'knowledge', now(), LEARNING_CONTEXT_POLICY); } catch (error) { if (error instanceof LearningContentError) continue; throw error; }
      documents.push({ id: row.id, version: row.version, title: row.title, text: row.text, contentHash: row.content_hash, sourceHash: row.source_hash, sourcePath: row.source_path });
    }
    return selectKnowledgeChunks(documents, query, limit);
  }
  const list = (ownerId: string) => db.selectFrom('learning_documents').select(['id', 'owner_id', 'source_path', 'title', 'version', 'status', 'source_hash', 'content_hash', 'evaluation_id', 'created_at', 'updated_at']).where('owner_id', '=', ownerId).orderBy('updated_at', 'desc').limit(200).execute();
  return { ingest, evaluate, activate, retire, retrieve, list };
}
