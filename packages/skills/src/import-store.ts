import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { credentialLike, safeRelative, sensitivePath } from '@mohassan/coding/security';
import { SkillContractSchema, type SkillContract } from '@mohassan/contracts';
import { SkillError } from './errors.ts';
import { parseSkillManifest } from './frontmatter.ts';
import { classifySkillFile, type InspectableFile } from './inspector.ts';
import { sha256, skillContentHash, skillContentMatches } from './hash.ts';
import { acquireSkillLifecycleLock } from './lifecycle-lock.ts';

export const MAX_IMPORTED_VERSIONS_PER_OWNER = 200;
export const MAX_IMPORTED_TOTAL_BYTES = 256000;
export interface ImmutableSkillSource { contract: SkillContract; explicitVersion: boolean; files: InspectableFile[]; totalBytes: number; root: string }
export interface ImmutableSkillStoreOptions {
  origin: 'local_import' | 'forge';
  audit(tx: Kysely<any>, ownerId: string, targetId: string, event: string, detail?: Record<string, unknown>): Promise<void>;
  rebuildGraph?(tx: Kysely<any>, ownerId: string): Promise<void>;
  parent?: { id: string; revision: number; contentHash: string; mode: 'mutate' | 'fork' };
}
export function nextSkillVersion(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number), next = `${major}.${minor}.${patch + 1}`;
  if (!/^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,4})$/.test(next)) throw new SkillError('SKILL_VERSION_LIMIT', 'بلغ الإصدار التلقائي حده؛ حدد إصداراً جديداً صالحاً في العقد.', 409);
  return next;
}
export async function nextSkillFamilyVersion(tx: Kysely<any>, familyId: string): Promise<string> {
  const largest = await tx.selectFrom('skill_versions').select('version').where('family_id', '=', familyId)
    .orderBy(sql<number>`split_part(version, '.', 1)::integer`, 'desc').orderBy(sql<number>`split_part(version, '.', 2)::integer`, 'desc').orderBy(sql<number>`split_part(version, '.', 3)::integer`, 'desc').executeTakeFirst();
  return largest ? nextSkillVersion(largest.version) : '1.0.0';
}
export async function lockSkillStoreOwner(tx: Kysely<any>, ownerId: string): Promise<void> {
  if (!await tx.selectFrom('user').select('id').where('id', '=', ownerId).forUpdate().executeTakeFirst()) throw new SkillError('SKILL_OWNER_NOT_FOUND', 'لم يُعثر على المالك.', 404);
  await acquireSkillLifecycleLock(tx, ownerId);
}
export function validateImmutableSkillSource(raw: ImmutableSkillSource): ImmutableSkillSource {
  const contract = SkillContractSchema.parse(raw.contract), files = raw.files.map(file => ({ ...file }));
  if (credentialLike(JSON.stringify(contract))) throw new SkillError('SKILL_SOURCE_REJECTED', 'يتضمن العقد صيغة اعتماد حساسة.');
  if (!files.length || files.length > 40 || new Set(files.map(file => file.path.toLowerCase())).size !== files.length) throw new SkillError('SKILL_FILES_INVALID', 'عدد الملفات أو أسماؤها غير صالح.');
  let bytes = 0;
  for (const file of files) {
    if (safeRelative(file.path) !== file.path || sensitivePath(file.path) || file.path === 'skill.contract.json' || classifySkillFile(file.path) !== file.kind) throw new SkillError('SKILL_FILE_UNSUPPORTED', 'مسار ملف أو نوعه غير مدعوم.');
    const length = Buffer.byteLength(file.content); bytes += length;
    if (length > 64000 || file.content.includes('\0') || credentialLike(file.content)) throw new SkillError('SKILL_SOURCE_REJECTED', 'ملف المصدر غير صالح أو يتضمن صيغة اعتماد حساسة.');
    // Reject isolated UTF-16 surrogates rather than silently replacing bytes.
    if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(file.content)) !== file.content) throw new SkillError('SKILL_SOURCE_REJECTED', 'ملف المصدر ليس نص UTF-8 قابلاً للتثبيت.');
  }
  if (!Number.isSafeInteger(raw.totalBytes) || raw.totalBytes < bytes || raw.totalBytes > MAX_IMPORTED_TOTAL_BYTES || bytes > MAX_IMPORTED_TOTAL_BYTES) throw new SkillError('SKILL_TOO_LARGE', 'تجاوزت المهارة الحجم المسموح.');
  const manifest = files.find(file => file.path === 'SKILL.md' && file.kind === 'instructions');
  if (!manifest) throw new SkillError('SKILL_MANIFEST_MISSING', 'لا تحتوي المهارة ملف SKILL.md.');
  parseSkillManifest(manifest.content);
  return { ...raw, contract, files };
}
/** One immutable storage boundary for local files and generated text. Callers
 * must supply a transaction; this function never executes stored scripts. */
