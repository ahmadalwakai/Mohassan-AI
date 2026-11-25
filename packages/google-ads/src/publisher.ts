import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { GoogleAdsDraft, GoogleAdsDraftState, GoogleAdsPublishing } from '@mohassan/contracts';
import type { CallContext, GoogleAdsClient, MutateOperation, Row } from './client.ts';
import { canonicalJson, sha256 } from './crypto.ts';
import { GoogleAdsError, stateConflict } from './errors.ts';
import { audit, parsed, type Db } from './store.ts';
import { VerifiedExperienceMemory } from './experience.ts';
import { verifyPublishedCampaign } from './verifier.ts';

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
const definiteRejection = (error: unknown) => error instanceof GoogleAdsError && !['GOOGLE_ADS_UNAVAILABLE', 'GOOGLE_ADS_PARTIAL_RESPONSE', 'GOOGLE_ADS_RESPONSE_INVALID'].includes(error.code);

function assertAccount(draft: GoogleAdsDraft, context: CallContext & { customerId: string }) {
  if (draft.customerId !== context.customerId) throw new GoogleAdsError('GOOGLE_ADS_ACCOUNT_CHANGED', 'حساب التنفيذ لا يطابق الحساب المفوّض لهذه الحملة.', 409);
}

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
      // Shared across workers; a process-local mutex cannot fence another server.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`google-ads:${draft.customerId}`}))`.execute(transaction);
      const competing = await transaction.selectFrom('google_ads_drafts').select(['id', 'owner_id', 'state', 'brief', 'updated_at', 'campaign_resource_name'])
        .where('customer_id', '=', draft.customerId).where('id', '!=', draft.id)
        .where(eb => eb.or([eb('state', 'in', ['publishing', 'launching', 'outcome_unknown']), eb.and([eb('state', '=', 'failed'), eb('campaign_resource_name', 'is not', null)]), eb.and([eb('state', '=', 'published'), eb('updated_at', '>', new Date(Date.now() - 10 * 60_000))])])).execute();
      if (competing.some(row => ['publishing', 'launching', 'outcome_unknown'].includes(row.state) || row.state === 'failed' && row.campaign_resource_name)) {
        throw new GoogleAdsError('GOOGLE_ADS_WRITE_CONFLICT', 'توجد عملية غير محسومة على الحساب. اقرأ نتيجتها قبل أي كتابة أخرى.', 409);
      }
      if (action === 'publish' && competing.some(row => row.owner_id === ownerId && canonicalJson(parsed(row.brief)) === canonicalJson(draft.brief))) {
        throw new GoogleAdsError('GOOGLE_ADS_DUPLICATE_REVIEW_REQUIRED', 'توجد حملة مطابقة أُنشئت حديثًا. راجع قراءتها بدل إنشاء نسخة أخرى.', 409);
      }
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
    const rows = await this.client.search(`SELECT campaign.resource_name, campaign.status, campaign.name, campaign_budget.amount_micros FROM campaign WHERE campaign.name = '${escapeGaql(name)}' AND campaign.status != 'REMOVED' LIMIT 2`, { ...context, customerId });
    if (rows.length > 1) throw new GoogleAdsError('GOOGLE_ADS_READBACK_AMBIGUOUS', 'ظهرت أكثر من حملة بالاسم المتوقع؛ يلزم فحص الحساب دون إعادة الكتابة.', 409);
    return rows[0];
  }

  async publish(ownerId: string, draft: GoogleAdsDraft, operations: MutateOperation[], publishing: GoogleAdsPublishing, context: CallContext & { customerId: string }, beforeWrite?: () => Promise<void>) {
    assertAccount(draft, context);
    if (!publishing.available) throw new GoogleAdsError('GOOGLE_ADS_PUBLISHING_CLOSED', 'النشر مغلق حتى تكتمل كل البوابات.', 403);
    if (draft.state !== 'approved') throw stateConflict('يلزم موافقة صريحة قبل النشر.');
    if (draft.verification?.draftHash !== draft.draftHash || sha256(canonicalJson({ customerId: draft.customerId, operations })) !== draft.draftHash) throw stateConflict('تغيرت العمليات بعد التحقق. أعد التحقق.');
    await this.claim(ownerId, draft, 'publish', 'approved', 'publishing', draft.draftHash);
    await audit(this.db, ownerId, draft.id, 'publish_started', { draftHash: draft.draftHash, operations: operations.length });
    try { await beforeWrite?.(); }
    catch (error) { await this.settle(ownerId, draft.id, 'failed', { error: 'انتهى تفويض المهمة قبل إرسال الكتابة؛ لم تُنشأ الحملة.' }); await audit(this.db, ownerId, draft.id, 'publish_authority_ended'); throw error; }
    try {
      const result = await this.client.mutate(operations, false, context);
      await audit(this.db, ownerId, draft.id, 'publish_applied', { requestId: result.requestId, created: result.resourceNames.length, resourceNames: result.resourceNames });
      const campaigns = result.resourceNames.filter(name => new RegExp(`^customers/${draft.customerId}/campaigns/\\d+$`).test(name));
      if (campaigns.length !== 1 || result.resourceNames.some(name => !name.startsWith(`customers/${draft.customerId}/`))) throw new GoogleAdsError('GOOGLE_ADS_RESPONSE_INVALID', 'إيصال Google لا يحدد الحملة في الحساب المفوّض؛ يلزم قراءة الحساب.', 409);
      await this.db.updateTable('google_ads_drafts').set({ campaign_resource_name: campaigns[0], updated_at: new Date() }).where('id', '=', draft.id).where('owner_id', '=', ownerId).execute();
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
    try { await this.reconcile(ownerId, draft, context); }
    catch {
      await this.settle(ownerId, draft.id, 'outcome_unknown', { error: 'أُرسلت الكتابة لكن تعذرت قراءة النتيجة؛ لن تُكرر تلقائيًا.' });
      await audit(this.db, ownerId, draft.id, 'publish_readback_unknown');
      throw new GoogleAdsError('GOOGLE_ADS_OUTCOME_UNKNOWN', 'تعذرت قراءة النتيجة من الحساب؛ لن تُكرر الكتابة تلقائيًا.', 409);
    }
  }

  /** Reads the account to settle a publish. Only a read can move a draft out of an unknown result. */
  async reconcile(ownerId: string, draft: GoogleAdsDraft, context: CallContext & { customerId: string }) {
    assertAccount(draft, context);
    if (!draft.summary) throw stateConflict('لا يوجد ملخص لهذه المسودة.');
    if (!['publishing', 'launching', 'approved', 'outcome_unknown', 'published', 'live'].includes(draft.state) && !(draft.state === 'failed' && draft.campaignResourceName)) throw stateConflict('لا توجد حملة منشورة أو نتيجة معلقة لهذه المسودة.');
    const persisted = await this.db.selectFrom('google_ads_drafts').select(['operations', 'campaign_resource_name', 'updated_at']).where('id', '=', draft.id).where('owner_id', '=', ownerId).executeTakeFirstOrThrow();
    // A worker may still be awaiting the synchronous request. A concurrent read must not
    // release its claim or declare absence while that request can still commit.
    if (['publishing', 'launching'].includes(draft.state) && Date.now() - new Date(persisted.updated_at).getTime() < 90_000) throw new GoogleAdsError('GOOGLE_ADS_RECONCILE_PENDING', 'الكتابة ما زالت ضمن مهلة التسوية؛ انتظر قبل إعادة قراءة النتيجة، ولن تُرسل كتابة أخرى.', 409);
    const row = await this.confirmCampaign(draft.customerId, draft.summary.campaignName, context);
    if (!row?.campaign?.resourceName) {
      const evidence = { checkedAt: new Date().toISOString(), customerId: draft.customerId, campaignResourceName: persisted.campaign_resource_name ?? null, passed: false, fields: [{ field: 'campaign.observed', expected: draft.summary.campaignName, actual: null, passed: false }], resourceNames: persisted.campaign_resource_name ? [persisted.campaign_resource_name] : [], requestId: null };
      await this.settle(ownerId, draft.id, 'outcome_unknown', { error: 'لم تظهر الحملة في القراءة الحالية؛ هذا لا يثبت رفض الكتابة أو يمنع ظهورها لاحقًا. لن نكرر الإنشاء.', readback: JSON.stringify(evidence), revision: draft.revision + 1 });
      await audit(this.db, ownerId, draft.id, 'publish_not_observed', { ...evidence });
      return;
    }
    const budget = String(row.campaignBudget?.amountMicros ?? ''), status = String(row.campaign.status);
    const lastWrite = await this.db.selectFrom('google_ads_audit').select('type').where('owner_id', '=', ownerId).where('draft_id', '=', draft.id).where('type', 'in', ['publish_started', 'launch_started']).orderBy('created_at', 'desc').executeTakeFirst();
    const launchAttempt = draft.state === 'launching' || draft.state === 'live' || lastWrite?.type === 'launch_started';
    if ((status !== 'PAUSED' && !(launchAttempt && status === 'ENABLED')) || budget !== draft.summary.dailyBudgetMicros || row.campaign.name !== draft.summary.campaignName || !new RegExp(`^customers/${draft.customerId}/campaigns/\\d+$`).test(String(row.campaign.resourceName)) || persisted.campaign_resource_name && persisted.campaign_resource_name !== row.campaign.resourceName) {
      const validResource = new RegExp(`^customers/${draft.customerId}/campaigns/\\d+$`).test(String(row.campaign.resourceName));
      const evidence = { checkedAt: new Date().toISOString(), customerId: draft.customerId, campaignResourceName: row.campaign.resourceName, passed: false, resourceNames: [row.campaign.resourceName], requestId: null, fields: [
        { field: 'campaign.status', expected: launchAttempt ? 'PAUSED|ENABLED' : 'PAUSED', actual: status, passed: status === 'PAUSED' || launchAttempt && status === 'ENABLED' },
        { field: 'campaign.resourceName', expected: persisted.campaign_resource_name ?? `customers/${draft.customerId}/campaigns/<id>`, actual: row.campaign.resourceName, passed: validResource && (!persisted.campaign_resource_name || persisted.campaign_resource_name === row.campaign.resourceName) },
        { field: 'campaign.name', expected: draft.summary.campaignName, actual: String(row.campaign.name), passed: row.campaign.name === draft.summary.campaignName },
        { field: 'budget.amountMicros', expected: draft.summary.dailyBudgetMicros, actual: budget, passed: budget === draft.summary.dailyBudgetMicros },
      ] };
      await this.settle(ownerId, draft.id, 'failed', { error: 'الحملة في الحساب لا تطابق ما وُوفق عليه. راجعها في Google Ads.', campaign_resource_name: row.campaign.resourceName, readback: JSON.stringify(evidence) });
      await audit(this.db, ownerId, draft.id, 'publish_readback', evidence);
      await audit(this.db, ownerId, draft.id, 'publish_mismatch', { status, budget, expectedCampaign: persisted.campaign_resource_name, actualCampaign: row.campaign.resourceName });
      return;
    }
    const evidence = await verifyPublishedCampaign(this.client, { customerId: draft.customerId, campaignResourceName: row.campaign.resourceName, operations: parsed<MutateOperation[]>(persisted.operations), expectedStatus: status as 'PAUSED' | 'ENABLED', context });
    const receiptRow = await this.db.selectFrom('google_ads_audit').select('detail').where('owner_id', '=', ownerId).where('draft_id', '=', draft.id).where('type', '=', launchAttempt ? 'launch_applied' : 'publish_applied').orderBy('created_at', 'desc').executeTakeFirst();
    const receipt = receiptRow ? parsed<{ requestId?: string | null; resourceNames?: string[] }>(receiptRow.detail) : null;
    evidence.requestId = receipt?.requestId ?? null;
    evidence.resourceNames = [...new Set([...evidence.resourceNames, ...receipt?.resourceNames ?? []])];
    await this.db.updateTable('google_ads_drafts').set({ readback: JSON.stringify(evidence) }).where('id', '=', draft.id).where('owner_id', '=', ownerId).execute();
    await audit(this.db, ownerId, draft.id, 'publish_readback', { ...evidence });
    if (!evidence.passed) {
      await this.settle(ownerId, draft.id, 'failed', { error: 'قراءة الحساب أظهرت اختلافًا في الحقول المفوّضة؛ راجع دليل التحقق قبل أي إجراء جديد.', campaign_resource_name: row.campaign.resourceName });
      await audit(this.db, ownerId, draft.id, 'publish_mismatch', { fields: evidence.fields.filter(field => !field.passed) });
      return;
    }
    await this.settle(ownerId, draft.id, status === 'ENABLED' ? 'live' : 'published', { error: null, campaign_resource_name: row.campaign.resourceName, revision: draft.revision + 1 });
    await audit(this.db, ownerId, draft.id, 'publish_confirmed', { campaign: row.campaign.resourceName, status });
    await this.experience.record(ownerId, { customerId: draft.customerId, kind: status === 'ENABLED' ? 'launch_confirmed' : 'publish_confirmed', statement: status === 'ENABLED' ? `تأكد تفعيل الحملة «${row.campaign.name}» من الحساب.` : `أُنشئت الحملة «${row.campaign.name}» متوقفة وتأكد ذلك من الحساب.`, evidence: { source: 'google_ads_api', resourceName: row.campaign.resourceName, fetchedAt: new Date().toISOString(), figures: { status, dailyBudgetMicros: budget } } });
  }

  async launch(ownerId: string, draft: GoogleAdsDraft, publishing: GoogleAdsPublishing, context: CallContext & { customerId: string }) {
    assertAccount(draft, context);
    if (!publishing.available) throw new GoogleAdsError('GOOGLE_ADS_PUBLISHING_CLOSED', 'الإطلاق مغلق حتى تكتمل كل البوابات.', 403);
    if (draft.state !== 'launch_approved' || !draft.campaignResourceName || !draft.summary) throw stateConflict('يلزم موافقة صريحة على الإطلاق.');
    const hash = launchHash(draft.customerId, draft.campaignResourceName);
    const persisted = await this.db.selectFrom('google_ads_drafts').select('operations').where('id', '=', draft.id).where('owner_id', '=', ownerId).executeTakeFirstOrThrow();
    const operations = parsed<MutateOperation[]>(persisted.operations);
    const before = await verifyPublishedCampaign(this.client, { customerId: draft.customerId, campaignResourceName: draft.campaignResourceName, operations, expectedStatus: 'PAUSED', context });
    await audit(this.db, ownerId, draft.id, 'launch_preflight_readback', { ...before });
    if (!before.passed) throw new GoogleAdsError('GOOGLE_ADS_LAUNCH_MISMATCH', 'تغيرت الحملة منذ الموافقة؛ لم يُرسل أمر التفعيل.', 409);
    await this.claim(ownerId, draft, 'launch', 'launch_approved', 'launching', hash);
    await audit(this.db, ownerId, draft.id, 'launch_started', { campaign: draft.campaignResourceName });
    try { const result = await this.client.mutate(launchOperations(draft.campaignResourceName), false, context); await audit(this.db, ownerId, draft.id, 'launch_applied', { requestId: result.requestId, resourceNames: result.resourceNames }); } catch (error) {
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
    if (row?.campaign?.status === 'ENABLED' && row.campaign.resourceName === draft.campaignResourceName) {
      let evidence;
      try { evidence = await verifyPublishedCampaign(this.client, { customerId: draft.customerId, campaignResourceName: draft.campaignResourceName, operations, expectedStatus: 'ENABLED', context }); }
      catch (error) { await this.settle(ownerId, draft.id, 'outcome_unknown', { error: 'تعذرت قراءة كل حقول الحملة بعد التفعيل؛ لن يتكرر الأمر تلقائيًا.' }); throw error; }
      await this.db.updateTable('google_ads_drafts').set({ readback: JSON.stringify(evidence) }).where('id', '=', draft.id).where('owner_id', '=', ownerId).execute();
      await audit(this.db, ownerId, draft.id, 'launch_readback', { ...evidence });
      if (!evidence.passed) { await this.settle(ownerId, draft.id, 'failed', { error: 'لم تطابق قراءة الحساب الحملة المفوّضة بعد التفعيل.' }); return; }
      await this.settle(ownerId, draft.id, 'live', { error: null, revision: draft.revision + 1 });
      await audit(this.db, ownerId, draft.id, 'launch_confirmed', { campaign: draft.campaignResourceName });
      await this.experience.record(ownerId, { customerId: draft.customerId, kind: 'launch_confirmed', statement: `فُعّلت الحملة «${row.campaign.name}» وتأكد ذلك من الحساب.`, evidence: { source: 'google_ads_api', resourceName: draft.campaignResourceName, fetchedAt: new Date().toISOString(), figures: { status: 'ENABLED' } } });
      return;
    }
    await this.settle(ownerId, draft.id, 'published', { error: 'لم يؤكد الحساب تفعيل الحملة، فهي تُعامل على أنها متوقفة.', revision: draft.revision + 1 });
    await audit(this.db, ownerId, draft.id, 'launch_unconfirmed');
  }
}
