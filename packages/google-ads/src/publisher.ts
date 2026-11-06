import { randomUUID } from 'node:crypto';
import type { GoogleAdsDraft, GoogleAdsDraftState, GoogleAdsPublishing } from '@mohassan/contracts';
import type { CallContext, GoogleAdsClient, MutateOperation, Row } from './client.ts';
import { canonicalJson, sha256 } from './crypto.ts';
import { GoogleAdsError, stateConflict } from './errors.ts';
import { audit, type Db } from './store.ts';
import { VerifiedExperienceMemory } from './experience.ts';

/**
 * CampaignPublishingController. Two separate external writes, each with its own
 * single-use approval bound to the exact hash: publish creates a PAUSED campaign,
 * launch enables it. A write is attempted once. If the result is unknown the draft
 * stops until the account has been read; nothing is ever retried blind.
 */
const APPROVAL_TTL_MS = 30 * 60000;
const VERIFICATION_TTL_MS = 30 * 60000;

const escapeGaql = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
export const launchOperations = (campaign: string): MutateOperation[] => [{ campaignOperation: { update: { resourceName: campaign, status: 'ENABLED' }, updateMask: 'status' } }];
export const launchHash = (customerId: string, campaign: string) => sha256(canonicalJson({ customerId, operations: launchOperations(campaign) }));

/** A failure that proves Google applied nothing; everything else leaves the outcome open. */
const definiteRejection = (error: unknown) => error instanceof GoogleAdsError && !['GOOGLE_ADS_UNAVAILABLE'].includes(error.code);

export class CampaignPublishingController {
  constructor(private readonly db: Db, private readonly client: GoogleAdsClient, private readonly experience: VerifiedExperienceMemory) {}

  async approve(ownerId: string, draft: GoogleAdsDraft, action: 'publish' | 'launch', draftHash: string, customerId: string) {
    const expected = action === 'publish' ? draft.draftHash : launchHash(draft.customerId, draft.campaignResourceName ?? '');
    const state: GoogleAdsDraftState = action === 'publish' ? 'verified' : 'published';
    if (draft.state !== state) throw stateConflict(action === 'publish' ? 'يلزم نجاح التحقق المستقل قبل الموافقة.' : 'يلزم نشر الحملة متوقفة قبل الموافقة على إطلاقها.');
    if (draftHash !== expected || customerId !== draft.customerId) throw new GoogleAdsError('GOOGLE_ADS_APPROVAL_MISMATCH', 'الموافقة لا تطابق التغييرات المعروضة. راجعها مجددًا.', 409);
    if (action === 'publish' && !this.verificationFresh(draft)) throw stateConflict('انتهت صلاحية التحقق المستقل. أعد التحقق قبل الموافقة.');
    const next: GoogleAdsDraftState = action === 'publish' ? 'approved' : 'launch_approved';
    await this.db.transaction().execute(async transaction => {
      const moved = await transaction.updateTable('google_ads_drafts').set({ state: next, revision: draft.revision + 1, updated_at: new Date() }).where('id', '=', draft.id).where('owner_id', '=', ownerId).where('revision', '=', draft.revision).where('state', '=', state).executeTakeFirst();
      if (!moved.numUpdatedRows) throw stateConflict('تغيرت المسودة أثناء الموافقة. راجعها مجددًا.');
      await transaction.insertInto('google_ads_approvals').values({ id: randomUUID(), owner_id: ownerId, draft_id: draft.id, action, draft_hash: expected, customer_id: customerId, expires_at: new Date(Date.now() + APPROVAL_TTL_MS) }).execute();
    });
    await audit(this.db, ownerId, draft.id, `${action}_approved`, { draftHash: expected, customerId });
  }

  private verificationFresh(draft: GoogleAdsDraft) {
    return draft.verification?.passed === true && draft.verification.draftHash === draft.draftHash && Date.now() - Date.parse(draft.verification.checkedAt) < VERIFICATION_TTL_MS;
  }