export async function storeImmutableSkill(tx: Kysely<any>, ownerId: string, raw: ImmutableSkillSource, options: ImmutableSkillStoreOptions) {
  const loaded = validateImmutableSkillSource(raw);
  await lockSkillStoreOwner(tx, ownerId);
  const parent = options.parent ? await tx.selectFrom('skill_versions as v').leftJoin('skill_sources as s', 's.version_id', 'v.id').selectAll('v').select('s.kind as source_kind').where('v.owner_id', '=', ownerId).where('v.id', '=', options.parent.id).executeTakeFirst() : undefined;
  if (options.origin === 'forge') {
    if (!parent || !options.parent || parent.revision !== options.parent.revision || parent.content_hash !== options.parent.contentHash) throw new SkillError('SKILL_FORGE_PARENT_CHANGED', 'تغير الإصدار الأساس قبل حفظ المرشح.', 409);
    if (options.parent.mode === 'mutate' && (parent.source_kind === 'builtin' || parent.origin === 'builtin')) throw new SkillError('SKILL_READ_ONLY', 'يلزم اسم عائلة جديد للاشتقاق من مهارة مدمجة.', 409);
  }
  const { slug } = loaded.contract;
  const existingFamily = await tx.selectFrom('skill_families').selectAll().where('owner_id', '=', ownerId).where('slug', '=', slug).executeTakeFirst();
  if (options.origin === 'forge' && options.parent?.mode === 'fork' && existingFamily) throw new SkillError('SKILL_SLUG_TAKEN', 'اسم العائلة الجديدة موجود بالفعل.', 409);
  if (options.origin === 'forge' && options.parent?.mode === 'mutate' && existingFamily?.id !== parent?.family_id) throw new SkillError('SKILL_FORGE_FAMILY_MISMATCH', 'الطفرة لا تطابق عائلة الأساس المثبتة.', 409);
  await tx.insertInto('skill_families').values({ id: randomUUID(), owner_id: ownerId, slug }).onConflict(conflict => conflict.columns(['owner_id', 'slug']).doNothing()).execute();
  const family = await tx.selectFrom('skill_families').selectAll().where('owner_id', '=', ownerId).where('slug', '=', slug).forUpdate().executeTakeFirstOrThrow();
  const versions = tx.selectFrom('skill_versions').where('owner_id', '=', ownerId).where('family_id', '=', family.id);
  const latest = await versions.select(['id', 'version', 'sequence', 'origin', 'content_hash']).orderBy('sequence', 'desc').executeTakeFirst();
  const first = latest && await versions.select('origin').orderBy('sequence').executeTakeFirst();
  // A forged child does not prevent later explicit local imports into their
  // original imported family; built-in/custom families remain protected.
  if (options.origin === 'local_import' && first && first.origin !== 'local_import') throw new SkillError('SKILL_SLUG_TAKEN', 'هذا المعرف محجوز لمهارة أخرى.', 409);
  let contract = loaded.contract;
  if (latest && !loaded.explicitVersion) contract = { ...contract, version: latest.version };
  let contentHash = skillContentHash(contract, loaded.files);
  const candidates = await versions.select(['id', 'origin', 'contract', 'content_hash']).where('version', '=', contract.version).limit(MAX_IMPORTED_VERSIONS_PER_OWNER).execute();
  for (const candidate of candidates) {
    if (options.origin === 'forge' && candidate.origin !== 'forge') continue;
    const parsed = SkillContractSchema.safeParse(typeof candidate.contract === 'string' ? JSON.parse(candidate.contract) : candidate.contract);
    if (!parsed.success) continue;
    const files = await tx.selectFrom('skill_files').select(['path', 'content']).where('version_id', '=', candidate.id).limit(201).execute();
    if (files.length <= 200 && skillContentMatches(parsed.data, files, candidate.content_hash) && skillContentHash(parsed.data, files) === contentHash) return { id: candidate.id as string, familyId: family.id as string, contentHash: candidate.content_hash as string, deduplicated: true };
  }
  if (latest && !loaded.explicitVersion) { contract = SkillContractSchema.parse({ ...contract, version: nextSkillVersion(latest.version) }); contentHash = skillContentHash(contract, loaded.files); }
  if (options.origin === 'forge' && contract.version !== await nextSkillFamilyVersion(tx, family.id)) throw new SkillError('SKILL_FORGE_VERSION_CHANGED', 'تغير الإصدار التالي المتاح قبل حفظ المرشح.', 409);
  if (latest && await versions.select('id').where('version', '=', contract.version).executeTakeFirst()) throw new SkillError('SKILL_VERSION_EXISTS', 'هذا الإصدار موجود بمحتوى مختلف؛ الإصدارات لا تُعدَّل.', 409);
  const count = await tx.selectFrom('skill_versions').select(eb => eb.fn.countAll<string>().as('n')).where('owner_id', '=', ownerId).where('origin', 'in', ['local_import', 'forge']).executeTakeFirstOrThrow();
  if (Number(count.n) >= MAX_IMPORTED_VERSIONS_PER_OWNER) throw new SkillError('SKILL_QUOTA_EXCEEDED', 'بلغت الحد الأقصى المشترك للإصدارات المستوردة والمولّدة.', 409);
  const id = randomUUID();
  await tx.insertInto('skill_versions').values({ id, family_id: family.id, owner_id: ownerId, version: contract.version, sequence: (latest?.sequence ?? 0) + 1, name: contract.name, description: contract.description, category: contract.category,
    level: contract.level, origin: options.origin, status: 'quarantined', status_reason: 'بانتظار الفحص.', contract: JSON.stringify(contract), content_hash: contentHash }).execute();
  await tx.insertInto('skill_files').values(loaded.files.map(file => ({ version_id: id, path: file.path, kind: file.kind, content: file.content, content_hash: sha256(file.content), size_bytes: Buffer.byteLength(file.content) }))).execute();
  await tx.insertInto('skill_sources').values({ version_id: id, kind: options.origin === 'forge' ? 'forge' : 'local_folder', locator: loaded.root, file_count: loaded.files.length, total_bytes: loaded.totalBytes }).execute();
  await options.audit(tx, ownerId, id, options.origin === 'forge' ? 'skill.forge_candidate' : 'skill.imported', { slug: contract.slug, level: contract.level, contentHash, fileCount: loaded.files.length });
  await options.rebuildGraph?.(tx, ownerId);
  return { id, familyId: family.id as string, contentHash, deduplicated: false };
}
