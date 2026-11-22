import type { Kysely } from 'kysely';
import { z } from 'zod';
import { SkillContractSchema } from '@mohassan/contracts';
import { compileInstructionContext, emptySkillContext, skillContextBudget, type CompiledSkillContext, type InstructionDocument } from './compiler.ts';
import { SkillError } from './errors.ts';
import { sha256, skillContentMatches } from './hash.ts';
import { classifySkillFile, INSPECTOR_VERSION } from './inspector.ts';
import { routeInstructionSkills, type SkillContextMetadata } from './router.ts';
import { relatedSkills } from './graph.ts';
import { createInstructionCatalogue, type InstructionCatalogue } from './catalogue.ts';
import { instructionMetadataQuery, METADATA_COLUMNS, metadataOf as metadata, metadataRows } from './metadata.ts';

const json = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value;

/** Reads metadata only, the first `limit` active instruction skills by slug. It never invokes registry.list(), seeds rows, or touches the
 * filesystem. Chat selection no longer uses this window: it reads every active skill through the catalogue snapshot (catalogue.ts). */
export async function preloadInstructionMetadata(db: Kysely<any>, ownerId: string, limit = 200): Promise<SkillContextMetadata[]> {
  const rows = await instructionMetadataQuery(db, ownerId).orderBy('f.slug').orderBy('v.id').limit(limit).execute();
  return metadataRows(rows);
}

async function loadVerifiedInstruction(db: Kysely<any>, ownerId: string, idOrSlug: string): Promise<InstructionDocument> {
  return db.transaction().setIsolationLevel('repeatable read').execute(async tx => {
    const row = await tx.selectFrom('skill_versions as v').innerJoin('skill_families as f', 'f.id', 'v.family_id')
      .select([...METADATA_COLUMNS, 'v.contract', 'v.status', 'v.level', 'f.active_version_id'])
      .where('v.owner_id', '=', ownerId).where('f.owner_id', '=', ownerId)
      .where(eb => eb.or([eb('v.id', '=', idOrSlug), eb.and([eb('f.slug', '=', idOrSlug), eb('f.active_version_id', '=', eb.ref('v.id'))])]))
      .executeTakeFirst();
    if (!row) throw new SkillError('SKILL_NOT_FOUND', 'لم يُعثر على مهارة تعليمات مفعّلة بهذا المعرّف.', 404);
    if (row.status !== 'active' || row.active_version_id !== row.id) throw new SkillError('SKILL_NOT_ACTIVE', 'المهارة غير مفعّلة.', 409);
    if (row.level !== 'instruction') throw new SkillError('SKILL_NOT_INSTRUCTION', 'تحميل السياق متاح لمهارات التعليمات فقط.', 409);
    let raw: unknown; try { raw = json(row.contract); } catch { throw new SkillError('SKILL_INTEGRITY_FAILED', 'عقد المهارة غير صالح.', 409); }
    const parsed = SkillContractSchema.safeParse(raw);
    if (!parsed.success || parsed.data.level !== 'instruction') throw new SkillError('SKILL_INTEGRITY_FAILED', 'عقد التعليمات غير صالح.', 409);
    const contract = parsed.data;
    if ((['slug', 'name', 'description', 'category', 'version'] as const).some(key => row[key] !== contract[key])) throw new SkillError('SKILL_INTEGRITY_FAILED', 'تغيرت بيانات المهارة عن العقد المفحوص.', 409);
    const files = await tx.selectFrom('skill_files').select(['path', 'kind', 'content', 'content_hash', 'size_bytes']).where('version_id', '=', row.id).orderBy('path').limit(201).execute();
    if (files.length > 200 || files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0) > 256000
      || files.some(file => classifySkillFile(file.path) !== file.kind || sha256(file.content) !== file.content_hash || Buffer.byteLength(file.content, 'utf8') !== file.size_bytes)
      || !skillContentMatches(contract, files, row.content_hash) || !files.some(file => file.path === 'SKILL.md' && file.kind === 'instructions')) {
      throw new SkillError('SKILL_INTEGRITY_FAILED', 'لا تطابق ملفات المهارة بصمتها المفحوصة.', 409);
    }
    const inspection = await tx.selectFrom('skill_inspections').select(['inspector_version', 'verdict']).where('owner_id', '=', ownerId).where('version_id', '=', row.id).where('content_hash', '=', row.content_hash).orderBy('created_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
    if (!inspection || inspection.inspector_version !== INSPECTOR_VERSION) throw new SkillError('SKILL_INSPECTION_STALE', 'يلزم فحص أمان حالي لهذه المهارة.', 409);
    if (!['pass', 'review'].includes(inspection.verdict)) throw new SkillError('SKILL_INSPECTION_FAILED', 'لم تجتز المهارة الفحص الحالي.', 409);
    return { metadata: metadata(row), files: files.map(file => ({ path: file.path, kind: file.kind, content: file.content, contentHash: file.content_hash })) };
  });
}

