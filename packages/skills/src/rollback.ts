import { randomUUID } from 'node:crypto';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { SkillNodeBindingSchema, SkillRollbackInputSchema, SkillRollbackReviewSchema, type SkillRollbackInput } from '@mohassan/contracts';
import { assertNoLinks, boundedText, canonicalDirectory, containsPath, safeRelative, sensitivePath } from '@mohassan/coding/security';
import { SkillError } from './errors.ts';
import { hashSkillData } from './evidence.ts';
import { readSkillExecutionAuthority } from './execution-authority.ts';
import { sha256 } from './hash.ts';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Request = z.object({ preimageId: z.uuid(), expectedAfterHash: Hash }).strict();
const FileInput = z.object({ root: z.string().min(3).max(1000), path: z.string().min(1).max(180), content: z.string().max(64000), expectedHash: Hash.nullable() }).strict();
const FileOutput = z.object({ root: z.string(), path: z.string(), hash: Hash, bytes: z.number().int().nonnegative().max(64000), previousHash: Hash.nullable() }).strict();
const Result = z.object({ kind: z.literal('skill_rollback'), outcome: z.literal('restored'), rollbackId: z.uuid(), runId: z.uuid(), preimageId: z.uuid(), sourceReceiptId: z.uuid(), root: z.string(), path: z.string(), replacedHash: Hash, restoredHash: Hash.nullable(), deleted: z.boolean(), verifiedAt: z.iso.datetime() }).strict();
const json = (value: any): any => typeof value === 'string' ? JSON.parse(value) : value;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const samePath = (left: string, right: string) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const resourceKey = (path: string) => sha256(`file:${process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)}`);
const textHash = (text: string | null) => text === null ? null : sha256(text);
function fault(code: string, message: string, status = 409): never { throw new SkillError(code, message, status); }
async function current(path: string) { try { return await boundedText(path, 64000); } catch (error) { if (missing(error)) return null; throw error; } }

export interface SkillRollbackContext {
  ownerId: string; taskId: string; leaseToken: string; signal: AbortSignal; assertActive(): Promise<void>;
}

/** Confirmed-write undo only. Unknown filesystem effects and orphan staging
 * files are never retried, cleaned or force-overwritten here. */