  /** The claim moves the state and spends the approval in one step, so two clicks cannot both write. */
  private async claim(ownerId: string, draft: GoogleAdsDraft, action: 'publish' | 'launch', from: GoogleAdsDraftState, to: GoogleAdsDraftState, hash: string) {
    await this.db.transaction().execute(async transaction => {
      const moved = await transaction.updateTable('google_ads_drafts').set({ state: to, updated_at: new Date(), error: null }).where('id', '=', draft.id).where('owner_id', '=', ownerId).where('state', '=', from).where('revision', '=', draft.revision).executeTakeFirst();
      if (!moved.numUpdatedRows) throw stateConflict('بدأت هذه العملية من قبل أو تغيرت المسودة.');
      const spent = await transaction.updateTable('google_ads_approvals').set({ consumed_at: new Date() }).where('draft_id', '=', draft.id).where('owner_id', '=', ownerId).where('action', '=', action).where('draft_hash', '=', hash).where('customer_id', '=', draft.customerId).where('consumed_at', 'is', null).where('expires_at', '>', new Date()).executeTakeFirst();
      if (!spent.numUpdatedRows) throw new GoogleAdsError('GOOGLE_ADS_APPROVAL_REQUIRED', 'لا توجد موافقة صالحة لهذه التغييرات. وافق عليها مجددًا.', 403);
    });
  }

  private async settle(ownerId: string, id: string, state: GoogleAdsDraftState, values: Record<string, unknown> = {}) {
    await this.db.updateTable('google_ads_drafts').set({ state, updated_at: new Date(), ...values }).where('id', '=', id).where('owner_id', '=', ownerId).execute();
  }

  private async confirmCampaign(customerId: string, name: string, context: CallContext & { customerId: string }): Promise<Row | undefined> {
    const [row] = await this.client.search(`SELECT campaign.resource_name, campaign.status, campaign.name, campaign_budget.amount_micros FROM campaign WHERE campaign.name = '${escapeGaql(name)}' AND campaign.status != 'REMOVED' LIMIT 1`, { ...context, customerId });
    return row;
  }

  async publish(ownerId: string, draft: GoogleAdsDraft, operations: MutateOperation[], publishing: GoogleAdsPublishing, context: CallContext & { customerId: string }) {
    if (!publishing.available) throw new GoogleAdsError('GOOGLE_ADS_PUBLISHING_CLOSED', 'النشر مغلق حتى تكتمل كل البوابات.', 403);
    if (draft.state !== 'approved') throw stateConflict('يلزم موافقة صريحة قبل النشر.');
    if (draft.verification?.draftHash !== draft.draftHash || sha256(canonicalJson({ customerId: draft.customerId, operations })) !== draft.draftHash) throw stateConflict('تغيرت العمليات بعد التحقق. أعد التحقق.');
    await this.claim(ownerId, draft, 'publish', 'approved', 'publishing', draft.draftHash);
    await audit(this.db, ownerId, draft.id, 'publish_started', { draftHash: draft.draftHash, operations: operations.length });
    try {
      const result = await this.client.mutate(operations, false, context);
      await audit(this.db, ownerId, draft.id, 'publish_applied', { requestId: result.requestId, created: result.resourceNames.length });
    } catch (error) {
      if (definiteRejection(error)) {
        await this.settle(ownerId, draft.id, 'failed', { error: (error as Error).message });
        await audit(this.db, ownerId, draft.id, 'publish_rejected', { code: (error as GoogleAdsError).code, googleCodes: (error as GoogleAdsError).options.googleCodes ?? [] });
        throw error;
      }
      await this.settle(ownerId, draft.id, 'outcome_unknown', { error: 'لم تؤكد Google النتيجة. لن تُكرر الكتابة قبل قراءة الحساب.' });
      await audit(this.db, ownerId, draft.id, 'publish_unknown');
      throw new GoogleAdsError('GOOGLE_ADS_OUTCOME_UNKNOWN', 'لم تؤكد Google النتيجة. راجع الحالة من الحساب؛ لن تُكرر الكتابة تلقائيًا.', 409);
    }
    await this.reconcile(ownerId, draft, context);
  }