export function createInstructionContext(db: Kysely<any>, enabled = false, catalogue: InstructionCatalogue = createInstructionCatalogue(db)) {
  async function context(ownerId: string, goal: string, options: { loadedIds?: string[]; budgetChars?: number } = {}): Promise<CompiledSkillContext> {
    if (!enabled) return emptySkillContext();
    const budget = skillContextBudget(options.budgetChars);
    if (typeof goal !== 'string' || goal.length > 16000 || (options.loadedIds?.length ?? 0) > 12 || options.loadedIds?.some(id => typeof id !== 'string' || id.length > 100)) throw new SkillError('SKILL_CONTEXT_INPUT_INVALID', 'طلب سياق المهارات غير صالح.');
    // Every active instruction skill is a candidate (the catalogue snapshot has no alphabetical window); the router then reads the
    // highest-scoring ones. Skills that share no term with the goal score 0 and are never read.
    const candidates = await catalogue.routerCandidates(ownerId, goal);
    const lexical = routeInstructionSkills(goal, candidates);
    const loadedIds = [...new Set(options.loadedIds ?? [])].filter(id => z.uuid().safeParse(id).success);
    const loadedMetadata = loadedIds.length ? metadataRows(await instructionMetadataQuery(db, ownerId)
      .where('v.id', 'in', loadedIds).orderBy('f.slug').orderBy('v.id').limit(12).execute()) : [];
    const seeds = [...new Set([...lexical.map(skill => skill.id), ...loadedMetadata.map(skill => skill.id)])].slice(0, 12);
    const related = seeds.length ? await relatedSkills(db, ownerId, seeds, { depth: 1, limit: 12 }).catch(error => {
      // A version can disappear between discovery and graph reading. Preserve
      // the existing best-effort instruction load without exposing ownership.
      if (error instanceof SkillError && error.code === 'SKILL_NOT_FOUND') return { skillIds: [] };
      throw error;
    }) : { skillIds: [] };
    // Graph IDs can lie beyond the discovery scan, but still receive the same
    // owner, active-version and instruction-only metadata checks. Their full
    // content and inspection proof are revalidated below before any text loads.
    const relatedCandidates = related.skillIds.length ? metadataRows(await instructionMetadataQuery(db, ownerId)
      .where('v.id', 'in', related.skillIds).orderBy('f.slug').orderBy('v.id').limit(12).execute()) : [];
    // Explicitly requested IDs have their own bounded, verified path; a metadata
    // discovery limit must not silently forget a skill loaded by the owner.
    const ids = [...new Set([...(options.loadedIds ?? []), ...routeInstructionSkills(goal, candidates, 6, { relatedCandidates }).map(skill => skill.id)])];
    const documents: InstructionDocument[] = [];
    for (const id of ids) {
      if (documents.length >= 6) break;
      try { documents.push(await loadVerifiedInstruction(db, ownerId, id)); }
      catch (error) { if (!(error instanceof SkillError)) throw error; }
    }
    return compileInstructionContext(documents, goal, budget);
  }
  async function loadInstruction(ownerId: string, idOrSlug: string, budgetChars?: number): Promise<CompiledSkillContext> {
    if (!enabled) return emptySkillContext();
    if (typeof idOrSlug !== 'string' || !idOrSlug || idOrSlug.length > 100) throw new SkillError('SKILL_CONTEXT_INPUT_INVALID', 'معرّف المهارة غير صالح.');
    const budget = skillContextBudget(budgetChars);
    return compileInstructionContext([await loadVerifiedInstruction(db, ownerId, idOrSlug)], idOrSlug, budget);
  }
  return { context, loadInstruction };
}
