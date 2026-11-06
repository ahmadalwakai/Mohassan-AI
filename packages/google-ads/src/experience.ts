import { randomUUID } from 'node:crypto';
import type { GoogleAdsExperience } from '@mohassan/contracts';
import { GoogleAdsError } from './errors.ts';
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
