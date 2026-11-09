import { randomUUID } from 'node:crypto';
import { GoogleAdsBriefSchema, GoogleAdsDraftSchema, GoogleAdsReportSchema, GoogleAdsStatusSchema, type GoogleAdsAuditEntry, type GoogleAdsBookingRule, type GoogleAdsBrief, type GoogleAdsDraft, type GoogleAdsDraftState, type GoogleAdsIssue, type GoogleAdsMarket, type GoogleAdsPublishing, type GoogleAdsRecommendation, type GoogleAdsReport, type GoogleAdsStatus, type GoogleAdsValidation } from '@mohassan/contracts';
import { GoogleAdsClient, type CallContext, type MutateOperation } from './client.ts';
import { GoogleAdsConnectionManager, type ConnectionRow } from './connection.ts';
import { canonicalJson, parseTokenKey } from './crypto.ts';
import { buildOperations, operationsHash, type Bidding, type GeoTarget } from './draft.ts';
import { GoogleAdsError, notConfigured, stateConflict } from './errors.ts';
import { VerifiedExperienceMemory } from './experience.ts';
import { defaultGateFiles, evidenceGates, type GateFiles } from './gates.ts';
import { campaignStrategy, chooseBidding, marketIntelligence, optimize, readSearchTerms, searchTermsQuery } from './intelligence.ts';
import { analyzeAccount, dateRange } from './performance.ts';
import { CampaignPublishingController, launchHash } from './publisher.ts';
import { detectScript, readLandingPage, validateBrief } from './quality.ts';
import { audit, iso, json, parsed, type Db } from './store.ts';
import { summarizeOperations, verifyConversionTracking, verifyDraft } from './verifier.ts';

export interface LandingFetch { status: number; finalUrl: string; html: string; contentLanguage: string | null }

export interface GoogleAdsConfig {
  clientId?: string; clientSecret?: string; tokenKey?: string; developerToken?: string;
  webOrigin: string; publishingEnabled?: boolean; maxDailyBudgetMicros?: bigint;
  fetchPage: (url: string, signal?: AbortSignal) => Promise<LandingFetch>;
  fetch?: typeof fetch; sleep?: (milliseconds: number) => Promise<void>; gateFiles?: GateFiles;
  /** Fixture hook for the mocked Google sign-in page; production uses Google's own URL. */
  authorizationUrl?: string;
}

const DEFAULT_MAX_DAILY_BUDGET = 100_000_000n;
const REPORT_DAYS = new Set([7, 14, 30, 90]);

const toDraft = (row: any): GoogleAdsDraft => GoogleAdsDraftSchema.parse({
  id: row.id, customerId: row.customer_id, state: row.state, revision: row.revision, brief: parsed(row.brief), draftHash: row.draft_hash, bidding: row.bidding,
  summary: parsed(row.summary), strategy: parsed(row.strategy), validation: parsed(row.validation), verification: parsed(row.verification),
  campaignResourceName: row.campaign_resource_name, error: row.error, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
});

