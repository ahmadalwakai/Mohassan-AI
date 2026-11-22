import { z } from 'zod';
import { SkillVerdictSchema, Slug } from './skills';

/** `owner/name` of one public GitHub repository. The transport builds the only URL it ever contacts from these two parts. */
export const SkillRemoteRepoSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/)
  .refine(value => { const name = value.slice(value.indexOf('/') + 1); return name !== '.' && name !== '..' && !/\.git$/i.test(name); }, 'اسم المستودع غير صالح.');
/** A branch name; it is always addressed as `refs/heads/<ref>` and never as a tag or an arbitrary object. */
export const SkillRemoteRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/)
  .refine(value => !value.includes('..') && !value.includes('//') && !value.endsWith('/') && !value.endsWith('.lock'), 'اسم الفرع غير صالح.');
export const SkillRemoteCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
/** The folder inside the repository that holds one sub-folder per skill. */
export const SkillRemotePathSchema = z.string().min(1).max(180).regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/)
  .refine(value => !value.split('/').some(part => part === '.' || part === '..' || part.endsWith('.')), 'مسار المجلد غير صالح.');

export const SkillRemoteConfigSchema = z.object({
  repo: SkillRemoteRepoSchema, ref: SkillRemoteRefSchema, path: SkillRemotePathSchema,
  autoActivate: z.boolean(), intervalMinutes: z.number().int().min(0).max(1440),
}).strict();
export type SkillRemoteConfig = z.infer<typeof SkillRemoteConfigSchema>;

export const SkillRemoteOutcomeSchema = z.enum(['unchanged', 'activated', 'pending_review', 'rejected', 'incompatible', 'skipped', 'error']);
export type SkillRemoteOutcome = z.infer<typeof SkillRemoteOutcomeSchema>;
export const SkillRemoteItemSchema = z.object({
  slug: Slug, outcome: SkillRemoteOutcomeSchema, deduplicated: z.boolean(), versionId: z.uuid().nullable(), version: z.string().max(32).nullable(),
  verdict: SkillVerdictSchema.nullable(), code: z.string().max(64).nullable(), message: z.string().max(300).nullable(),
}).strict();
export type SkillRemoteItem = z.infer<typeof SkillRemoteItemSchema>;

const Count = z.number().int().nonnegative();
export const SkillRemoteSyncSchema = z.object({
  id: z.uuid(), repo: SkillRemoteRepoSchema, ref: SkillRemoteRefSchema, path: SkillRemotePathSchema, commit: SkillRemoteCommitSchema.nullable(),
  cause: z.enum(['schedule', 'manual']), status: z.enum(['running', 'succeeded', 'failed']), errorCode: z.string().max(64).nullable(),
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(), unchanged: z.boolean(),
  counts: z.object({ total: Count, unchanged: Count, activated: Count, pendingReview: Count, rejected: Count, errors: Count }).strict(),
  items: z.array(SkillRemoteItemSchema).max(100),
  /** Skills that left the repository while a version from it is still active here. Nothing is revoked automatically. */
  orphans: z.array(z.object({ slug: Slug, versionId: z.uuid() }).strict()).max(100),
}).strict();
export type SkillRemoteSync = z.infer<typeof SkillRemoteSyncSchema>;

export const SkillRemotePendingSchema = z.object({ id: z.uuid(), slug: Slug, name: z.string(), version: z.string().max(32), verdict: SkillVerdictSchema.nullable() }).strict();
export type SkillRemotePending = z.infer<typeof SkillRemotePendingSchema>;

export const SkillRemoteStatusSchema = z.object({
  configured: z.boolean(), engineEnabled: z.boolean(), problem: z.string().max(64).nullable(),
  repo: SkillRemoteRepoSchema.nullable(), ref: SkillRemoteRefSchema.nullable(), path: SkillRemotePathSchema.nullable(),
  autoActivate: z.boolean(), intervalMinutes: z.number().int().min(0).max(1440), running: z.boolean(),
  last: SkillRemoteSyncSchema.nullable(), lastSuccess: z.object({ commit: SkillRemoteCommitSchema, finishedAt: z.iso.datetime() }).strict().nullable(),
  nextSyncAt: z.iso.datetime().nullable(), pending: z.array(SkillRemotePendingSchema).max(20),
  quota: z.object({ used: Count, limit: z.number().int().positive() }).strict(),
}).strict();
export type SkillRemoteStatus = z.infer<typeof SkillRemoteStatusSchema>;

export const SkillRemoteStartSchema = z.object({}).strict();
export const SkillRemoteStartResultSchema = z.object({ started: z.literal(true), syncId: z.uuid() }).strict();
export type SkillRemoteStartResult = z.infer<typeof SkillRemoteStartResultSchema>;
