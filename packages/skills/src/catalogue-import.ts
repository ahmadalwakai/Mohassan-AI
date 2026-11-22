import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Kysely } from 'kysely';
import { boundedText, canonicalDirectory, sourcePaths } from '@mohassan/coding/security';
import { SkillCatalogueImportRequestSchema, SkillCatalogueImportStatusSchema, Slug, type SkillCatalogueImportItem, type SkillCatalogueImportStatus } from '@mohassan/contracts';
import { folderIdentity, recordSimilaritySignals } from './catalogue.ts';
import { SkillError } from './errors.ts';
import { sha256 } from './hash.ts';
import { buildSkillSource, type SkillSourceEntry } from './importer.ts';
import { countImportedVersions, MAX_IMPORTED_TOTAL_BYTES, MAX_IMPORTED_VERSIONS_PER_OWNER, storeImmutableSkill } from './import-store.ts';
import type { createSkillLifecycle } from './lifecycle.ts';

/** Skill folders one local package may hold; a package is read once per run to fix its revision. */
export const MAX_PACKAGE_SKILLS = 10_000;
/** A batch that stopped answering for this long (its process died) may be claimed by the next request. */
const CLAIM_EXPIRES_MS = 2 * 60_000;
const PACKAGE_ID = /^[a-z0-9][a-z0-9._/-]{0,119}$/;

export interface CatalogueImportOptions {
  allowedRoots: readonly string[];
  lifecycle: Pick<ReturnType<typeof createSkillLifecycle>, 'inspect'>;
  audit(tx: Kysely<any>, ownerId: string, targetId: string, event: string, detail?: Record<string, unknown>): Promise<void>;
  now?: () => Date;
}
interface Plan { slug: string; identity: string }
interface Progress { plan: Plan[]; done: Record<string, string>; counts: SkillCatalogueImportStatus['counts']; invalidFolders: number }

const json = (value: unknown): any => (typeof value === 'string' ? JSON.parse(value) : value);
const emptyCounts = (): SkillCatalogueImportStatus['counts'] => ({ imported: 0, unchanged: 0, rejected: 0, errors: 0, quotaBlocked: 0 });
const codeOf = (error: unknown) => { const code = (error as { code?: unknown } | null)?.code; return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'SKILL_IMPORT_FAILED'; };
const REJECTING = new Set(['SKILL_FILE_UNSUPPORTED', 'SKILL_MANIFEST_INVALID', 'SKILL_MANIFEST_MISSING', 'SKILL_CONTRACT_INVALID', 'SKILL_TOO_LARGE', 'SKILL_SOURCE_REJECTED',
  'SKILL_FILES_INVALID', 'SKILL_SLUG_TAKEN', 'SKILL_VERSION_EXISTS', 'SKILL_REMOTE_SLUG_MISMATCH', 'UNSUPPORTED_FILE', 'UNSUPPORTED_ENCODING', 'SENSITIVE_SOURCE_REJECTED',
  'SENSITIVE_PROJECT_PATH', 'SYMLINK_REJECTED', 'PROJECT_TOO_LARGE', 'UNSAFE_PATH']);

/** Text files of one skill folder, read without following links and without running anything. */
async function readFolder(folder: string): Promise<SkillSourceEntry[]> {
  const entries: SkillSourceEntry[] = [];
  let bytes = 0;
  for (const relative of await sourcePaths(folder)) {
    const content = await boundedText(join(folder, ...relative.split('/')));
    bytes += Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_IMPORTED_TOTAL_BYTES) throw new SkillError('SKILL_TOO_LARGE', 'تجاوزت المهارة الحجم المسموح.');
    entries.push({ path: relative, content });
  }
  return entries;
}

/**
 * Bulk import of a local skill package (`<root>/skills/<slug>/SKILL.md`) through the ordinary path: the same importer,
 * the same immutable store, quarantine and inspection. Nothing is activated here; activation stays the owner's decision.
 *
 * - Bounded: one request imports at most `batchSize` skills and never more than the owner's remaining version quota.
 * - Resumable: a run fixes the package revision when it starts and records every finished skill; a later request,
 *   after a stop, a crash or a full quota, continues from there.
 * - Idempotent: identical content is deduplicated by the store, so importing the same package again creates nothing.
 * - Exclusive: one open run per owner and package (a unique index), and one batch of it at a time (an expiring claim).
 */