export function createGoogleAdsControl(db: Db, config: GoogleAdsConfig) {
  const missing = [['GOOGLE_ADS_CLIENT_ID', config.clientId], ['GOOGLE_ADS_CLIENT_SECRET', config.clientSecret], ['GOOGLE_ADS_TOKEN_KEY', config.tokenKey]].filter(([, value]) => !value).map(([name]) => name!);
  const tokenKey = config.tokenKey ? parseTokenKey(config.tokenKey) : null;
  const maxDailyBudgetMicros = config.maxDailyBudgetMicros ?? DEFAULT_MAX_DAILY_BUDGET;
  const gateFiles = config.gateFiles ?? defaultGateFiles();
  const configured = !missing.length;
  const client = configured ? new GoogleAdsClient({ clientId: config.clientId!, clientSecret: config.clientSecret!, ...(config.developerToken ? { developerToken: config.developerToken } : {}), ...(config.fetch ? { fetch: config.fetch } : {}), ...(config.sleep ? { sleep: config.sleep } : {}) }) : null;
  const redirectUri = `${config.webOrigin}/api/google-ads/oauth/callback`;
  const connection = client ? new GoogleAdsConnectionManager(db, client, { clientId: config.clientId!, tokenKey: tokenKey!, redirectUri, ...(config.authorizationUrl ? { authorizationUrl: config.authorizationUrl } : {}) }) : null;
  const experience = new VerifiedExperienceMemory(db);
  const publisher = client ? new CampaignPublishingController(db, client, experience) : null;

  const ready = () => { if (!connection || !client || !publisher) throw notConfigured(); return { connection, client, publisher }; };

  async function publishing(row: ConnectionRow | null): Promise<GoogleAdsPublishing> {
    const gates = [
      { id: 'server_switch', passed: config.publishingEnabled === true, detail: config.publishingEnabled ? 'النشر مفعّل في إعدادات الخادم' : 'GOOGLE_ADS_PUBLISHING_ENABLED ليس true' },
      { id: 'connection', passed: row?.status === 'connected', detail: row?.status === 'connected' ? 'الحساب مربوط ومختار' : 'لا يوجد حساب مربوط ومختار' },
      ...await evidenceGates(gateFiles, row?.customerId ?? null, row?.testAccount ?? false),
    ];
    return { available: gates.every(gate => gate.passed), gates };
  }

  async function status(ownerId: string): Promise<GoogleAdsStatus> {
    const row = connection ? await connection.row(ownerId) : null;
    const gates = await publishing(row);
    const base = { missingSettings: missing, retryAfterSeconds: null as number | null, account: null as GoogleAdsStatus['account'], connectedAt: row?.connectedAt ?? null, lastCheckedAt: row?.lastCheckedAt ?? null, publishing: gates };
    if (!row) return GoogleAdsStatusSchema.parse({ ...base, state: 'not_configured', message: 'تحتاج الخدمة إعداد مشروع Google Cloud قبل الربط.' });
    const account = row.customerId ? { customerId: row.customerId, name: row.name ?? row.customerId, currency: row.currency ?? '', timeZone: row.timeZone ?? '', testAccount: row.testAccount, loginCustomerId: row.loginCustomerId } : null;
    const remaining = row.rateLimitedUntil ? Math.ceil((Date.parse(row.rateLimitedUntil) - Date.now()) / 1000) : 0;
    const state = row.status === 'connected' && remaining > 0 ? 'rate_limited' : row.status;
    const messages: Record<string, string> = { disconnected: 'لم يُربط حساب Google Ads بعد.', needs_account: 'اكتمل تفويض Google. اختر حساب الإعلانات.', connected: 'الحساب مربوط.', unauthorized: 'انتهى تفويض Google أو أُلغي. أعد ربط الحساب.', rate_limited: 'وصلنا إلى حد طلبات Google مؤقتًا.' };
    return GoogleAdsStatusSchema.parse({ ...base, state, message: messages[state], account, retryAfterSeconds: remaining > 0 ? remaining : null });
  }

  async function report(ownerId: string, days: number): Promise<GoogleAdsReport> {
    if (!REPORT_DAYS.has(days)) throw new GoogleAdsError('GOOGLE_ADS_RANGE', 'الفترة غير مدعومة.', 400);
    const { connection, client } = ready();
    const result = await connection.runForAccount(ownerId, (context, row) => analyzeAccount(client, context, { currency: row.currency ?? '', timeZone: row.timeZone ?? '' }, row.bookingRules, days));
    await recordOutcomes(ownerId, result);
    await audit(db, ownerId, null, 'report_read', { days, campaigns: result.campaigns.length });
    return GoogleAdsReportSchema.parse(result);
  }

  /** Learns only from live campaigns that really served, in figures Google returned. */
  async function recordOutcomes(ownerId: string, result: GoogleAdsReport) {
    const live = await db.selectFrom('google_ads_drafts').select(['campaign_resource_name']).where('owner_id', '=', ownerId).where('customer_id', '=', result.customerId).where('state', '=', 'live').execute();
    for (const { campaign_resource_name: resourceName } of live) {
      const campaign = result.campaigns.find(item => resourceName?.endsWith(`/${item.id}`));
      if (!resourceName || !campaign || campaign.impressions === 0) continue;
      await experience.record(ownerId, { customerId: result.customerId, kind: 'measured_outcome', statement: `«${campaign.name}» من ${result.range.start} إلى ${result.range.end}: ${campaign.clicks} نقرة و${campaign.conversions} تحويلًا.`, evidence: { source: 'google_ads_api', resourceName, fetchedAt: result.fetchedAt, figures: { impressions: campaign.impressions, clicks: campaign.clicks, costMicros: campaign.costMicros, conversions: campaign.conversions } } });
    }
  }

  async function resolveLocations(context: CallContext, names: readonly string[], countryCode: string): Promise<GeoTarget[]> {
    const { client } = ready();
    // Google answers in the requested locale, so the names must be compared in their own script.
    const suggestions = await client.suggestGeoTargets([...names], detectScript(names.join(' ')) === 'arabic' ? 'ar' : 'en', countryCode, context);
    const targets: GeoTarget[] = [];
    for (const name of names) {
      const wanted = name.toLocaleLowerCase();
      const match = suggestions.map(item => item.geoTargetConstant).find(item => item?.status === 'ENABLED' && item?.countryCode === countryCode && String(item?.name).toLocaleLowerCase() === wanted);
      if (match) targets.push({ name, resourceName: String(match.resourceName), countryCode: String(match.countryCode) });
    }
    return targets;
  }

  async function market(ownerId: string, seeds: string[], locations: string[], countryCode: string | null): Promise<GoogleAdsMarket> {
    const { connection, client } = ready();
    return connection.runForAccount(ownerId, async context => {
      const targets = locations.length && countryCode ? await resolveLocations(context, locations, countryCode) : [];
      return marketIntelligence(client, context, { seeds, geoResourceNames: targets.map(item => item.resourceName), range: dateRange(30) });
    });
  }

  /** One read for the whole page: the report and the advice built on the same figures. */
  async function recommendations(ownerId: string, days: number): Promise<{ report: GoogleAdsReport; items: GoogleAdsRecommendation[] }> {
    const current = await report(ownerId, days);
    const { connection, client } = ready();
    const terms = await connection.runForAccount(ownerId, context => client.search(searchTermsQuery(current.range.start, current.range.end), context));
    return { report: current, items: optimize(current, { searchTerms: { basis: 'observed', source: 'Google Ads search terms report', items: readSearchTerms(terms) } }) };
  }

  /** The preview needs the account: locations resolve against Google and bidding reads real conversions. */
  async function prepare(ownerId: string, draftId: string, brief: GoogleAdsBrief, context: CallContext & { customerId: string }, row: ConnectionRow) {
    const { client } = ready();
    const [current, geoTargets] = [await analyzeAccount(client, context, { currency: row.currency ?? '', timeZone: row.timeZone ?? '' }, row.bookingRules, 30), await resolveLocations(context, brief.locations, brief.countryCode)];
    const insight = brief.keywords.length ? await marketIntelligence(client, context, { seeds: brief.keywords.slice(0, 10).map(keyword => keyword.replace(/[[\]"]/g, '').trim()), geoResourceNames: geoTargets.map(item => item.resourceName), range: current.range }) : null;
    const bidding: Bidding = chooseBidding(current);
    const operations = buildOperations(brief, draftId, context.customerId, geoTargets, bidding);
    return {
      bidding, operations, geoTargets, draftHash: operationsHash(context.customerId, operations),
      strategy: campaignStrategy(brief, current, insight, row.currency ?? ''),
      summary: summarizeOperations(context.customerId, operations, new Map(geoTargets.map(item => [item.resourceName, item.name]))),
    };
  }

  async function createDraft(ownerId: string, input: unknown, idempotencyKey: string): Promise<GoogleAdsDraft> {
    const { connection } = ready();
    const brief = GoogleAdsBriefSchema.parse(input);
    const existing = await db.selectFrom('google_ads_drafts').selectAll().where('owner_id', '=', ownerId).where('idempotency_key', '=', idempotencyKey).executeTakeFirst();
    if (existing) {
      if (canonicalJson(parsed(existing.brief)) !== canonicalJson(brief)) throw new GoogleAdsError('GOOGLE_ADS_IDEMPOTENCY', 'أُعيد استخدام مفتاح الطلب بمحتوى مختلف.', 409);
      return toDraft(existing);
    }
    const id = randomUUID();
    const prepared = await connection.runForAccount(ownerId, (context, row) => prepare(ownerId, id, brief, context, row).then(result => ({ ...result, customerId: context.customerId })));
    const inserted = await db.insertInto('google_ads_drafts').values({ id, owner_id: ownerId, customer_id: prepared.customerId, idempotency_key: idempotencyKey, state: 'preview', brief: json(brief), bidding: prepared.bidding, operations: json(prepared.operations), draft_hash: prepared.draftHash, geo_targets: json(prepared.geoTargets), summary: json(prepared.summary), strategy: json(prepared.strategy) })
      .onConflict(conflict => conflict.columns(['owner_id', 'idempotency_key']).doNothing()).returningAll().executeTakeFirst();
    if (!inserted) {
      const concurrent = await db.selectFrom('google_ads_drafts').selectAll().where('owner_id', '=', ownerId).where('idempotency_key', '=', idempotencyKey).executeTakeFirstOrThrow();
      if (canonicalJson(parsed(concurrent.brief)) !== canonicalJson(brief)) throw new GoogleAdsError('GOOGLE_ADS_IDEMPOTENCY', 'أُعيد استخدام مفتاح الطلب بمحتوى مختلف.', 409);
      return toDraft(concurrent);
    }
    await audit(db, ownerId, id, 'draft_created', { draftHash: prepared.draftHash });
    return toDraft(inserted);
  }

  async function load(ownerId: string, id: string, expectedRevision?: number) {
    const row = await db.selectFrom('google_ads_drafts').selectAll().where('id', '=', id).where('owner_id', '=', ownerId).executeTakeFirst();
    if (!row) throw new GoogleAdsError('GOOGLE_ADS_DRAFT_MISSING', 'المسودة غير موجودة.', 404);
    if (expectedRevision !== undefined && row.revision !== expectedRevision) throw stateConflict('تغيرت المسودة منذ فتحها. حدّث الصفحة.');
    return { row, draft: toDraft(row), operations: parsed<MutateOperation[]>(row.operations), geoTargets: parsed<GeoTarget[]>(row.geo_targets) };
  }

  async function move(ownerId: string, draft: GoogleAdsDraft, from: readonly GoogleAdsDraftState[], to: GoogleAdsDraftState, values: Record<string, unknown> = {}): Promise<GoogleAdsDraft> {
    if (!from.includes(draft.state)) throw stateConflict('لا تسمح حالة المسودة بهذه الخطوة.');
    const row = await db.updateTable('google_ads_drafts').set({ state: to, revision: draft.revision + 1, updated_at: new Date(), ...values }).where('id', '=', draft.id).where('owner_id', '=', ownerId).where('revision', '=', draft.revision).returningAll().executeTakeFirst();
    if (!row) throw stateConflict('تغيرت المسودة في الوقت نفسه. حدّث الصفحة.');
    return toDraft(row);
  }

  async function revise(ownerId: string, id: string, expectedRevision: number, input: unknown) {
    const { connection } = ready();
    const brief = GoogleAdsBriefSchema.parse(input);
    const { draft } = await load(ownerId, id, expectedRevision);
    const prepared = await connection.runForAccount(ownerId, (context, row) => { assertAccount(draft, context.customerId); return prepare(ownerId, id, brief, context, row); });
    const next = await move(ownerId, draft, ['preview', 'draft', 'rejected', 'validated', 'verified', 'approved', 'failed'], 'preview', { brief: json(brief), bidding: prepared.bidding, operations: json(prepared.operations), draft_hash: prepared.draftHash, geo_targets: json(prepared.geoTargets), summary: json(prepared.summary), strategy: json(prepared.strategy), validation: null, verification: null, error: null });
    await audit(db, ownerId, id, 'draft_revised', { draftHash: prepared.draftHash });
    return next;
  }

  const assertAccount = (draft: GoogleAdsDraft, customerId: string) => { if (draft.customerId !== customerId) throw stateConflict('هذه المسودة تخص حساب إعلانات آخر.'); };

  async function save(ownerId: string, id: string, expectedRevision: number) {
    const { draft } = await load(ownerId, id, expectedRevision);
    const next = await move(ownerId, draft, ['preview'], 'draft');
    await audit(db, ownerId, id, 'draft_saved', { draftHash: draft.draftHash });
    return next;
  }

  async function validate(ownerId: string, id: string, expectedRevision: number) {
    const { draft, geoTargets } = await load(ownerId, id, expectedRevision);
    if (!['draft', 'rejected', 'validated'].includes(draft.state)) throw stateConflict('احفظ المعاينة كمسودة أولًا.');
    const { brief } = draft;
    let landing: GoogleAdsValidation['landing'] = { requestedUrl: brief.landingPageUrl, finalUrl: null, status: null, language: null, title: null, reachable: false }, landingText = '';
    try {
      const page = await config.fetchPage(brief.landingPageUrl);
      ({ landing, text: landingText } = readLandingPage(brief.landingPageUrl, page.finalUrl, page.status, page.html, page.contentLanguage));
    } catch { /* An unreachable page is reported as a finding below. */ }
    const issues: GoogleAdsIssue[] = validateBrief(brief, landing, landingText);
    if (geoTargets.length !== brief.locations.length) {
      const found = new Set(geoTargets.map(item => item.name));
      for (const name of brief.locations.filter(item => !found.has(item))) issues.push({ code: 'LOCATION_UNRESOLVED', severity: 'error', field: 'locations', message: `Google has no exact location named ${JSON.stringify(name)} in ${brief.countryCode}.` });
    }
    const passed = !issues.some(issue => issue.severity === 'error');
    const validation: GoogleAdsValidation = { passed, checkedAt: new Date().toISOString(), draftHash: draft.draftHash, issues, landing, geoTargets };
    const next = await move(ownerId, draft, ['draft', 'rejected', 'validated'], passed ? 'validated' : 'rejected', { validation: json(validation), verification: null });
    await audit(db, ownerId, id, passed ? 'validation_passed' : 'validation_failed', { errors: issues.filter(issue => issue.severity === 'error').map(issue => issue.code) });
    return next;
  }

  async function verify(ownerId: string, id: string, expectedRevision: number, allowUnprovenConversionsForPaused = false) {
    const { connection, client } = ready();
    const { draft, operations, geoTargets } = await load(ownerId, id, expectedRevision);
    if (!['validated', 'verified'].includes(draft.state)) throw stateConflict('يلزم اجتياز فحص الجودة أولًا.');
    if (draft.validation?.draftHash !== draft.draftHash) throw stateConflict('تغيرت المسودة بعد فحص الجودة.');
    const verification = await connection.runForAccount(ownerId, context => {
      assertAccount(draft, context.customerId);
      return verifyDraft(client, { draftId: id, customerId: draft.customerId, brief: draft.brief, operations, storedHash: draft.draftHash, geoResourceNames: geoTargets.map(item => item.resourceName), maxDailyBudgetMicros, context, allowUnprovenConversionsForPaused });
    });
    const next = await move(ownerId, draft, ['validated', 'verified'], verification.passed ? 'verified' : 'validated', { verification: json(verification) });
    await audit(db, ownerId, id, verification.passed ? 'verification_passed' : 'verification_failed', { failed: verification.checks.filter(check => !check.passed).map(check => check.id) });
    return next;
  }

  async function approve(ownerId: string, id: string, action: 'publish' | 'launch', expectedRevision: number, draftHash: string, customerId: string) {
    const { publisher } = ready();
    const { draft } = await load(ownerId, id, expectedRevision);
    await publisher.approve(ownerId, draft, action, draftHash, customerId);
    return (await load(ownerId, id)).draft;
  }

  async function publish(ownerId: string, id: string, expectedRevision: number, beforeWrite?: () => Promise<void>) {
    const { connection, publisher } = ready();
    const { draft, operations } = await load(ownerId, id, expectedRevision);
    const gates = await publishing(await connection.row(ownerId));
    await connection.runForAccount(ownerId, context => { assertAccount(draft, context.customerId); return publisher.publish(ownerId, draft, operations, gates, context, beforeWrite); });
    return (await load(ownerId, id)).draft;
  }

  async function launch(ownerId: string, id: string, expectedRevision: number) {
    const { connection, publisher, client } = ready();
    const { draft } = await load(ownerId, id, expectedRevision);
    const gates = await publishing(await connection.row(ownerId));
    await connection.runForAccount(ownerId, async context => {
      assertAccount(draft, context.customerId);
      if (draft.state !== 'launch_approved') throw stateConflict('يلزم موافقة صريحة على الإطلاق.');
      const tracking = await verifyConversionTracking(client, context);
      if (!tracking.passed) throw new GoogleAdsError('GOOGLE_ADS_CONVERSIONS_REQUIRED', 'لا تُشغّل الحملة قبل إثبات عمل تتبع التحويلات. الحملة ما زالت متوقفة.', 409);
      return publisher.launch(ownerId, draft, gates, context);
    });
    return (await load(ownerId, id)).draft;
  }

  async function reconcile(ownerId: string, id: string, expectedRevision: number) {
    const { connection, publisher } = ready();
    const { draft } = await load(ownerId, id, expectedRevision);
    if (!['outcome_unknown', 'publishing', 'launching'].includes(draft.state)) throw stateConflict('لا توجد نتيجة معلقة لهذه المسودة.');
    await connection.runForAccount(ownerId, context => { assertAccount(draft, context.customerId); return publisher.reconcile(ownerId, draft, context); });
    return (await load(ownerId, id)).draft;
  }

  async function discard(ownerId: string, id: string, expectedRevision: number) {
    const { draft } = await load(ownerId, id, expectedRevision);
    const next = await move(ownerId, draft, ['preview', 'draft', 'rejected', 'validated', 'verified', 'approved', 'failed'], 'discarded');
    await audit(db, ownerId, id, 'draft_discarded');
    return next;
  }

  /** A trusted, task-scoped adapter may create one new PAUSED campaign. This method can never launch. */
  async function createPausedCampaign(ownerId: string, input: unknown, idempotencyKey: string, authority: { assertActive(): Promise<void> }): Promise<GoogleAdsDraft> {
    if (!/^[a-zA-Z0-9:_-]{8,160}$/.test(idempotencyKey)) throw new GoogleAdsError('GOOGLE_ADS_IDEMPOTENCY', 'يلزم مفتاح ثابت صالح للمهمة.', 400);
    if (!authority || typeof authority.assertActive !== 'function') throw new GoogleAdsError('GOOGLE_ADS_AUTHORITY_REQUIRED', 'يلزم تفويض المهمة الجاري لإنشاء الحملة المتوقفة.', 403);
    await authority.assertActive();
    const { connection } = ready();
    const gates = await publishing(await connection.row(ownerId));
    if (!gates.available) throw new GoogleAdsError('GOOGLE_ADS_PUBLISHING_CLOSED', `إنشاء الحملة مغلق: ${gates.gates.filter(gate => !gate.passed).map(gate => gate.detail).join('؛ ')}`, 403);
    let draft = await createDraft(ownerId, input, idempotencyKey);
    const claimed = await db.insertInto('google_ads_automatic_requests').values({ owner_id: ownerId, idempotency_key: idempotencyKey, draft_id: draft.id, status: 'running' }).onConflict(conflict => conflict.columns(['owner_id', 'idempotency_key']).doNothing()).returning('draft_id').executeTakeFirst();
    // An interrupted/unknown request is never retried automatically. The existing draft is reviewable.
    if (!claimed) return (await load(ownerId, draft.id)).draft;
    try {
      if (draft.state !== 'preview') throw stateConflict('مسار الإنشاء الآلي يقبل معاينة جديدة فقط؛ راجع حالة الطلب السابق.');
      draft = await save(ownerId, draft.id, draft.revision);
      draft = await validate(ownerId, draft.id, draft.revision);
      if (draft.state !== 'validated') throw new GoogleAdsError('GOOGLE_ADS_QUALITY_REJECTED', 'لم تجتز الحملة فحص الجودة؛ لم يُكتب شيء في الحساب.', 409);
      draft = await verify(ownerId, draft.id, draft.revision, true);
      if (draft.state !== 'verified') throw new GoogleAdsError('GOOGLE_ADS_VERIFICATION_REJECTED', 'لم تجتز الحملة التحقق المستقل؛ لم يُكتب شيء في الحساب.', 409);
      await authority.assertActive();
      await audit(db, ownerId, draft.id, 'paused_creation_authorized', { idempotencyKey, draftHash: draft.draftHash, customerId: draft.customerId, conversionTracking: draft.verification?.checks.find(check => check.id === 'conversion_tracking')?.passed === true, launchAuthorized: false });
      draft = await approve(ownerId, draft.id, 'publish', draft.revision, draft.draftHash, draft.customerId);
      // Recheck task fencing and all source-bound gates immediately before the existing single-use writer.
      await authority.assertActive();
      draft = await publish(ownerId, draft.id, draft.revision, () => authority.assertActive());
      if (draft.state !== 'published' || !draft.campaignResourceName) throw new GoogleAdsError('GOOGLE_ADS_PAUSED_UNCONFIRMED', 'لم تؤكد قراءة الحساب إنشاء الحملة متوقفة؛ راجع النتيجة قبل المتابعة.', 409);
      await db.updateTable('google_ads_automatic_requests').set({ status: 'completed', updated_at: new Date() }).where('owner_id', '=', ownerId).where('idempotency_key', '=', idempotencyKey).execute();
      return draft;
    } catch (error) {
      const current = (await load(ownerId, draft.id)).draft;
      await db.updateTable('google_ads_automatic_requests').set({ status: ['publishing', 'outcome_unknown'].includes(current.state) ? 'unknown' : 'blocked', updated_at: new Date() }).where('owner_id', '=', ownerId).where('idempotency_key', '=', idempotencyKey).execute();
      throw error;
    }
  }

  return {
    configured, status, report, market, recommendations, createDraft, createPausedCampaign, revise, save, validate, verify, approve, publish, launch, reconcile, discard,
    authorizationUrl: (ownerId: string) => ready().connection.authorizationUrl(ownerId),
    completeAuthorization: (ownerId: string, code: string, state: string) => ready().connection.completeAuthorization(ownerId, code, state),
    disconnect: (ownerId: string) => ready().connection.disconnect(ownerId),
    listAccounts: (ownerId: string) => ready().connection.listAccounts(ownerId),
    selectAccount: (ownerId: string, customerId: string, loginCustomerId: string | null) => ready().connection.selectAccount(ownerId, customerId, loginCustomerId),
    setBookingRules: (ownerId: string, rules: GoogleAdsBookingRule[]) => ready().connection.setBookingRules(ownerId, rules),
    draft: async (ownerId: string, id: string) => (await load(ownerId, id)).draft,
    drafts: async (ownerId: string) => (await db.selectFrom('google_ads_drafts').selectAll().where('owner_id', '=', ownerId).where('state', '!=', 'discarded').orderBy('updated_at', 'desc').limit(30).execute()).map(toDraft),
    auditLog: async (ownerId: string): Promise<GoogleAdsAuditEntry[]> => (await db.selectFrom('google_ads_audit').selectAll().where('owner_id', '=', ownerId).orderBy('created_at', 'desc').limit(100).execute()).map(row => ({ id: row.id, draftId: row.draft_id, type: row.type, detail: parsed(row.detail), createdAt: iso(row.created_at)! })),
    experiences: async (ownerId: string) => experience.list(ownerId, connection ? (await connection.row(ownerId)).customerId : null),
    /** The hash the owner confirms for launch, derived here so the page never builds it. */
    launchHashFor: (draft: GoogleAdsDraft) => draft.campaignResourceName ? launchHash(draft.customerId, draft.campaignResourceName) : null,
  };
}

export type GoogleAdsControl = ReturnType<typeof createGoogleAdsControl>;
