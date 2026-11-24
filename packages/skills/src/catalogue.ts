import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import {
  SkillCatalogueFactsSchema, SkillCatalogueQuerySchema, SkillCatalogueResultSchema, SkillContractSchema, Slug,
  type SkillCatalogueFacts, type SkillCatalogueItem, type SkillCatalogueResult, type SkillCompatibility, type SkillContract, type SkillLicenceKind,
} from '@mohassan/contracts';
import { compileInstructionContext, DEFAULT_SKILL_CONTEXT_CHARS } from './compiler.ts';
import { SkillError } from './errors.ts';
import { parseSkillManifest } from './frontmatter.ts';
import { sha256 } from './hash.ts';
import { INSPECTOR_VERSION, type InspectableFile } from './inspector.ts';
import { instructionMetadataQuery, metadataRows } from './metadata.ts';
import { rankInstructionCandidates, rarityWeights, routerCandidateTerms, routerTermsOf, skillTerms, type RouterTermWeight, type SkillContextMetadata } from './router.ts';

/* ------------------------------------------------------------------ term index (pure) */

/** An inverted index over pre-tokenised documents: which documents hold a term, and in how many it occurs. */
export interface TermIndex { readonly size: number; frequency(term: string): number; shortlist(terms: Iterable<string>): number[] }
export function createTermIndex(documents: readonly (readonly string[])[]): TermIndex {
  const postings = new Map<string, number[]>();
  documents.forEach((terms, index) => {
    for (const term of new Set(terms)) { const list = postings.get(term); if (list) list.push(index); else postings.set(term, [index]); }
  });
  return {
    size: documents.length,
    frequency: term => postings.get(term)?.length ?? 0,
    // Ascending positions keep the documents' own order, so ties break exactly as they would over the full list.
    shortlist(terms) {
      const hit = new Set<number>();
      for (const term of terms) for (const index of postings.get(term) ?? []) hit.add(index);
      return [...hit].sort((a, b) => a - b);
    },
  };
}

/** The router's own terms per skill (slug, name and description, each read as the router reads it). */
export const routerIndex = (entries: readonly SkillContextMetadata[]): TermIndex => createTermIndex(entries.map(routerTermsOf));

/* ------------------------------------------------------------------ active instruction snapshot */

/** Active instruction skills one owner may have as candidates. Above it the rest are not candidates, and that is logged, never silent. */
export const MAX_CATALOGUE_ACTIVE = 20_000;
const MAX_CACHED_OWNERS = 64;

export interface InstructionSnapshot {
  readonly fingerprint: string;
  /** Every active instruction skill of the owner, by slug: no alphabetical window. */
  readonly entries: readonly SkillContextMetadata[];
  readonly truncated: boolean;
  /** One derived structure (an index) per key, built once for this snapshot. */
  memo<T>(key: string, build: (entries: readonly SkillContextMetadata[]) => T): T;
}

/** Changes whenever an instruction skill of the owner is activated, replaced, rolled back, revoked or removed. */
async function activeFingerprint(db: Kysely<any>, ownerId: string): Promise<string> {
  const row = await db.selectFrom('skill_versions as v').innerJoin('skill_families as f', 'f.id', 'v.family_id')
    .select([sql<string>`count(*)`.as('n'), sql<string>`coalesce(sum(f.revision), 0)`.as('fr'), sql<string>`coalesce(sum(v.revision), 0)`.as('vr'), sql<unknown>`max(v.updated_at)`.as('u')])
    .where('v.owner_id', '=', ownerId).where('f.owner_id', '=', ownerId).where('v.status', '=', 'active').where('v.level', '=', 'instruction')
    .whereRef('f.active_version_id', '=', 'v.id').executeTakeFirstOrThrow();
  return `${row.n}:${row.fr}:${row.vr}:${row.u ? new Date(row.u as string).getTime() : 0}`;
}

/**
 * The selection side of the catalogue. Every message reads one aggregate row; the metadata of all active
 * instruction skills is read again only when that fingerprint changes, and each index over it is built once.
 */