export function createCatalogueImporter(db: Kysely<any>, options: CatalogueImportOptions) {
  const now = options.now ?? (() => new Date());

  async function plan(root: string): Promise<{ plan: Plan[]; invalidFolders: number }> {
    const skillsDir = join(root, 'skills');
    let children: string[];
    try { children = (await readdir(skillsDir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort(); }
    catch { throw new SkillError('SKILL_PACKAGE_INVALID', 'لا يحتوي المجلد مجلد skills يضم المهارات.'); }
    const valid = children.filter(name => Slug.safeParse(name).success);
    if (valid.length > MAX_PACKAGE_SKILLS) throw new SkillError('SKILL_PACKAGE_TOO_LARGE', 'تحتوي الحزمة مهارات أكثر من المسموح.', 409);
    const out: Plan[] = [];
    for (const slug of valid) {
      // An unreadable folder still gets a plan entry, so the run reports it instead of skipping it.
      try { out.push({ slug, identity: folderIdentity(await readFolder(join(skillsDir, slug))) }); }
      catch (error) { out.push({ slug, identity: `unreadable:${codeOf(error)}` }); }
    }
    return { plan: out, invalidFolders: children.length - valid.length };
  }
  async function packageId(root: string): Promise<string> {
    try {
      const manifest = JSON.parse(await readFile(join(root, 'catalogue.json'), 'utf8'));
      if (typeof manifest?.package === 'string' && PACKAGE_ID.test(manifest.package)) return manifest.package;
    } catch { /* No manifest: the folder name names the package. */ }
    const fallback = `local/${basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 100) || 'package'}`;
    return PACKAGE_ID.test(fallback) ? fallback : 'local/package';
  }

  async function openRun(ownerId: string, root: string, pkg: string): Promise<{ id: string; resumed: boolean; progress: Progress; revision: string }> {
    const existing = await db.selectFrom('skill_catalogue_imports').selectAll().where('owner_id', '=', ownerId).where('package', '=', pkg).where('status', '=', 'running').executeTakeFirst();
    if (existing) {
      if (existing.root !== root) throw new SkillError('SKILL_IMPORT_RUNNING', 'يوجد استيراد مفتوح لهذه الحزمة من مجلد آخر.', 409);
      return { id: existing.id, resumed: true, progress: json(existing.progress), revision: existing.revision };
    }
    const planned = await plan(root);
    const revision = sha256(JSON.stringify(planned.plan.map(entry => [entry.slug, entry.identity])));
    const id = randomUUID();
    const progress: Progress = { plan: planned.plan, done: {}, counts: emptyCounts(), invalidFolders: planned.invalidFolders };
    try {
      await db.insertInto('skill_catalogue_imports').values({ id, owner_id: ownerId, package: pkg, root, revision, status: 'running', progress: JSON.stringify(progress), report: JSON.stringify({}) }).execute();
    } catch (error) {
      // Another request opened the same run first: continue that one.
      if ((error as { code?: string } | null)?.code !== '23505') throw error;
      return openRun(ownerId, root, pkg);
    }
    return { id, resumed: false, progress, revision };
  }

  async function claim(id: string): Promise<string> {
    const token = randomUUID();
    const claimed = await db.updateTable('skill_catalogue_imports').set({ claim: token, heartbeat_at: now() })
      .where('id', '=', id).where('status', '=', 'running')
      .where(eb => eb.or([eb('claim', 'is', null), eb('heartbeat_at', '<', new Date(now().getTime() - CLAIM_EXPIRES_MS))]))
      .returning('id').executeTakeFirst();
    if (!claimed) throw new SkillError('SKILL_IMPORT_BUSY', 'دفعة أخرى من هذا الاستيراد قيد التنفيذ.', 409);
    return token;
  }

  async function importOne(ownerId: string, root: string, pkg: string, entry: Plan): Promise<{ item: SkillCatalogueImportItem; identity: string }> {
    const folder = join(root, 'skills', entry.slug);
    const base = { slug: entry.slug, versionId: null, contentHash: null, verdict: null, code: null, message: null } as const;
    let files: SkillSourceEntry[];
    try { files = await readFolder(folder); }
    catch (error) { return { item: { ...base, outcome: 'rejected', code: codeOf(error), message: (error as Error).message?.slice(0, 300) ?? null }, identity: entry.identity }; }
    const identity = folderIdentity(files);
    try {
      const source = buildSkillSource(files, { root: folder, defaultSlug: entry.slug });
      const stored = await db.transaction().execute(tx => storeImmutableSkill(tx, ownerId, source, { origin: 'local_import', audit: options.audit, catalogue: { package: pkg } }));
      let version = await db.selectFrom('skill_versions').select(['status', 'revision', 'content_hash']).where('owner_id', '=', ownerId).where('id', '=', stored.id).executeTakeFirstOrThrow();
      // A version stored by a batch that stopped before inspecting it is still quarantined: inspect it now.
      if (version.status === 'quarantined') {
        await options.lifecycle.inspect(ownerId, stored.id, { expectedRevision: version.revision });
        version = await db.selectFrom('skill_versions').select(['status', 'revision', 'content_hash']).where('owner_id', '=', ownerId).where('id', '=', stored.id).executeTakeFirstOrThrow();
      }
      const inspection = await db.selectFrom('skill_inspections').select('verdict').where('version_id', '=', stored.id).where('content_hash', '=', version.content_hash).orderBy('created_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
      const outcome = version.status === 'rejected' || version.status === 'incompatible' ? 'rejected' : stored.deduplicated ? 'unchanged' : 'imported';
      return { item: { ...base, outcome, versionId: stored.id, contentHash: version.content_hash, verdict: inspection?.verdict ?? null, code: outcome === 'rejected' ? version.status.toUpperCase() : null,
        message: identity !== entry.identity ? 'تغير محتوى المهارة أثناء الاستيراد؛ استُورد المحتوى الحالي.' : null }, identity };
    } catch (error) {
      const code = codeOf(error);
      if (code === 'SKILL_QUOTA_EXCEEDED') return { item: { ...base, outcome: 'quota_blocked', code, message: (error as Error).message?.slice(0, 300) ?? null }, identity };
      return { item: { ...base, outcome: REJECTING.has(code) ? 'rejected' : 'error', code, message: (error as Error).message?.slice(0, 300) ?? null }, identity };
    }
  }

  /** One bounded batch of the open run for this package (opening the run first when there is none). */
  async function batch(ownerId: string, input: unknown): Promise<SkillCatalogueImportStatus> {
    const request = SkillCatalogueImportRequestSchema.parse(input ?? {});
    const root = await canonicalDirectory(request.path, options.allowedRoots);
    const pkg = await packageId(root);
    const run = await openRun(ownerId, root, pkg);
    const token = await claim(run.id);
    const progress = run.progress;
    const items: SkillCatalogueImportItem[] = [];
    let status: 'running' | 'succeeded' | 'failed' = 'running', errorCode: string | null = null;
    const flush = () => db.updateTable('skill_catalogue_imports').set({ progress: JSON.stringify(progress), heartbeat_at: now() }).where('id', '=', run.id).where('claim', '=', token).execute();
    try {
      const pending = progress.plan.filter(entry => progress.done[entry.slug] === undefined);
      // Never plan more new versions than the owner may still store; identical content needs none and still goes through.
      const used = await countImportedVersions(db, ownerId, 'other');
      let room = Math.max(0, MAX_IMPORTED_VERSIONS_PER_OWNER - used);
      for (const entry of pending.slice(0, request.batchSize)) {
        const { item, identity } = await importOne(ownerId, root, pkg, entry);
        items.push(item);
        if (item.outcome === 'quota_blocked') { progress.counts.quotaBlocked++; status = 'failed'; errorCode = 'SKILL_QUOTA_EXCEEDED'; break; }
        if (item.outcome === 'imported') { progress.counts.imported++; room--; }
        else if (item.outcome === 'unchanged') progress.counts.unchanged++;
        else if (item.outcome === 'rejected') progress.counts.rejected++;
        else progress.counts.errors++;
        // An error (not a rejection) stays pending so the next batch tries it again; everything else is finished.
        if (item.outcome !== 'error') progress.done[entry.slug] = identity;
        await flush();
        if (room <= 0 && pending.some(next => progress.done[next.slug] === undefined)) { status = 'failed'; errorCode = 'SKILL_QUOTA_EXCEEDED'; break; }
      }
      const imported = items.filter(item => item.outcome === 'imported').map(item => item.slug);
      if (imported.length) await recordSimilaritySignals(db, ownerId, imported);
      const remaining = progress.plan.filter(entry => progress.done[entry.slug] === undefined);
      if (status === 'running' && !remaining.length) status = 'succeeded';
      // A batch whose every remaining entry failed with an error is not stuck forever: the run ends failed and a new one may start.
      if (status === 'running' && remaining.length && items.length && items.every(item => item.outcome === 'error')) { status = 'failed'; errorCode = 'SKILL_IMPORT_ERRORS'; }
    } catch (error) {
      status = 'failed'; errorCode = codeOf(error);
    }
    const report = { items: items.slice(0, 100) };
    await db.updateTable('skill_catalogue_imports').set({
      progress: JSON.stringify(progress), report: JSON.stringify(report), claim: null, heartbeat_at: now(),
      ...(status === 'running' ? {} : { status, error_code: errorCode, finished_at: now() }),
    }).where('id', '=', run.id).where('claim', '=', token).execute();
    await options.audit(db, ownerId, run.id, 'skill.catalogue_import_batch', { package: pkg, revision: run.revision, status, imported: items.filter(item => item.outcome === 'imported').length, errorCode });
    const used = await countImportedVersions(db, ownerId, 'other');
    return SkillCatalogueImportStatusSchema.parse({
      runId: run.id, package: pkg, revision: run.revision, status, resumed: run.resumed,
      progress: { processed: Object.keys(progress.done).length, total: progress.plan.length }, counts: { ...progress.counts, errors: progress.counts.errors + (progress.invalidFolders ?? 0) },
      quota: { used, limit: MAX_IMPORTED_VERSIONS_PER_OWNER }, items: items.slice(0, 100), errorCode,
    });
  }

  /** Runs that are open and silent beyond the claim window, for the status of a package: nothing is changed by reading. */
  async function latest(ownerId: string, pkg: string) {
    return db.selectFrom('skill_catalogue_imports').select(['id', 'status', 'revision', 'error_code', 'started_at', 'finished_at']).where('owner_id', '=', ownerId).where('package', '=', pkg)
      .orderBy('started_at', 'desc').orderBy('id', 'desc').limit(10).execute();
  }
  return { batch, latest };
}
export type CatalogueImporter = ReturnType<typeof createCatalogueImporter>;