  /** Reads the account to settle a publish. Only a read can move a draft out of an unknown result. */
  async reconcile(ownerId: string, draft: GoogleAdsDraft, context: CallContext & { customerId: string }) {
    if (!draft.summary) throw stateConflict('لا يوجد ملخص لهذه المسودة.');
    if (!['publishing', 'launching', 'approved', 'outcome_unknown'].includes(draft.state)) throw stateConflict('لا توجد نتيجة معلقة لهذه المسودة.');
    const row = await this.confirmCampaign(draft.customerId, draft.summary.campaignName, context);
    if (!row?.campaign?.resourceName) {
      await this.settle(ownerId, draft.id, 'draft', { error: 'تأكدنا من الحساب: لم تُنشأ الحملة. تحتاج المسودة تحققًا وموافقة جديدين.', verification: null, revision: draft.revision + 1 });
      await audit(this.db, ownerId, draft.id, 'publish_confirmed_absent');
      return;
    }
    const budget = String(row.campaignBudget?.amountMicros ?? ''), status = String(row.campaign.status);
    if (status !== 'PAUSED' && status !== 'ENABLED' || budget !== draft.summary.dailyBudgetMicros) {
      await this.settle(ownerId, draft.id, 'failed', { error: 'الحملة في الحساب لا تطابق ما وُوفق عليه. راجعها في Google Ads.', campaign_resource_name: row.campaign.resourceName });
      await audit(this.db, ownerId, draft.id, 'publish_mismatch', { status, budget });
      return;
    }
    await this.settle(ownerId, draft.id, status === 'ENABLED' ? 'live' : 'published', { error: null, campaign_resource_name: row.campaign.resourceName, revision: draft.revision + 1 });
    await audit(this.db, ownerId, draft.id, 'publish_confirmed', { campaign: row.campaign.resourceName, status });
    await this.experience.record(ownerId, { customerId: draft.customerId, kind: 'publish_confirmed', statement: `أُنشئت الحملة «${row.campaign.name}» متوقفة وتأكد ذلك من الحساب.`, evidence: { source: 'google_ads_api', resourceName: row.campaign.resourceName, fetchedAt: new Date().toISOString(), figures: { status, dailyBudgetMicros: budget } } });
  }

  async launch(ownerId: string, draft: GoogleAdsDraft, publishing: GoogleAdsPublishing, context: CallContext & { customerId: string }) {
    if (!publishing.available) throw new GoogleAdsError('GOOGLE_ADS_PUBLISHING_CLOSED', 'الإطلاق مغلق حتى تكتمل كل البوابات.', 403);
    if (draft.state !== 'launch_approved' || !draft.campaignResourceName || !draft.summary) throw stateConflict('يلزم موافقة صريحة على الإطلاق.');
    const hash = launchHash(draft.customerId, draft.campaignResourceName);
    await this.claim(ownerId, draft, 'launch', 'launch_approved', 'launching', hash);
    await audit(this.db, ownerId, draft.id, 'launch_started', { campaign: draft.campaignResourceName });
    try { await this.client.mutate(launchOperations(draft.campaignResourceName), false, context); } catch (error) {
      if (definiteRejection(error)) {
        await this.settle(ownerId, draft.id, 'published', { error: (error as Error).message, revision: draft.revision + 1 });
        await audit(this.db, ownerId, draft.id, 'launch_rejected', { code: (error as GoogleAdsError).code });
        throw error;
      }
      // Enabling twice has no extra effect, but the reported state still comes from the account.
    }
    let row: Row | undefined;
    try { row = await this.confirmCampaign(draft.customerId, draft.summary.campaignName, context); } catch (error) {
      await this.settle(ownerId, draft.id, 'outcome_unknown', { error: 'تعذرت قراءة حالة الحملة بعد الإطلاق. راجع الحالة من الحساب.' });
      await audit(this.db, ownerId, draft.id, 'launch_unknown');
      throw error;
    }
    if (row?.campaign?.status === 'ENABLED') {
      await this.settle(ownerId, draft.id, 'live', { error: null, revision: draft.revision + 1 });
      await audit(this.db, ownerId, draft.id, 'launch_confirmed', { campaign: draft.campaignResourceName });
      await this.experience.record(ownerId, { customerId: draft.customerId, kind: 'launch_confirmed', statement: `فُعّلت الحملة «${row.campaign.name}» وتأكد ذلك من الحساب.`, evidence: { source: 'google_ads_api', resourceName: draft.campaignResourceName, fetchedAt: new Date().toISOString(), figures: { status: 'ENABLED' } } });
      return;
    }
    await this.settle(ownerId, draft.id, 'published', { error: 'لم يؤكد الحساب تفعيل الحملة، فهي تُعامل على أنها متوقفة.', revision: draft.revision + 1 });
    await audit(this.db, ownerId, draft.id, 'launch_unconfirmed');
  }
}
