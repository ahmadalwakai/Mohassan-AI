import { randomUUID } from 'node:crypto';
import type { GoogleAdsExperience } from '@mohassan/contracts';
import { GoogleAdsError } from './errors.ts';
import { sql } from 'kysely';
import { iso, json, parsed, type Db } from './store.ts';

/**
 * VerifiedExperienceMemory. It holds only what the Google Ads API itself returned
 * for a named resource. A guess, an estimate or a model's summary has no way in:
 * callers must supply the figures, the resource and the time they were read.
 */
export class VerifiedExperienceMemory {
  constructor(private readonly db: Db) {}

  async record(ownerId: string, entry: Omit<GoogleAdsExperience, 'id' | 'createdAt'>) {
    const { evidence } = entry;
    if (evidence.source !== 'google_ads_api' || !evidence.resourceName.startsWith(`customers/${entry.customerId}/`) || !Object.keys(evidence.figures).length || Number.isNaN(Date.parse(evidence.fetchedAt))) throw new GoogleAdsError('GOOGLE_ADS_EXPERIENCE_UNVERIFIED', 'لا تُحفظ خبرة دون دليل مقروء من Google Ads.', 400);
    await this.db.insertInto('google_ads_experiences').values({ id: randomUUID(), owner_id: ownerId, customer_id: entry.customerId, kind: entry.kind, statement: entry.statement, evidence: json(evidence), dedup_key: `${entry.kind}:${evidence.resourceName}:${evidence.fetchedAt.slice(0, 10)}` }).onConflict(conflict => conflict.columns(['owner_id', 'dedup_key']).doNothing()).execute();
  }

  async list(ownerId: string, customerId: string | null): Promise<GoogleAdsExperience[]> {
    if (!customerId) return [];
    const rows = await this.db.selectFrom('google_ads_experiences').selectAll().where('owner_id', '=', ownerId).where('customer_id', '=', customerId).orderBy('created_at', 'desc').limit(50).execute();
    return rows.map(row => ({ id: row.id, customerId: row.customer_id, kind: row.kind, statement: row.statement, evidence: parsed(row.evidence), createdAt: iso(row.created_at)! }));
  }
}

export type LessonVerifier = 'local_validator' | 'google_validate_only' | 'google_readback';
export interface RecoveryLesson { category: string; code: string; strategy: string; verifiedBy: LessonVerifier; successes: number; failures: number }
const TOKEN = /^[A-Za-z][A-Za-z0-9_]{1,59}$/;
const VERIFIERS: readonly LessonVerifier[] = ['local_validator', 'google_validate_only', 'google_readback'];
/** Below this many verified outcomes a lesson is too thin to change a plan. */
export const LESSON_MIN_OBSERVATIONS = 3;

/**
 * RecoveryLessonMemory. What worked and what did not, as counters keyed by fixed
 * tokens: failure category, validator code and strategy. An outcome is counted only
 * after an independent check named in `verifiedBy`; a model's explanation of why a
 * correction worked has no column to live in. Because no free text is stored, a
 * lesson can reorder allowed strategies but can never carry an instruction.
 */
export class RecoveryLessonMemory {
  constructor(private readonly db: Db) {}

  async record(ownerId: string, entry: { category: string; code: string; strategy: string; verifiedBy: LessonVerifier; succeeded: boolean }) {
    if (![entry.category, entry.code, entry.strategy].every(value => TOKEN.test(value)) || !VERIFIERS.includes(entry.verifiedBy) || typeof entry.succeeded !== 'boolean') throw new GoogleAdsError('GOOGLE_ADS_LESSON_INVALID', 'لا يُحفظ درس خارج المفردات المعتمدة.', 400);
    const [successes, failures] = entry.succeeded ? [1, 0] : [0, 1];
    await this.db.insertInto('google_ads_recovery_lessons').values({ owner_id: ownerId, category: entry.category, code: entry.code, strategy: entry.strategy, verified_by: entry.verifiedBy, successes, failures })
      .onConflict(conflict => conflict.columns(['owner_id', 'category', 'code', 'strategy', 'verified_by']).doUpdateSet({ successes: sql`google_ads_recovery_lessons.successes + ${successes}`, failures: sql`google_ads_recovery_lessons.failures + ${failures}`, updated_at: new Date() })).execute();
  }

  async list(ownerId: string): Promise<RecoveryLesson[]> {
    const rows = await this.db.selectFrom('google_ads_recovery_lessons').selectAll().where('owner_id', '=', ownerId).orderBy('updated_at', 'desc').limit(200).execute();
    return rows.filter(row => [row.category, row.code, row.strategy].every(value => TOKEN.test(value))).map(row => ({ category: row.category, code: row.code, strategy: row.strategy, verifiedBy: row.verified_by, successes: Number(row.successes), failures: Number(row.failures) }));
  }
}

/** A strategy is skipped only when verified history shows it failing repeatedly and never succeeding. */
export const lessonAdvisesAgainst = (lessons: readonly RecoveryLesson[], code: string, strategy: string) => {
  const matching = lessons.filter(lesson => lesson.code === code && lesson.strategy === strategy);
  const successes = matching.reduce((total, lesson) => total + lesson.successes, 0), failures = matching.reduce((total, lesson) => total + lesson.failures, 0);
  return successes === 0 && failures >= LESSON_MIN_OBSERVATIONS;
};
