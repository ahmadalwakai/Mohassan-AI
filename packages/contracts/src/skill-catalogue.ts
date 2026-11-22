import { z } from 'zod';
import { SkillCategorySchema, SkillLevelSchema, SkillOriginSchema, SkillStatusSchema, SkillVerdictSchema, Slug } from './skills';

/**
 * The skill catalogue: what is known about every skill family of an owner, outside any model prompt.
 * Structural validity (a current inspection that passed), behavioural evidence (task tests bound to the
 * exact content) and activation are separate facts, and are counted separately.
 */
export const SkillCompatibilitySchema = z.enum(['compatible', 'partial', 'requires_resources', 'requires_tools', 'requires_execution']);
export type SkillCompatibility = z.infer<typeof SkillCompatibilitySchema>;
/** `owner`: no third-party source is declared; `unknown`: a third-party source without a recognised licence. */
export const SkillLicenceKindSchema = z.enum(['permissive', 'owner', 'unknown', 'restricted']);
export type SkillLicenceKind = z.infer<typeof SkillLicenceKindSchema>;
export const SkillCatalogueLanguageSchema = z.enum(['ar', 'en', 'mixed']);

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Count = z.number().int().nonnegative();
const Tally = z.record(z.string(), Count);

export const SkillCatalogueUpstreamSchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/), revision: z.string().regex(/^[a-f0-9]{40}$/),
  path: z.string().min(1).max(240), sha256: Sha256.nullable(),
}).strict();
export type SkillCatalogueUpstream = z.infer<typeof SkillCatalogueUpstreamSchema>;

/** Facts derived once per version from its verified files; recomputed only for a new version. */
export const SkillCatalogueFactsSchema = z.object({
  language: SkillCatalogueLanguageSchema, workflow: Slug, variantOf: Slug.nullable(), keywords: z.array(z.string().min(1).max(40)).max(24),
  package: z.string().min(1).max(120), upstream: SkillCatalogueUpstreamSchema.nullable(), licence: z.string().min(1).max(64), licenceKind: SkillLicenceKindSchema,
  attribution: z.string().max(300).nullable(), requires: z.array(z.string().min(1).max(40)).max(12),
  compatibility: SkillCompatibilitySchema, reasons: z.array(z.string().min(1).max(120)).max(24), bodyChars: Count,
}).strict();
export type SkillCatalogueFacts = z.infer<typeof SkillCatalogueFactsSchema>;

const Flag = z.enum(['true', 'false']).transform(value => value === 'true');
export const SkillCatalogueQuerySchema = z.object({
  q: z.string().trim().max(200).default(''), category: SkillCategorySchema.optional(), language: SkillCatalogueLanguageSchema.optional(),
  compatibility: SkillCompatibilitySchema.optional(), status: z.union([z.enum(['active', 'inactive']), SkillStatusSchema]).optional(),
  package: z.string().min(1).max(120).optional(), workflow: Slug.optional(), tested: Flag.optional(), licence: SkillLicenceKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).max(100_000).default(0),
}).strict();
export type SkillCatalogueQuery = z.infer<typeof SkillCatalogueQuerySchema>;

export const SkillCatalogueRelationSchema = z.object({
  slug: Slug, relation: z.enum(['language_variant', 'same_workflow', 'similar']), signal: z.enum(['declared', 'derived', 'review']), score: z.number().min(0).max(1).nullable(),
}).strict();

export const SkillCatalogueItemSchema = z.object({
  familyId: z.uuid(), versionId: z.uuid(), slug: Slug, name: z.string(), description: z.string(), category: SkillCategorySchema, level: SkillLevelSchema,
  origin: SkillOriginSchema, status: SkillStatusSchema, active: z.boolean(), version: z.string(), contentHash: Sha256,
  /** Null until the catalogue has read this version (backfill is bounded per request; see `pendingFacts`). */
  facts: SkillCatalogueFactsSchema.nullable(),
  structural: z.object({ verdict: SkillVerdictSchema, current: z.boolean() }).strict().nullable(),
  behavioural: z.object({ suite: z.string().max(120), passed: Count, total: Count, at: z.iso.datetime() }).strict().nullable(),
  relations: z.array(SkillCatalogueRelationSchema).max(24),
}).strict();
export type SkillCatalogueItem = z.infer<typeof SkillCatalogueItemSchema>;

export const SkillCatalogueResultSchema = z.object({
  items: z.array(SkillCatalogueItemSchema).max(100), total: Count,
  counts: z.object({
    /** Skill families (one id each) and stored versions: never the same number once a family has a history. */
    families: Count, versions: Count, packages: Tally, languages: Tally, compatibility: Tally,
    workflows: Count, multiSkillWorkflows: Count, languageVariants: Count,
    structurallyValid: Count, behaviourallyTested: Count, active: Count,
  }).strict(),
  /** Versions whose facts are not read yet; they appear with `facts: null` until a later request reads them. */
  pendingFacts: Count,
}).strict();
export type SkillCatalogueResult = z.infer<typeof SkillCatalogueResultSchema>;

/** A local skill package: `<path>/skills/<slug>/SKILL.md`, inside the coding allowed roots. */
export const SkillCatalogueImportRequestSchema = z.object({ path: z.string().min(3).max(1000), batchSize: z.number().int().min(1).max(100).default(25) }).strict();
export const SkillCatalogueImportOutcomeSchema = z.enum(['imported', 'unchanged', 'rejected', 'error', 'quota_blocked']);
export const SkillCatalogueImportItemSchema = z.object({
  slug: Slug, outcome: SkillCatalogueImportOutcomeSchema, versionId: z.uuid().nullable(), contentHash: Sha256.nullable(), verdict: SkillVerdictSchema.nullable(),
  code: z.string().max(64).nullable(), message: z.string().max(300).nullable(),
}).strict();
export type SkillCatalogueImportItem = z.infer<typeof SkillCatalogueImportItemSchema>;
export const SkillCatalogueImportStatusSchema = z.object({
  runId: z.uuid(), package: z.string().max(120), revision: Sha256, status: z.enum(['running', 'succeeded', 'failed']), resumed: z.boolean(),
  progress: z.object({ processed: Count, total: Count }).strict(),
  counts: z.object({ imported: Count, unchanged: Count, rejected: Count, errors: Count, quotaBlocked: Count }).strict(),
  quota: z.object({ used: Count, limit: Count }).strict(),
  /** This batch only; earlier batches of the same run are in `counts`. */
  items: z.array(SkillCatalogueImportItemSchema).max(100),
  errorCode: z.string().max(64).nullable(),
}).strict();
export type SkillCatalogueImportStatus = z.infer<typeof SkillCatalogueImportStatusSchema>;
