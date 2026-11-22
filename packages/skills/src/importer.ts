import { join } from 'node:path';
import type { Kysely } from 'kysely';
import { boundedText, canonicalDirectory, sourcePaths } from '@mohassan/coding/security';
import { SkillCategorySchema, SkillContractSchema, SkillImportResultSchema, SkillImportSchema, type SkillImportResult } from '@mohassan/contracts';
import { SkillError } from './errors.ts';
import { parseSkillManifest } from './frontmatter.ts';
import { classifySkillFile, type InspectableFile } from './inspector.ts';
import { sha256 } from './hash.ts';
import { storeImmutableSkill, MAX_IMPORTED_TOTAL_BYTES, type ImmutableSkillSource } from './import-store.ts';

const CONTRACT_FILE = 'skill.contract.json';
const MAX_TOTAL_BYTES = MAX_IMPORTED_TOTAL_BYTES;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+){0,7}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,5}$/;

function slugFrom(value: string, fallback: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 8).join('-').slice(0, 64).replace(/-+$/, '');
  return SLUG.test(slug) ? slug : `skill-${fallback.slice(0, 12)}`;
}

export interface SkillSourceEntry { path: string; content: string }
export interface SkillSourceOrigin {
  /** Where the files came from; recorded as the source locator and used only as the slug fallback seed. */
  root: string;
  /** A remote folder name: becomes the slug when there is no contract, and must equal the contract's slug when there is one. */
  defaultSlug?: string;
}

/** Pure: turns already-read text files into an immutable skill source. Shared by the local folder reader and the GitHub sync. */
export function buildSkillSource(entries: readonly SkillSourceEntry[], origin: SkillSourceOrigin): ImmutableSkillSource {
  const files: InspectableFile[] = [];
  let contractText: string | null = null, totalBytes = 0;
  for (const entry of entries) {
    totalBytes += Buffer.byteLength(entry.content, 'utf8');
    if (entry.path === CONTRACT_FILE) { contractText = entry.content; continue; }
    const kind = classifySkillFile(entry.path);
    if (!kind) throw new SkillError('SKILL_FILE_UNSUPPORTED', `نوع ملف غير مدعوم: ${entry.path}`);
    files.push({ path: entry.path, kind, content: entry.content });
  }
  if (totalBytes > MAX_TOTAL_BYTES) throw new SkillError('SKILL_TOO_LARGE', 'تجاوزت المهارة الحجم المسموح.');
  const manifestFile = files.find((file) => file.path === 'SKILL.md');
  if (!manifestFile) throw new SkillError('SKILL_MANIFEST_MISSING', 'لا يحتوي المجلد ملف SKILL.md.');
  const manifest = parseSkillManifest(manifestFile.content);
  if (contractText !== null) {
    let raw: unknown;
    try { raw = JSON.parse(contractText); } catch { throw new SkillError('SKILL_CONTRACT_INVALID', 'ملف العقد ليس JSON صالحاً.'); }
    const parsed = SkillContractSchema.safeParse(raw);
    if (!parsed.success) throw new SkillError('SKILL_CONTRACT_INVALID', `عقد غير صالح: ${parsed.error.issues[0]?.message ?? 'تحقق من الحقول.'}`);
    if (origin.defaultSlug !== undefined && parsed.data.slug !== origin.defaultSlug) throw new SkillError('SKILL_REMOTE_SLUG_MISMATCH', 'اسم مجلد المهارة لا يطابق المعرّف في العقد.');
    return { contract: parsed.data, explicitVersion: true, files, totalBytes, root: origin.root };
  }
  const { name, description, version, category } = manifest.fields;
  // No contract means the most restricted shape: instructions, no tools, no side effects.
  const parsed = SkillContractSchema.safeParse({
    slug: origin.defaultSlug ?? slugFrom(name ?? '', sha256(origin.root)), name: (name ?? '').trim() || 'مهارة مستوردة', description, version: version && VERSION.test(version) ? version : '1.0.0',
    category: SkillCategorySchema.safeParse(category).data ?? 'reasoning', level: 'instruction',
  });
  if (!parsed.success) throw new SkillError('SKILL_MANIFEST_INVALID', `بيانات SKILL.md غير صالحة: ${parsed.error.issues[0]?.message ?? 'تحقق من الحقول.'}`);
  return { contract: parsed.data, explicitVersion: Boolean(version && VERSION.test(version)), files, totalBytes, root: origin.root };
}

/** Reads text only. Nothing in the folder runs, and any oddity stops the import rather than being skipped. */
async function loadFolder(path: string, allowedRoots: readonly string[]): Promise<ImmutableSkillSource> {
  const root = await canonicalDirectory(path, allowedRoots);
  const paths = await sourcePaths(root);
  if (!paths.includes('SKILL.md')) throw new SkillError('SKILL_MANIFEST_MISSING', 'لا يحتوي المجلد ملف SKILL.md.');
  const entries: SkillSourceEntry[] = [];
  let totalBytes = 0;
  for (const relative of paths) {
    const content = await boundedText(join(root, ...relative.split('/')));
    totalBytes += Buffer.byteLength(content, 'utf8');
    if (totalBytes > MAX_TOTAL_BYTES) throw new SkillError('SKILL_TOO_LARGE', 'تجاوزت المهارة الحجم المسموح.');
    entries.push({ path: relative, content });
  }
  return buildSkillSource(entries, { root });
}

export function createSkillImporter(db: Kysely<any>, options: { allowedRoots: readonly string[]; audit: (connection: Kysely<any>, ownerId: string, targetId: string, event: string, detail?: Record<string, unknown>) => Promise<void>; view: (ownerId: string, id: string, connection: Kysely<any>) => Promise<SkillImportResult['skill']>; rebuildGraph?: (tx: Kysely<any>, ownerId: string) => Promise<void> }) {
  return async function importLocalSkill(ownerId: string, input: unknown): Promise<SkillImportResult> {
    const request = SkillImportSchema.parse(input);
    const loaded = await loadFolder(request.path, options.allowedRoots);
    const result = await db.transaction().execute(tx => storeImmutableSkill(tx, ownerId, loaded, { ...options, origin: 'local_import' }));
    return SkillImportResultSchema.parse({ skill: await options.view(ownerId, result.id, db), deduplicated: result.deduplicated });
  };
}