export function createInstructionCatalogue(db: Kysely<any>) {
  const cache = new Map<string, InstructionSnapshot>(), loading = new Map<string, Promise<InstructionSnapshot>>();
  async function load(ownerId: string, fingerprint: string): Promise<InstructionSnapshot> {
    const rows = await instructionMetadataQuery(db, ownerId).orderBy('f.slug').orderBy('v.id').limit(MAX_CATALOGUE_ACTIVE + 1).execute();
    const truncated = rows.length > MAX_CATALOGUE_ACTIVE;
    if (truncated) console.error(JSON.stringify({ level: 'warn', event: 'skill_catalogue_truncated', limit: MAX_CATALOGUE_ACTIVE }));
    const entries = Object.freeze(metadataRows(rows.slice(0, MAX_CATALOGUE_ACTIVE)));
    const memos = new Map<string, unknown>();
    return Object.freeze({
      fingerprint, entries, truncated,
      memo<T>(key: string, build: (list: readonly SkillContextMetadata[]) => T): T {
        if (!memos.has(key)) memos.set(key, build(entries));
        return memos.get(key) as T;
      },
    });
  }
  async function snapshot(ownerId: string): Promise<InstructionSnapshot> {
    const fingerprint = await activeFingerprint(db, ownerId);
    const cached = cache.get(ownerId);
    if (cached?.fingerprint === fingerprint) { cache.delete(ownerId); cache.set(ownerId, cached); return cached; }
    const key = `${ownerId}\u0000${fingerprint}`;
    let pending = loading.get(key);
    if (!pending) { pending = load(ownerId, fingerprint).finally(() => loading.delete(key)); loading.set(key, pending); }
    const fresh = await pending;
    cache.delete(ownerId); cache.set(ownerId, fresh);
    while (cache.size > MAX_CACHED_OWNERS) cache.delete(cache.keys().next().value!);
    return fresh;
  }
  /** The router's term weights over every active instruction skill of the owner, built once per snapshot. */
  const weightsOf = (current: InstructionSnapshot): RouterTermWeight => current.memo('router-weight', () => rarityWeights(current.memo('router', routerIndex)));
  /** What the router would rank over every active skill, using indexed terms to narrow the candidate list. */
  async function routerCandidates(ownerId: string, goal: string, limit?: number): Promise<SkillContextMetadata[]> {
    const stems = routerCandidateTerms(goal);
    if (!stems.length) return [];
    const current = await snapshot(ownerId);
    const index = current.memo('router', routerIndex);
    return rankInstructionCandidates(goal, index.shortlist(stems).map(position => current.entries[position]), limit, { weight: weightsOf(current) });
  }
  /** The weights routerCandidates ranked with: pass them to routeInstructionSkills so both read every active skill's frequencies. */
  async function routerWeights(ownerId: string): Promise<RouterTermWeight> {
    return weightsOf(await snapshot(ownerId));
  }
  return { snapshot, routerCandidates, routerWeights, forget: (ownerId?: string) => { if (ownerId) cache.delete(ownerId); else cache.clear(); } };
}
export type InstructionCatalogue = ReturnType<typeof createInstructionCatalogue>;

/* ------------------------------------------------------------------ facts per version (pure) */

/** Raise when the derivation rules change: rows of an older rule are read again by the backfill. */
export const CATALOGUE_FACTS_VERSION = 'catalogue-v1';
/** The body length the library guidance asks for (skills-library/README.md). Two bodies this long do NOT fit together whole in the
 * default 4,000-character context: measured in scripts/skills-catalogue/audit.ts, the JSON envelope adds the difference. */
export const SKILL_BODY_GUIDANCE_CHARS = 1800;

