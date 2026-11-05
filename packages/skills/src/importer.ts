import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import { boundedText, canonicalDirectory, sourcePaths } from '@mohassan/coding/security';
import { SkillCategorySchema, SkillContractSchema, SkillImportResultSchema, SkillImportSchema, type SkillContract, type SkillImportResult } from '@mohassan/contracts';
import { SkillError } from './errors.ts';
import { parseSkillManifest } from './frontmatter.ts';
import { classifySkillFile, type InspectableFile } from './inspector.ts';
import { sha256, skillContentHash } from './hash.ts';

const CONTRACT_FILE = 'skill.contract.json';
const MAX_TOTAL_BYTES = 256_000;
const MAX_VERSIONS_PER_OWNER = 200;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+){0,7}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,5}$/;

function slugFrom(value: string, fallback: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 8).join('-').slice(0, 64).replace(/-+$/, '');
  return SLUG.test(slug) ? slug : `skill-${fallback.slice(0, 12)}`;
}
function bump(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

interface LoadedSkill { contract: SkillContract; explicitVersion: boolean; files: InspectableFile[]; totalBytes: number; root: string }

/** Reads text only. Nothing in the folder runs, and any oddity stops the import rather than being skipped. */
async function loadFolder(path: string, allowedRoots: readonly string[]): Promise<LoadedSkill> {
  const root = await canonicalDirectory(path, allowedRoots);
  const paths = await sourcePaths(root);
  if (!paths.includes('SKILL.md')) throw new SkillError('SKILL_MANIFEST_MISSING', 'لا يحتوي المجلد ملف SKILL.md.');
  const files: InspectableFile[] = [];
  let contractText: string | null = null, totalBytes = 0;
  for (const relative of paths) {
    const content = await boundedText(join(root, ...relative.split('/')));
    totalBytes += Buffer.byteLength(content, 'utf8');
    if (totalBytes > MAX_TOTAL_BYTES) throw new SkillError('SKILL_TOO_LARGE', 'تجاوزت المهارة الحجم المسموح.');
    if (relative === CONTRACT_FILE) { contractText = content; continue; }
    const kind = classifySkillFile(relative);
    if (!kind) throw new SkillError('SKILL_FILE_UNSUPPORTED', `نوع ملف غير مدعوم: ${relative}`);
    files.push({ path: relative, kind, content });
  }
  const manifest = parseSkillManifest(files.find((file) => file.path === 'SKILL.md')!.content);
  if (contractText !== null) {
    let raw: unknown;
    try { raw = JSON.parse(contractText); } catch { throw new SkillError('SKILL_CONTRACT_INVALID', 'ملف العقد ليس JSON صالحاً.'); }
    const parsed = SkillContractSchema.safeParse(raw);
    if (!parsed.success) throw new SkillError('SKILL_CONTRACT_INVALID', `عقد غير صالح: ${parsed.error.issues[0]?.message ?? 'تحقق من الحقول.'}`);
    return { contract: parsed.data, explicitVersion: true, files, totalBytes, root };
  }
  const { name, description, version, category } = manifest.fields;
  // No contract means the most restricted shape: instructions, no tools, no side effects.
  const parsed = SkillContractSchema.safeParse({
    slug: slugFrom(name ?? '', sha256(root)), name: (name ?? '').trim() || 'مهارة مستوردة', description, version: version && VERSION.test(version) ? version : '1.0.0',
    category: SkillCategorySchema.safeParse(category).data ?? 'reasoning', level: 'instruction',
  });
  if (!parsed.success) throw new SkillError('SKILL_MANIFEST_INVALID', `بيانات SKILL.md غير صالحة: ${parsed.error.issues[0]?.message ?? 'تحقق من الحقول.'}`);
  return { contract: parsed.data, explicitVersion: Boolean(version && VERSION.test(version)), files, totalBytes, root };
}

export function createSkillImporter(db: Kysely<any>, options: { allowedRoots: readonly string[]; audit: (connection: Kysely<any>, ownerId: string, targetId: string, event: string, detail?: Record<string, unknown>) => Promise<void>; view: (ownerId: string, id: string, connection: Kysely<any>) => Promise<SkillImportResult['skill']> }) {
  return async function importLocalSkill(ownerId: string, input: unknown): Promise<SkillImportResult> {
    const request = SkillImportSchema.parse(input);
    const loaded = await loadFolder(request.path, options.allowedRoots);
    const result = await db.transaction().execute(async (tx) => {
      const { slug } = loaded.contract;
      await tx.insertInto('skill_families').values({ id: randomUUID(), owner_id: ownerId, slug }).onConflict((conflict) => conflict.columns(['owner_id', 'slug']).doNothing()).execute();
      const family = await tx.selectFrom('skill_families').selectAll().where('owner_id', '=', ownerId).where('slug', '=', slug).forUpdate().executeTakeFirstOrThrow();
      const latest = await tx.selectFrom('skill_versions').select(['id', 'version', 'sequence', 'origin', 'content_hash']).where('family_id', '=', family.id).orderBy('sequence', 'desc').executeTakeFirst();
      if (latest && latest.origin !== 'local_import') throw new SkillError('SKILL_SLUG_TAKEN', 'هذا المعرف محجوز لمهارة أخرى.', 409);
      let contract = loaded.contract;
      if (latest && !loaded.explicitVersion) contract = { ...contract, version: latest.version };
      let contentHash = skillContentHash(contract, loaded.files);
      const same = await tx.selectFrom('skill_versions').select('id').where('owner_id', '=', ownerId).where('content_hash', '=', contentHash).executeTakeFirst();
      if (same) return { id: same.id as string, deduplicated: true };
      if (latest && !loaded.explicitVersion) { contract = { ...contract, version: bump(latest.version) }; contentHash = skillContentHash(contract, loaded.files); }
      if (latest && await tx.selectFrom('skill_versions').select('id').where('family_id', '=', family.id).where('version', '=', contract.version).executeTakeFirst()) {
        throw new SkillError('SKILL_VERSION_EXISTS', 'هذا الإصدار موجود بمحتوى مختلف؛ الإصدارات لا تُعدَّل.', 409);
      }
      const { n } = await tx.selectFrom('skill_versions').select((eb) => eb.fn.countAll().as('n')).where('owner_id', '=', ownerId).executeTakeFirstOrThrow();
      if (Number(n) >= MAX_VERSIONS_PER_OWNER) throw new SkillError('SKILL_QUOTA_EXCEEDED', 'بلغت الحد الأقصى لعدد الإصدارات.', 409);
      const id = randomUUID();
      await tx.insertInto('skill_versions').values({
        id, family_id: family.id, owner_id: ownerId, version: contract.version, sequence: (latest?.sequence ?? 0) + 1, name: contract.name, description: contract.description, category: contract.category,
        level: contract.level, origin: 'local_import', status: 'quarantined', status_reason: 'بانتظار الفحص.', contract: JSON.stringify(contract), content_hash: contentHash,
      }).execute();
      await tx.insertInto('skill_files').values(loaded.files.map((file) => ({ version_id: id, path: file.path, kind: file.kind, content: file.content, content_hash: sha256(file.content), size_bytes: Buffer.byteLength(file.content, 'utf8') }))).execute();
      await tx.insertInto('skill_sources').values({ version_id: id, kind: 'local_folder', locator: loaded.root, file_count: loaded.files.length, total_bytes: loaded.totalBytes }).execute();
      await options.audit(tx, ownerId, id, 'skill.imported', { slug: contract.slug, level: contract.level, contentHash, fileCount: loaded.files.length });
      return { id, deduplicated: false };
    });
    return SkillImportResultSchema.parse({ skill: await options.view(ownerId, result.id, db), deduplicated: result.deduplicated });
  };
}