export function createSkillRollbackControl(db: Kysely<any>) {
  async function source(connection: Kysely<any>, ownerId: string, runId: string, preimageId: string, insideTransaction = false) {
    const row = await connection.selectFrom('skill_preimages as p')
      .innerJoin('skill_evidence as e', 'e.id', 'p.receipt_id')
      .innerJoin('skill_runs as r', 'r.id', 'e.run_id')
      .innerJoin('skill_run_nodes as n', joiner => joiner.onRef('n.run_id', '=', 'e.run_id').onRef('n.node_id', '=', 'e.node_id'))
      .innerJoin('tasks as t', 't.id', 'e.task_id')
      .selectAll('p').select(['e.run_id', 'e.node_id', 'e.task_id as source_task_id', 'e.status as receipt_status', 'e.details', 'e.inputs_hash', 'e.output_hash', 'e.output', 'e.version_id', 'e.content_hash', 'r.parent_task_id', 'n.tool', 'n.kind', 'n.child_task_id', 'n.version_id as node_version_id', 'n.content_hash as node_content_hash', 't.status as child_status', 't.result as child_result'])
      .where('p.id', '=', preimageId).where('p.owner_id', '=', ownerId).where('e.owner_id', '=', ownerId).where('r.owner_id', '=', ownerId).where('n.owner_id', '=', ownerId).where('t.owner_id', '=', ownerId).where('r.id', '=', runId).executeTakeFirst();
    if (!row) fault('SKILL_ROLLBACK_NOT_FOUND', 'لم يُعثر على صورة سابقة مملوكة لهذا التشغيل.', 404);
    if (row.receipt_status !== 'succeeded' || row.child_status !== 'completed' || row.tool !== 'file.write' || row.kind !== 'tool' || row.child_task_id !== row.source_task_id) fault('SKILL_ROLLBACK_UNCONFIRMED', 'التراجع الآلي متاح لكتابة ناجحة موثقة فقط؛ الأثر غير المحسوم يحتاج مراجعة يدوية.');
    if (row.node_version_id !== row.version_id || row.node_content_hash !== row.content_hash) fault('SKILL_ROLLBACK_EVIDENCE_CHANGED', 'تغير ربط دليل الكتابة.');
    const binding = SkillNodeBindingSchema.parse({ parentTaskId: row.parent_task_id, runId: row.run_id, nodeId: row.node_id, versionId: row.version_id, contentHash: row.content_hash, inputsHash: row.inputs_hash, kind: 'tool', tool: 'file.write' });
    const authority = await readSkillExecutionAuthority(connection, ownerId, binding, insideTransaction);
    if (authority.contract.rollback.mode !== 'restore_preimage') fault('SKILL_ROLLBACK_MANUAL_REQUIRED', 'عقد هذه المهارة لا يصرح باستعادة آلية للصورة السابقة.');
    const entries = json(row.details).filter((entry: any) => entry.kind === 'gateway.result');
    if (entries.length !== 1) fault('SKILL_ROLLBACK_EVIDENCE_CHANGED', 'دليل الكتابة الأصلي غير مكتمل.');
    const input = FileInput.parse(entries[0].data.inputs), output = FileOutput.parse(entries[0].data.actual), child = json(row.child_result);
    if (hashSkillData(input) !== row.inputs_hash || hashSkillData(json(row.output)) !== row.output_hash || child?.evidenceId !== row.receipt_id || child?.inputsHash !== row.inputs_hash || child?.outputHash !== row.output_hash || child?.runId !== runId || child?.nodeId !== row.node_id || hashSkillData(child.output) !== row.output_hash) fault('SKILL_ROLLBACK_EVIDENCE_CHANGED', 'لا يطابق إيصال المهمة دليل الكتابة المحفوظ.');
    if (input.path !== row.path || output.root !== row.root || output.path !== row.path || input.expectedHash !== row.before_hash || output.previousHash !== row.before_hash || output.hash !== row.after_hash || sha256(input.content) !== row.after_hash || Buffer.byteLength(input.content) !== output.bytes || textHash(row.before_text) !== row.before_hash) fault('SKILL_ROLLBACK_PREIMAGE_CHANGED', 'لا تطابق الصورة السابقة بصمات الكتابة المثبتة.');
    const root = await canonicalDirectory(row.root, authority.roots), granted = await Promise.all(authority.roots.map(value => realpath(value)));
    if (!granted.some(value => samePath(value, root)) || !samePath(await realpath(input.root), root)) fault('SKILL_ROLLBACK_ROOT_REVOKED', 'لم يعد الجذر مطابقًا لمجلد ممنوح صراحة.', 403);
    const path = safeRelative(row.path);
    if (sensitivePath(path) || !authority.contract.requires.paths.some(scope => path === scope || path.startsWith(`${scope}/`))) fault('SKILL_ROLLBACK_PATH_REVOKED', 'لم يعد المسار مصرحًا به في العقد الحالي.', 403);
    const absolute = join(root, ...path.split('/')); await assertNoLinks(absolute);
    if (!containsPath(root, await realpath(dirname(absolute)))) fault('SKILL_ROLLBACK_OUTSIDE_ROOT', 'الملف خارج الجذر الممنوح.', 403);
    const preimageHash = hashSkillData({ ownerId, runId, preimageId, sourceReceiptId: row.receipt_id, sourceTaskId: row.source_task_id, versionId: row.version_id, contentHash: row.content_hash, root, path, beforeHash: row.before_hash, afterHash: row.after_hash });
    return { row, root, path, absolute, preimageHash };
  }

  async function prepared(ownerId: string, raw: unknown, connection: Kysely<any>, insideTransaction: boolean) {
    const input = SkillRollbackInputSchema.parse(raw), saved = await source(connection, ownerId, input.runId, input.preimageId, insideTransaction);
    if (input.sourceReceiptId !== saved.row.receipt_id || input.preimageHash !== saved.preimageHash || input.expectedAfterHash !== saved.row.after_hash) fault('SKILL_ROLLBACK_INPUT_CHANGED', 'تغيرت الصورة السابقة أو بصمة النسخة المطلوب التراجع عنها.');
    const review = SkillRollbackReviewSchema.parse({ root: saved.root, path: saved.path, beforeHash: saved.row.before_hash, afterHash: saved.row.after_hash, deletedOnRestore: saved.row.before_text === null, bytes: Buffer.byteLength(saved.row.before_text ?? '', 'utf8') });
    return { input, review, title: `استعادة ${saved.path}`.slice(0, 120), goal: `استعادة الملف المحدد ${saved.root}/${saved.path} إلى صورته السابقة الموثقة فقط بعد مطابقة البصمة ${saved.row.after_hash}. ${review.deletedOnRestore ? 'سيُحذف الملف لأنه لم يكن موجودًا قبل الكتابة.' : `ستعاد البصمة ${review.beforeHash}.`} لا تُستبدل أي تغييرات أحدث.`, saved };
  }

  async function prepare(ownerId: string, input: SkillRollbackInput, transaction?: Kysely<any>) {
    // Runtime calls this again after restoration. Only immutable evidence and
    // current authority are checked here; execute/verify check file contents.
    const { saved: _, ...result } = await prepared(ownerId, input, transaction ?? db, Boolean(transaction)); return result;
  }
  async function describe(ownerId: string, runId: string, raw: unknown) {
    z.uuid().parse(runId); const request = Request.parse(raw), saved = await source(db, ownerId, runId, request.preimageId);
    const input = SkillRollbackInputSchema.parse({ runId, preimageId: request.preimageId, sourceReceiptId: saved.row.receipt_id, preimageHash: saved.preimageHash, expectedAfterHash: request.expectedAfterHash });
    const result = await prepare(ownerId, input);
    if (textHash(await current(saved.absolute)) !== input.expectedAfterHash) fault('SKILL_ROLLBACK_FILE_CHANGED', 'تغير الملف بعد الكتابة الأصلية؛ لن يستبدل التراجع التغيير اللاحق.');
    if (await db.selectFrom('skill_rollbacks').select('id').where('preimage_id', '=', input.preimageId).where('status', 'in', ['started', 'unknown', 'succeeded']).executeTakeFirst()) fault('SKILL_ROLLBACK_ALREADY_STARTED', 'بدأت استعادة هذه الصورة سابقًا؛ لا تعاد المحاولة المجهولة أو الناجحة.');
    return result;
  }
  async function preview(ownerId: string, runId: string) {
    z.uuid().parse(runId);
    if (!await db.selectFrom('skill_runs').select('id').where('id', '=', runId).where('owner_id', '=', ownerId).executeTakeFirst()) fault('SKILL_RUN_NOT_FOUND', 'لم يُعثر على تشغيل المهارة.', 404);
    const rows = await db.selectFrom('skill_preimages as p').innerJoin('skill_evidence as e', 'e.id', 'p.receipt_id').select(['p.id', 'p.root', 'p.path', 'p.before_hash', 'p.after_hash', 'p.receipt_id']).where('p.owner_id', '=', ownerId).where('e.owner_id', '=', ownerId).where('e.run_id', '=', runId).orderBy('p.id').limit(144).execute();
    const items = [];
    for (const row of rows) {
      try { const result = await describe(ownerId, runId, { preimageId: row.id, expectedAfterHash: row.after_hash }); items.push({ preimageId: row.id, sourceReceiptId: row.receipt_id, ...result.review, eligible: true, reasonCode: null }); }
      catch (error) { items.push({ preimageId: row.id, sourceReceiptId: row.receipt_id, root: row.root, path: row.path, beforeHash: row.before_hash, afterHash: row.after_hash, eligible: false, reasonCode: error instanceof SkillError ? error.code : 'SKILL_ROLLBACK_RESOURCE_UNAVAILABLE' }); }
    }
    return { runId, items, scope: 'confirmed_file_writes_only' as const, unresolvedEffects: 'manual_review_required' as const };
  }

  async function fenced(connection: Kysely<any>, context: SkillRollbackContext, rollbackId?: string) {
    context.signal.throwIfAborted();
    const task = await connection.selectFrom('tasks').select('id').where('id', '=', context.taskId).where('owner_id', '=', context.ownerId).where('capability_id', '=', 'skill.rollback').where('status', 'in', ['running', 'verifying']).where('lease_token', '=', context.leaseToken).where('lease_expires_at', '>', sql<Date>`CURRENT_TIMESTAMP`).where('cancellation_requested', '=', false).forUpdate().executeTakeFirst();
    if (!task) fault('SKILL_ROLLBACK_FENCE_LOST', 'انتهى تفويض محاولة الاستعادة.');
    if (rollbackId && !await connection.selectFrom('skill_rollbacks').select('id').where('id', '=', rollbackId).where('task_id', '=', context.taskId).where('owner_id', '=', context.ownerId).where('lease_token', '=', context.leaseToken).where('status', '=', 'started').forUpdate().executeTakeFirst()) fault('SKILL_ROLLBACK_FENCE_LOST', 'لم تعد محاولة الاستعادة مملوكة للعامل.');
  }
  async function active(context: SkillRollbackContext, input: SkillRollbackInput) { context.signal.throwIfAborted(); await context.assertActive(); await prepare(context.ownerId, input); context.signal.throwIfAborted(); }

  async function execute(raw: SkillRollbackInput, context: SkillRollbackContext): Promise<Record<string, unknown>> {
    const input = SkillRollbackInputSchema.parse(raw); await active(context, input);
    const initial = await prepared(context.ownerId, input, db, false);
    if (textHash(await current(initial.saved.absolute)) !== input.expectedAfterHash) fault('SKILL_ROLLBACK_FILE_CHANGED', 'تغير الملف عن البصمة الموافق عليها؛ لم تُجرَ كتابة.');
    const rollbackId = randomUUID(), key = resourceKey(initial.saved.absolute);
    try {
      await db.transaction().execute(async tx => {
        await fenced(tx, context);
        await prepared(context.ownerId, input, tx, true);
        await tx.insertInto('skill_rollbacks').values({ id: rollbackId, owner_id: context.ownerId, run_id: input.runId, preimage_id: input.preimageId, source_receipt_id: input.sourceReceiptId, task_id: context.taskId, lease_token: context.leaseToken, input_hash: hashSkillData(input), before_hash: initial.saved.row.before_hash, after_hash: input.expectedAfterHash, status: 'started' }).execute();
        await tx.insertInto('skill_resource_locks').values({ resource_key: key, receipt_id: null, rollback_id: rollbackId, run_id: input.runId, node_id: initial.saved.row.node_id, owner_id: context.ownerId }).onConflict(conflict => conflict.column('resource_key').doNothing()).execute();
        const lock = await tx.selectFrom('skill_resource_locks').select(['receipt_id', 'rollback_id']).where('resource_key', '=', key).executeTakeFirstOrThrow();
        if (lock.rollback_id !== rollbackId || lock.receipt_id !== null) fault('SKILL_RESOURCE_BUSY', 'المورد مرتبط بمحاولة أخرى؛ لن تُسرق ملكيته.');
      });
    } catch (error) { if ((error as { code?: string })?.code === '23505') fault('SKILL_ROLLBACK_ALREADY_STARTED', 'بدأت استعادة هذه الصورة أو المهمة سابقًا.'); throw error; }
    let staging: string | undefined, stagingCreated = false, publicationAttempted = false, failure: unknown, result: z.infer<typeof Result> | undefined;
    try {
      await active(context, input);
      const { saved } = await prepared(context.ownerId, input, db, false);
      if (textHash(await current(saved.absolute)) !== input.expectedAfterHash) fault('SKILL_ROLLBACK_FILE_CHANGED', 'تغير الملف قبل الاستعادة؛ لم يُستبدل.');
      if (saved.row.before_text !== null) {
        staging = join(dirname(saved.absolute), `.mohassan-rollback-${rollbackId}.tmp`);
        const handle = await open(staging, 'wx', 0o600);
        stagingCreated = true;
        try { await handle.writeFile(saved.row.before_text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      }
      await active(context, input); await assertNoLinks(saved.absolute);
      const info = await lstat(saved.absolute);
      if (!info.isFile() || info.nlink !== 1 || info.isSymbolicLink() || textHash(await current(saved.absolute)) !== input.expectedAfterHash) fault('SKILL_ROLLBACK_FILE_CHANGED', 'تغير الملف أو حدوده قبل النشر؛ لم تُفرض الاستعادة.');
      await db.transaction().execute(async tx => { await fenced(tx, context, rollbackId); await tx.updateTable('skill_rollbacks').set({ effect_started: true }).where('id', '=', rollbackId).execute(); });
      await active(context, input);
      // Authority checks await SQL/filesystem work. Re-read after those checks
      // so a later user edit is not hidden by the earlier prepublication hash.
      if (textHash(await current(saved.absolute)) !== input.expectedAfterHash) fault('SKILL_ROLLBACK_FILE_CHANGED', 'تغير الملف أثناء التحقق من الموافقة؛ لم يُستبدل التغيير اللاحق.');
      publicationAttempted = true;
      if (saved.row.before_text === null) await unlink(saved.absolute);
      else { await rename(staging!, saved.absolute); staging = undefined; stagingCreated = false; }
      if (textHash(await current(saved.absolute)) !== saved.row.before_hash) fault('SKILL_ROLLBACK_VERIFY_FAILED', 'تعذر إثبات الصورة المستعادة؛ المحاولة بحاجة مراجعة.');
      await active(context, input);
      result = Result.parse({ kind: 'skill_rollback', outcome: 'restored', rollbackId, runId: input.runId, preimageId: input.preimageId, sourceReceiptId: input.sourceReceiptId, root: saved.root, path: saved.path, replacedHash: input.expectedAfterHash, restoredHash: saved.row.before_hash, deleted: saved.row.before_text === null, verifiedAt: new Date().toISOString() });
    } catch (error) { failure = error; }
    finally {
      if (staging && stagingCreated) try { await unlink(staging); } catch (error) { if (!missing(error)) { failure ??= error; publicationAttempted = true; } }
    }
    if (failure || !result) {
      await db.transaction().execute(async tx => {
        const updated = await tx.updateTable('skill_rollbacks').set({ status: publicationAttempted ? 'unknown' : 'failed', error_code: failure instanceof SkillError ? failure.code : 'SKILL_ROLLBACK_FAILED', finished_at: new Date() }).where('id', '=', rollbackId).where('task_id', '=', context.taskId).where('owner_id', '=', context.ownerId).where('lease_token', '=', context.leaseToken).where('status', '=', 'started').returning('id').executeTakeFirst();
        if (updated && !publicationAttempted) await tx.deleteFrom('skill_resource_locks').where('rollback_id', '=', rollbackId).execute();
      });
      throw failure ?? new SkillError('SKILL_ROLLBACK_FAILED', 'لم تكتمل الاستعادة.');
    }
    try {
      await db.transaction().execute(async tx => {
        await fenced(tx, context, rollbackId);
        await tx.updateTable('skill_rollbacks').set({ status: 'succeeded', result: JSON.stringify(result), result_hash: hashSkillData(result), finished_at: new Date() }).where('id', '=', rollbackId).execute();
        await tx.deleteFrom('skill_resource_locks').where('rollback_id', '=', rollbackId).execute();
      });
    } catch (error) {
      await db.updateTable('skill_rollbacks').set({ status: 'unknown', error_code: 'SKILL_ROLLBACK_FENCE_LOST', finished_at: new Date() }).where('id', '=', rollbackId).where('lease_token', '=', context.leaseToken).where('status', '=', 'started').execute(); throw error;
    }
    return result;
  }

  async function verify(raw: unknown, rawInput: SkillRollbackInput, context: SkillRollbackContext): Promise<Record<string, unknown> | null> {
    try {
      const input = SkillRollbackInputSchema.parse(rawInput), result = Result.parse(raw); await active(context, input);
      const { saved } = await prepared(context.ownerId, input, db, false);
      const receipt = await db.selectFrom('skill_rollbacks').selectAll().where('id', '=', result.rollbackId).where('owner_id', '=', context.ownerId).where('task_id', '=', context.taskId).where('lease_token', '=', context.leaseToken).where('preimage_id', '=', input.preimageId).where('source_receipt_id', '=', input.sourceReceiptId).where('status', '=', 'succeeded').executeTakeFirst();
      if (!receipt || receipt.input_hash !== hashSkillData(input) || receipt.result_hash !== hashSkillData(result) || hashSkillData(json(receipt.result)) !== receipt.result_hash || result.runId !== input.runId || result.preimageId !== input.preimageId || result.sourceReceiptId !== input.sourceReceiptId || result.root !== saved.root || result.path !== saved.path || result.replacedHash !== input.expectedAfterHash || result.restoredHash !== saved.row.before_hash || result.deleted !== (saved.row.before_text === null) || textHash(await current(saved.absolute)) !== saved.row.before_hash) return null;
      await active(context, input); return result;
    } catch { return null; }
  }

  /** Metadata reconciliation only. A lost writer may have reached the filesystem;
   * preserve its resource lock and staging files until an independent review. */
  async function recoverExpired() {
    const candidates = await db.selectFrom('skill_rollbacks as r').innerJoin('tasks as t', 't.id', 'r.task_id')
      .select(['r.id', 'r.task_id', 'r.owner_id', 'r.lease_token']).where('r.status', '=', 'started')
      .where(sql<boolean>`(t.status NOT IN ('running', 'verifying') OR t.capability_id <> 'skill.rollback' OR t.lease_token IS DISTINCT FROM r.lease_token OR t.lease_expires_at IS NULL OR t.lease_expires_at <= CURRENT_TIMESTAMP)`)
      .orderBy('r.created_at').limit(100).execute();
    let unknown = 0;
    for (const candidate of candidates) {
      const changed = await db.transaction().execute(async tx => {
        // Match execute's task -> journal lock order. Recheck after locking;
        // a candidate read alone cannot fence a still-active worker.
        const task = await tx.selectFrom('tasks').select(['status', 'capability_id', 'lease_token', sql<boolean>`lease_expires_at > CURRENT_TIMESTAMP`.as('lease_live')])
          .where('id', '=', candidate.task_id).where('owner_id', '=', candidate.owner_id).forUpdate().executeTakeFirst();
        if (task && task.capability_id === 'skill.rollback' && ['running', 'verifying'].includes(task.status) && task.lease_token === candidate.lease_token && task.lease_live === true) return false;
        return Boolean(await tx.updateTable('skill_rollbacks').set({ status: 'unknown', error_code: 'SKILL_ROLLBACK_WRITER_LOST', finished_at: new Date() })
          .where('id', '=', candidate.id).where('task_id', '=', candidate.task_id).where('owner_id', '=', candidate.owner_id).where('lease_token', '=', candidate.lease_token).where('status', '=', 'started').returning('id').executeTakeFirst());
      });
      if (changed) unknown++;
    }
    return { unknown };
  }
  return { prepare, describe, preview, execute, verify, recoverExpired };
}