const PERMISSIVE = new Set(['apache-2.0', 'mit', 'bsd-2-clause', 'bsd-3-clause', 'isc', 'cc-by-4.0', 'mit-0', '0bsd', 'unlicense', 'cc0-1.0']);
const RESTRICTED = /proprietary|all rights reserved|source[- ]available|non[- ]commercial|\bnc\b|no derivatives|\bnd\b/i;
const UPSTREAM = /^([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100})@([a-f0-9]{40}):([^\s]{1,240})$/;
const RELATIVE_FILE = /(?:^|[\s(`'"])((?:references|reference|examples|assets|scripts|templates|resources)\/[\w./-]+\.[A-Za-z0-9]{1,8})/g;
const CONNECTOR = /\bmcp__\w+|\b(?:use|call|open|query) the [\w .-]{1,40} (?:MCP|connector|plugin|app)\b/i;

/** Where a version came from; `package` is the bulk importer's package id, used when the front matter names none. */
export interface CatalogueSource { kind: string | null; locator: string | null; package?: string | null }

export function licenceKind(licence: string, thirdParty: boolean): SkillLicenceKind {
  const value = licence.trim();
  if (RESTRICTED.test(value)) return 'restricted';
  if (value.toLowerCase().split(/\s+(?:and|or)\s+/).every(part => PERMISSIVE.has(part.replace(/[()]/g, '').trim()))) return 'permissive';
  return thirdParty ? 'unknown' : 'owner';
}
function language(text: string): 'ar' | 'en' | 'mixed' {
  const arabic = text.match(/\p{Script=Arabic}/gu)?.length ?? 0, latin = text.match(/[A-Za-z]/gu)?.length ?? 0;
  if (!arabic && !latin) return 'ar';
  const share = arabic / (arabic + latin);
  return share >= 0.6 ? 'ar' : share <= 0.4 ? 'en' : 'mixed';
}
const list = (value: string | undefined, max: number, each: number) => (value ?? '').split(/[,،]/u).map(item => item.trim()).filter(item => item && item.length <= each).slice(0, max);
function packageOf(fields: Record<string, string>, source: CatalogueSource): string {
  const declared = fields.package?.trim();
  if (declared && declared.length <= 120) return declared;
  if (source.package && source.package.length <= 120) return source.package;
  if (source.kind === 'github' && source.locator) { const match = /^github:([^@]+)@/.exec(source.locator); if (match) return `github:${match[1]}`; }
  return source.kind ?? 'unknown';
}

/**
 * What the catalogue records for one version, from its own verified files. The catalogue keys of SKILL.md
 * (language, workflow, variant-of, keywords, package, license, source, source-sha256, attribution, requires)
 * live in the front matter, so they are never part of the body that reaches a prompt or an answer.
 */
export function deriveCatalogueFacts(contract: SkillContract, files: readonly Pick<InspectableFile, 'path' | 'kind' | 'content'>[], source: CatalogueSource): SkillCatalogueFacts {
  const main = files.find(file => file.path === 'SKILL.md');
  const manifest = main ? parseSkillManifest(main.content) : { fields: {} as Record<string, string>, body: '' };
  const { fields, body } = manifest;
  const reasons: string[] = [];
  const upstreamMatch = fields.source ? UPSTREAM.exec(fields.source.trim()) : null;
  if (fields.source && !upstreamMatch) reasons.push('source_unreadable');
  const sourceHash = fields['source-sha256']?.trim();
  const upstream = upstreamMatch ? { repo: upstreamMatch[1], revision: upstreamMatch[2], path: upstreamMatch[3], sha256: sourceHash && /^[a-f0-9]{64}$/.test(sourceHash) ? sourceHash : null } : null;
  const licence = (fields.license ?? fields.licence ?? '').trim().slice(0, 64) || 'unspecified';
  const kind = licenceKind(licence, Boolean(fields.source));
  if (fields.source && kind !== 'permissive') reasons.push(`licence_${kind}`);
  const declaredLanguage = fields.language?.trim();
  const lang = declaredLanguage === 'ar' || declaredLanguage === 'en' ? declaredLanguage : language(body);
  const workflowField = fields.workflow?.trim();
  const workflow = workflowField && Slug.safeParse(workflowField).success ? workflowField : contract.slug.replace(/-(?:ar|en)$/, '') || contract.slug;
  const variantField = fields['variant-of']?.trim();
  const variantOf = variantField && Slug.safeParse(variantField).success && variantField !== contract.slug ? variantField : null;
  const requires = list(fields.requires, 12, 40);

  let compatibility: SkillCompatibility = 'compatible';
  const lower = (next: SkillCompatibility) => {
    const rank: SkillCompatibility[] = ['compatible', 'partial', 'requires_resources', 'requires_tools', 'requires_execution'];
    if (rank.indexOf(next) > rank.indexOf(compatibility)) compatibility = next;
  };
  if (contract.level !== 'instruction') { lower('requires_execution'); reasons.push(`level_${contract.level}`); }
  if (requires.length) { lower('requires_tools'); reasons.push(...requires.map(item => `requires:${item}`)); }
  const scripts = files.filter(file => file.kind === 'script');
  const referenced = scripts.filter(file => body.includes(file.path) || body.includes(file.path.split('/').pop()!));
  if (referenced.length) { lower('requires_resources'); reasons.push(...referenced.slice(0, 4).map(file => `script_required:${file.path}`)); }
  else if (scripts.length) reasons.push('scripts_stored_not_run');
  const present = new Set(files.map(file => file.path));
  const missing = [...new Set([...body.matchAll(RELATIVE_FILE)].map(match => match[1].replace(/[.,;:)]+$/, '')))].filter(path => !present.has(path));
  if (missing.length) { lower('partial'); reasons.push(...missing.slice(0, 4).map(path => `missing_file:${path}`)); }
  if (CONNECTOR.test(body)) reasons.push('mentions_connector');
  // Whether the body alone survives the default context budget whole: measured with the real compiler, not estimated.
  if (body) {
    const alone = compileInstructionContext([{ metadata: { id: '00000000-0000-4000-8000-000000000000', slug: contract.slug, name: contract.name, description: contract.description, category: contract.category, version: contract.version, contentHash: '0'.repeat(64) },
      files: [{ path: 'SKILL.md', kind: 'instructions', content: main!.content, contentHash: '0'.repeat(64) }] }], '', DEFAULT_SKILL_CONTEXT_CHARS);
    if (alone.sources.some(item => item.truncated)) { lower('partial'); reasons.push('body_exceeds_context'); }
    else if (body.length > SKILL_BODY_GUIDANCE_CHARS) reasons.push('body_over_guidance');
  }
  const attribution = fields.attribution?.trim().slice(0, 300) || null;
  if (fields.source && !attribution) reasons.push('attribution_missing');
  return SkillCatalogueFactsSchema.parse({
    language: lang, workflow, variantOf, keywords: list(fields.keywords, 24, 40), package: packageOf(fields, source), upstream, licence, licenceKind: kind,
    attribution, requires, compatibility, reasons: [...new Set(reasons.map(reason => reason.slice(0, 120)))].slice(0, 24), bodyChars: body.length,
  });
}

/* ------------------------------------------------------------------ persistence */

/** One row per version, written in the import transaction; identical content keeps its row. Declared variants become relations. */
export async function storeCatalogueFacts(tx: Kysely<any>, ownerId: string, versionId: string, slug: string, facts: SkillCatalogueFacts): Promise<void> {
  await tx.insertInto('skill_catalogue').values({
    version_id: versionId, owner_id: ownerId, facts: JSON.stringify(facts), facts_version: CATALOGUE_FACTS_VERSION,
    language: facts.language, workflow: facts.workflow, package: facts.package, compatibility: facts.compatibility, licence: facts.licence,
  }).onConflict(conflict => conflict.column('version_id').doNothing()).execute();
  if (facts.variantOf) {
    await tx.insertInto('skill_catalogue_relations').values({ owner_id: ownerId, from_slug: slug, to_slug: facts.variantOf, relation: 'variant_of', signal: 'declared', score: null })
      .onConflict(conflict => conflict.columns(['owner_id', 'from_slug', 'to_slug', 'relation']).doNothing()).execute();
  }
}

const json = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);

/** Reads facts for versions stored before the catalogue existed (or under an older rule), a bounded number per call. */
export async function backfillCatalogue(db: Kysely<any>, ownerId: string, limit = 500): Promise<{ filled: number; pending: number }> {
  const missing = () => db.selectFrom('skill_versions as v').leftJoin('skill_catalogue as c', 'c.version_id', 'v.id')
    .where('v.owner_id', '=', ownerId).where(eb => eb.or([eb('c.version_id', 'is', null), eb('c.facts_version', '<>', CATALOGUE_FACTS_VERSION)]));
  const rows = await missing().innerJoin('skill_families as f', 'f.id', 'v.family_id').leftJoin('skill_sources as s', 's.version_id', 'v.id')
    .select(['v.id', 'v.contract', 'f.slug', 's.kind', 's.locator']).orderBy('v.created_at').orderBy('v.id').limit(Math.max(1, Math.min(limit, 2000))).execute();
  let filled = 0;
  for (const row of rows) {
    const parsed = SkillContractSchema.safeParse(json(row.contract));
    if (!parsed.success) continue;
    const files = await db.selectFrom('skill_files').select(['path', 'kind', 'content']).where('version_id', '=', row.id).limit(201).execute();
    let facts: SkillCatalogueFacts;
    try { facts = deriveCatalogueFacts(parsed.data, files as InspectableFile[], { kind: row.kind ?? null, locator: row.locator ?? null }); }
    catch { continue; }
    await db.transaction().execute(async tx => {
      await tx.deleteFrom('skill_catalogue').where('version_id', '=', row.id).where('facts_version', '<>', CATALOGUE_FACTS_VERSION).execute();
      await storeCatalogueFacts(tx, ownerId, row.id, row.slug, facts);
    });
    filled++;
  }
  const pending = Number((await missing().select(eb => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow()).n);
  return { filled, pending };
}

/**
 * Behavioural evidence: task tests that ran against exactly this content. A version whose content hash differs
 * (a changed upstream skill is a new version) has no evidence until its tests run again.
 */
export async function recordCatalogueEvidence(db: Kysely<any>, ownerId: string, input: { versionId: string; contentHash: string; suite: string; suiteHash: string; passed: number; total: number; detail: unknown }): Promise<{ id: string }> {
  if (!Number.isSafeInteger(input.total) || input.total < 1 || !Number.isSafeInteger(input.passed) || input.passed < 0 || input.passed > input.total) throw new SkillError('SKILL_EVIDENCE_INVALID', 'نتيجة اختبار غير صالحة.');
  if (!/^[a-f0-9]{64}$/.test(input.suiteHash) || !input.suite || input.suite.length > 120) throw new SkillError('SKILL_EVIDENCE_INVALID', 'مجموعة اختبار غير صالحة.');
  const version = await db.selectFrom('skill_versions').select(['content_hash']).where('owner_id', '=', ownerId).where('id', '=', input.versionId).executeTakeFirst();
  if (!version) throw new SkillError('SKILL_NOT_FOUND', 'لم يُعثر على المهارة.', 404);
  if (version.content_hash !== input.contentHash) throw new SkillError('SKILL_EVIDENCE_STALE', 'تغير محتوى المهارة؛ يلزم تشغيل اختباراتها من جديد.', 409);
  const id = randomUUID();
  const detail = JSON.stringify(input.detail ?? {});
  await db.insertInto('skill_catalogue_evidence').values({ id, owner_id: ownerId, version_id: input.versionId, content_hash: input.contentHash, kind: 'behavioural', suite: input.suite,
    suite_hash: input.suiteHash, passed: input.passed, total: input.total, detail: detail.length <= 64000 ? detail : JSON.stringify({ truncated: true }) }).execute();
  return { id };
}

/** Term sets for similarity: name, description and keywords. Similarity is a review signal; nothing is merged or renamed. */
const similarityTerms = (name: string, description: string, keywords: readonly string[]) => new Set(skillTerms(`${name} ${description} ${keywords.join(' ')}`));
export const SIMILARITY_REVIEW_THRESHOLD = 0.5;

/** Jaccard overlap of each given slug against every other family of the owner, kept when at least the review threshold. */
export async function recordSimilaritySignals(db: Kysely<any>, ownerId: string, slugs: readonly string[]): Promise<number> {
  if (!slugs.length) return 0;
  const rows = await familyRows(db, ownerId);
  const docs = rows.map(row => { const facts = parseFacts(row.facts); return { slug: row.slug as string, terms: similarityTerms(row.name, row.description, facts?.keywords ?? []) }; });
  const index = createTermIndex(docs.map(doc => [...doc.terms]));
  const wanted = new Set(slugs);
  const signals: { from: string; to: string; score: number }[] = [];
  docs.forEach((doc, position) => {
    if (!wanted.has(doc.slug) || !doc.terms.size) return;
    const scored = index.shortlist(doc.terms).filter(other => other !== position).map(other => {
      const shared = [...doc.terms].filter(term => docs[other].terms.has(term)).length;
      return { to: docs[other].slug, score: shared / (doc.terms.size + docs[other].terms.size - shared) };
    }).filter(item => item.score >= SIMILARITY_REVIEW_THRESHOLD).sort((a, b) => b.score - a.score || (a.to < b.to ? -1 : 1)).slice(0, 3);
    for (const item of scored) signals.push({ from: doc.slug, to: item.to, score: Math.round(item.score * 1000) / 1000 });
  });
  for (const signal of signals) {
    await db.insertInto('skill_catalogue_relations').values({ owner_id: ownerId, from_slug: signal.from, to_slug: signal.to, relation: 'similar', signal: 'review', score: signal.score })
      .onConflict(conflict => conflict.columns(['owner_id', 'from_slug', 'to_slug', 'relation']).doUpdateSet({ score: signal.score })).execute();
  }
  return signals.length;
}

/* ------------------------------------------------------------------ search */

function parseFacts(raw: unknown): SkillCatalogueFacts | null {
  if (raw === null || raw === undefined) return null;
  try { const parsed = SkillCatalogueFactsSchema.safeParse(json(raw)); return parsed.success ? parsed.data : null; } catch { return null; }
}
const iso = (value: unknown) => new Date(value as string | Date).toISOString();

/** One row per family: its active version, or else its newest; with facts, the newest current inspection and the newest evidence for that content. */
async function familyRows(db: Kysely<any>, ownerId: string): Promise<any[]> {
  const result = await sql<any>`
    SELECT DISTINCT ON (f.id) f.id AS family_id, f.slug, f.active_version_id, v.id, v.version, v.name, v.description, v.category, v.level, v.origin, v.status, v.content_hash,
      c.facts, i.verdict, i.inspector_version, e.suite, e.passed, e.total, e.created_at AS evidence_at
    FROM skill_families f
    JOIN skill_versions v ON v.family_id = f.id AND v.owner_id = f.owner_id
    LEFT JOIN skill_catalogue c ON c.version_id = v.id AND c.facts_version = ${CATALOGUE_FACTS_VERSION}
    LEFT JOIN LATERAL (SELECT verdict, inspector_version FROM skill_inspections WHERE version_id = v.id AND content_hash = v.content_hash ORDER BY created_at DESC, id DESC LIMIT 1) i ON true
    LEFT JOIN LATERAL (SELECT suite, passed, total, created_at FROM skill_catalogue_evidence WHERE version_id = v.id AND content_hash = v.content_hash ORDER BY created_at DESC, id DESC LIMIT 1) e ON true
    WHERE f.owner_id = ${ownerId}
    ORDER BY f.id, (v.id = f.active_version_id) DESC, v.sequence DESC`.execute(db);
  return result.rows;
}

interface Listing { fingerprint: string; items: SkillCatalogueItem[]; versions: number; index: TermIndex; texts: string[][]; titles: Set<string>[] }
const listings = new Map<string, Listing>();
const MAX_LISTINGS = 16;

async function allFingerprint(db: Kysely<any>, ownerId: string): Promise<string> {
  const row = await sql<any>`
    SELECT (SELECT count(*) FROM skill_versions WHERE owner_id = ${ownerId}) AS v, (SELECT coalesce(sum(revision), 0) FROM skill_versions WHERE owner_id = ${ownerId}) AS vr,
      (SELECT coalesce(sum(revision), 0) FROM skill_families WHERE owner_id = ${ownerId}) AS fr, (SELECT max(updated_at) FROM skill_versions WHERE owner_id = ${ownerId}) AS u,
      (SELECT count(*) FROM skill_catalogue WHERE owner_id = ${ownerId}) AS c, (SELECT count(*) FROM skill_catalogue_evidence WHERE owner_id = ${ownerId}) AS e,
      (SELECT count(*) FROM skill_inspections WHERE owner_id = ${ownerId}) AS i, (SELECT count(*) FROM skill_catalogue_relations WHERE owner_id = ${ownerId}) AS r`.execute(db);
  const value = row.rows[0];
  return [value.v, value.vr, value.fr, value.u ? new Date(value.u).getTime() : 0, value.c, value.e, value.i, value.r].join(':');
}

async function listing(db: Kysely<any>, ownerId: string): Promise<Listing> {
  const fingerprint = await allFingerprint(db, ownerId);
  const cached = listings.get(ownerId);
  if (cached?.fingerprint === fingerprint) return cached;
  const [rows, relations, versions] = await Promise.all([
    familyRows(db, ownerId),
    db.selectFrom('skill_catalogue_relations').select(['from_slug', 'to_slug', 'relation', 'signal', 'score']).where('owner_id', '=', ownerId).limit(50_000).execute(),
    db.selectFrom('skill_versions').select(eb => eb.fn.countAll<string>().as('n')).where('owner_id', '=', ownerId).executeTakeFirstOrThrow(),
  ]);
  const facts = new Map(rows.map(row => [row.slug as string, parseFacts(row.facts)]));
  const byWorkflow = new Map<string, string[]>();
  for (const [slug, fact] of facts) if (fact) byWorkflow.set(fact.workflow, [...(byWorkflow.get(fact.workflow) ?? []), slug]);
  const related = new Map<string, SkillCatalogueItem['relations']>();
  const add = (slug: string, relation: SkillCatalogueItem['relations'][number]) => { const list = related.get(slug) ?? []; if (list.length < 24 && !list.some(item => item.slug === relation.slug && item.relation === relation.relation)) list.push(relation); related.set(slug, list); };
  for (const relation of relations) {
    if (relation.relation === 'variant_of') {
      // A declared variant is a language variant only when the two languages really differ; otherwise it is the same workflow.
      const kind = facts.get(relation.from_slug)?.language && facts.get(relation.to_slug)?.language && facts.get(relation.from_slug)!.language !== facts.get(relation.to_slug)!.language ? 'language_variant' : 'same_workflow';
      add(relation.from_slug, { slug: relation.to_slug, relation: kind, signal: 'declared', score: null });
      add(relation.to_slug, { slug: relation.from_slug, relation: kind, signal: 'declared', score: null });
    } else if (relation.relation === 'similar') {
      const score = relation.score === null ? null : Math.max(0, Math.min(1, Number(relation.score)));
      add(relation.from_slug, { slug: relation.to_slug, relation: 'similar', signal: 'review', score });
      add(relation.to_slug, { slug: relation.from_slug, relation: 'similar', signal: 'review', score });
    }
  }
  for (const members of byWorkflow.values()) {
    if (members.length < 2) continue;
    for (const slug of members) for (const other of members) if (other !== slug) {
      const kind = facts.get(slug)!.language !== facts.get(other)!.language ? 'language_variant' : 'same_workflow';
      add(slug, { slug: other, relation: kind, signal: 'derived', score: null });
    }
  }
  const items: SkillCatalogueItem[] = rows.map(row => ({
    familyId: row.family_id, versionId: row.id, slug: row.slug, name: row.name, description: row.description, category: row.category, level: row.level, origin: row.origin,
    status: row.status, active: row.active_version_id === row.id, version: row.version, contentHash: row.content_hash, facts: facts.get(row.slug) ?? null,
    structural: row.verdict ? { verdict: row.verdict, current: row.inspector_version === INSPECTOR_VERSION } : null,
    behavioural: row.total ? { suite: row.suite, passed: Number(row.passed), total: Number(row.total), at: iso(row.evidence_at) } : null,
    relations: related.get(row.slug) ?? [],
  }));
  items.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const texts = items.map(item => skillTerms(`${item.slug.replace(/-/g, ' ')} ${item.name} ${item.description} ${(item.facts?.keywords ?? []).join(' ')}`));
  const titles = items.map(item => new Set([...skillTerms(item.slug.replace(/-/g, ' ')), ...skillTerms(item.name)]));
  const fresh: Listing = { fingerprint, items, versions: Number(versions.n), index: createTermIndex(texts), texts, titles };
  listings.delete(ownerId); listings.set(ownerId, fresh);
  while (listings.size > MAX_LISTINGS) listings.delete(listings.keys().next().value!);
  return fresh;
}

const structurallyValid = (item: SkillCatalogueItem) => Boolean(item.structural?.current && (item.structural.verdict === 'pass' || item.structural.verdict === 'review'));
const tested = (item: SkillCatalogueItem) => Boolean(item.behavioural && item.behavioural.passed === item.behavioural.total);

/**
 * Searches every skill family of the owner by task words (Arabic or English), category, language, compatibility,
 * activation, package, workflow, evidence and licence. Nothing here enters a prompt. A query with no match returns
 * no items and the unfiltered counts, so the owner still sees what the catalogue holds.
 */
export async function searchCatalogue(db: Kysely<any>, ownerId: string, input: unknown): Promise<SkillCatalogueResult> {
  const query = SkillCatalogueQuerySchema.parse(input ?? {});
  const { pending } = await backfillCatalogue(db, ownerId, 500);
  const current = await listing(db, ownerId);
  let positions = current.items.map((_, position) => position);
  const terms = query.q ? skillTerms(query.q) : [];
  const score = new Map<number, number>();
  if (query.q) {
    const needle = query.q.toLocaleLowerCase('ar');
    const hits = new Set(terms.length ? current.index.shortlist(terms) : []);
    // An exact slug or a name that contains the whole query also matches, even when it has no separate term.
    current.items.forEach((item, position) => { if (item.slug === needle || item.name.toLocaleLowerCase('ar').includes(needle)) hits.add(position); });
    positions = positions.filter(position => hits.has(position));
    // Rare words weigh more than common ones, and a word in the name or slug twice a word in the description,
    // so a skill named for the task outranks the many that only mention its words (measured at 10,000 entries).
    const weight = (term: string) => Math.log(1 + current.index.size / Math.max(1, current.index.frequency(term)));
    for (const position of positions) {
      const own = new Set(current.texts[position]), title = current.titles[position];
      score.set(position, terms.reduce((sum, term) => sum + (own.has(term) ? weight(term) * (title.has(term) ? 2 : 1) : 0), 0) + (current.items[position].slug === needle ? 1000 : 0));
    }
  }
  const filtered = positions.filter(position => {
    const item = current.items[position], facts = item.facts;
    if (query.category && item.category !== query.category) return false;
    if (query.language && facts?.language !== query.language) return false;
    if (query.compatibility && facts?.compatibility !== query.compatibility) return false;
    if (query.package && facts?.package !== query.package) return false;
    if (query.workflow && facts?.workflow !== query.workflow) return false;
    if (query.licence && facts?.licenceKind !== query.licence) return false;
    if (query.tested !== undefined && tested(item) !== query.tested) return false;
    if (query.status === 'active' && !item.active) return false;
    if (query.status === 'inactive' && item.active) return false;
    if (query.status && query.status !== 'active' && query.status !== 'inactive' && item.status !== query.status) return false;
    return true;
  });
  if (query.q) filtered.sort((a, b) => (score.get(b)! - score.get(a)!) || Number(current.items[b].active) - Number(current.items[a].active) || a - b);
  const all = current.items;
  const tally = (pick: (item: SkillCatalogueItem) => string | undefined) => all.reduce<Record<string, number>>((counts, item) => { const key = pick(item); if (key) counts[key] = (counts[key] ?? 0) + 1; return counts; }, {});
  const workflows = new Map<string, number>();
  for (const item of all) if (item.facts) workflows.set(item.facts.workflow, (workflows.get(item.facts.workflow) ?? 0) + 1);
  return SkillCatalogueResultSchema.parse({
    items: filtered.slice(query.offset, query.offset + query.limit).map(position => all[position]), total: filtered.length,
    counts: {
      families: all.length, versions: current.versions, packages: tally(item => item.facts?.package), languages: tally(item => item.facts?.language), compatibility: tally(item => item.facts?.compatibility),
      workflows: workflows.size, multiSkillWorkflows: [...workflows.values()].filter(count => count > 1).length,
      languageVariants: all.filter(item => item.relations.some(relation => relation.relation === 'language_variant')).length,
      structurallyValid: all.filter(structurallyValid).length, behaviourallyTested: all.filter(tested).length, active: all.filter(item => item.active).length,
    },
    pendingFacts: pending,
  });
}

/** Content identity of a package folder: every file path with the hash of its text, independent of order. */
export function folderIdentity(files: readonly { path: string; content: string }[]): string {
  return sha256(JSON.stringify([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map(file => [file.path, sha256(file.content)])));
}
