import { createHash } from 'node:crypto';
import { BrowserError } from '@mohassan/browser';
import type { CampaignCheck, CampaignEventInput, CampaignField, CampaignIssue, CampaignStepStatus, GoogleAdsBrief, GoogleAdsDraft, GoogleAdsIssue, GoogleAdsLanding, GoogleAdsPublishing } from '@mohassan/contracts';
import { ADS_LIMITS, MAX_CORRECTION_PASSES, adsLength, correctAdText, issueCategory, lessonAdvisesAgainst, validateAdText, validateBrief, type CorrectionObserver, type CorrectionPass, type CorrectionResult, type LessonVerifier, type PausedCreationObserver, type RecoveryLesson, type RewriteRequest, type TextInput } from '@mohassan/google-ads';
import { adsApprovedText, adsFailText, adsItemsOf, adsLines, adsPassText, adsTextInput, parseAdsLines, type AdsCheckResult } from './ads-check.js';
import { FAILURE_ACTIONS, backoffDelay, classifyFailure, type ClassifiedFailure } from './recovery.js';

/**
 * The campaign task as the chat runs it: check the text, correct what can be
 * corrected, verify, and only then create one PAUSED campaign and read it back.
 * Every stage is reported as a structured event at the moment it happens. This
 * file decides and reports; each change in the account is still made by the
 * Google Ads control, behind its own gates, approval and single-use receipt.
 */
export interface CampaignPorts {
  parse(text: string, request: string): GoogleAdsBrief;
  /** A read of the landing page, as validation reads it. */
  landing(url: string, signal?: AbortSignal): Promise<{ landing: GoogleAdsLanding; text: string }>;
  gates(ownerId: string): Promise<GoogleAdsPublishing>;
  drafts(ownerId: string): Promise<GoogleAdsDraft[]>;
  createPaused(ownerId: string, brief: GoogleAdsBrief, idempotencyKey: string, authority: { assertActive(): Promise<void> }, observer: PausedCreationObserver): Promise<GoogleAdsDraft>;
  /** Reads the account to settle a write whose result is unknown. Never writes to Google. */
  reconcile(ownerId: string, draftId: string, revision: number): Promise<GoogleAdsDraft>;
  discard(ownerId: string, draftId: string, revision: number): Promise<void>;
  lessons: {
    list(ownerId: string): Promise<RecoveryLesson[]>;
    record(ownerId: string, entry: { category: string; code: string; strategy: string; verifiedBy: LessonVerifier; succeeded: boolean }): Promise<void>;
  };
}

/** Saved with the run, so a resumed run knows what was already tried and whether a write went out. */
export interface CampaignRunState {
  /** Part of the task id. A task that ended is never reopened; the next ads step starts a new one. */
  serial: number;
  open: boolean;
  /** Creation attempts in this run. Each has its own idempotency key, and a key is never reused. */
  attempt: number;
  /** Recorded before the write is sent. Once true, this run never issues another creation key. */
  writeSent: boolean;
  draftId: string | null;
  /** Verified corrections from the text check, applied again to the brief so the account receives what was approved. */
  corrections: { list: keyof TextInput; before: string; after: string | null }[];
  /** How often each unresolved failure was seen in this task; repeats end it instead of looping. */
  seen: Record<string, number>;
}
export const newCampaignRunState = (): CampaignRunState => ({ serial: 0, open: false, attempt: 0, writeSent: false, draftId: null, corrections: [], seen: {} });

export interface CampaignContext {
  ownerId: string;
  runId: string;
  state: CampaignRunState;
  ports: CampaignPorts;
  /** True when the owner's own message asked for a campaign in the account. */
  createInAccount: boolean;
  emit(taskId: string, event: CampaignEventInput, dedupKey?: string): Promise<void>;
  /** Saves `state`. Rejects when the run no longer holds its lease. */
  persist(): Promise<void>;
  assertActive(): Promise<void>;
  signal: AbortSignal;
  /** Absent when no model is configured for corrections. */
  rewrite?: (request: RewriteRequest, signal?: AbortSignal) => Promise<string>;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

export const MAX_SAME_FAILURE = 3;
export const MAX_CREATE_ATTEMPTS = 3;
/** Waits before each account read after an unconfirmed write, so a request still in flight can land. */
export const READBACK_DELAYS_MS: readonly number[] = [1500, 4000, 8000];
/** A write this recent may still be running in another conversation; it is not ours to settle yet. */
const IN_FLIGHT_MS = 90_000;
/** The same campaign confirmed in the account this recently is reported, not created a second time. */
const DUPLICATE_WINDOW_MS = 10 * 60_000;
const LISTS = ['headlines', 'descriptions', 'paths', 'keywords', 'negativeKeywords'] as const;
const COPY: readonly ['headline' | 'description' | 'path', 'headlines' | 'descriptions' | 'paths', number, number][] = [['headline', 'headlines', ADS_LIMITS.headline, 20], ['description', 'descriptions', ADS_LIMITS.description, 8], ['path', 'paths', ADS_LIMITS.path, 3]];

export const campaignTaskId = (runId: string, serial: number) => `campaign-${runId}-${serial}`;
const taskIdOf = (ctx: CampaignContext) => campaignTaskId(ctx.runId, ctx.state.serial);
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const defaultSleep = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
  const timer = setTimeout(finish, milliseconds);
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
  signal.addEventListener('abort', abort, { once: true });
});

const errorsOf = (issues: readonly GoogleAdsIssue[]) => issues.filter(issue => issue.severity === 'error');
const toIssues = (issues: readonly GoogleAdsIssue[]): CampaignIssue[] => errorsOf(issues).slice(0, 40).map(issue => ({ code: issue.code.slice(0, 60), field: (issue.field || 'draft').slice(0, 40), category: issueCategory(issue.code), message: issue.message.slice(0, 400) }));

function fieldsOf(input: TextInput, issues: readonly GoogleAdsIssue[], corrected: ReadonlySet<string> = new Set()): CampaignField[] {
  return COPY.flatMap(([kind, list, limit, shown]) => input[list].slice(0, shown).map((text, index): CampaignField => {
    const own = errorsOf(issues).filter(issue => issue.field === `${kind} ${index + 1}`);
    return { kind, index: index + 1, text: text.slice(0, 200), length: adsLength(text), limit, status: own.length ? 'invalid' : corrected.has(text) ? 'corrected' : 'valid', issues: [...new Set(own.map(issue => issue.code.slice(0, 60)))].slice(0, 12) };
  }));
}

/** The local text verdict, one check per rule family, each with the limit it applied. */
function textChecks(input: TextInput, issues: readonly GoogleAdsIssue[]): CampaignCheck[] {
  const errors = errorsOf(issues);
  const failing = (test: (issue: GoogleAdsIssue) => boolean) => [...new Set(errors.filter(test).map(issue => `${issue.field}: ${issue.code}`))];
  const check = (id: string, problems: string[], passed: string): CampaignCheck => ({ id, passed: !problems.length, detail: (problems.length ? problems.join(', ') : passed).slice(0, 600) });
  const limit = (kind: string) => failing(issue => issue.code === 'TOO_LONG' && issue.field.startsWith(kind));
  return [
    check('headline_limit', limit('headline'), `${input.headlines.length} headlines, each within ${ADS_LIMITS.headline} characters`),
    check('description_limit', limit('description'), `${input.descriptions.length} descriptions, each within ${ADS_LIMITS.description} characters`),
    check('path_limit', limit('path'), `${input.paths.length} paths, each within ${ADS_LIMITS.path} characters`),
    check('required_assets', failing(issue => ['TOO_FEW', 'TOO_MANY', 'EMPTY', 'DUPLICATE'].includes(issue.code) && !issue.field.includes('keyword')), `${ADS_LIMITS.minHeadlines}-${ADS_LIMITS.maxHeadlines} headlines, ${ADS_LIMITS.minDescriptions}-${ADS_LIMITS.maxDescriptions} descriptions, up to ${ADS_LIMITS.maxPaths} paths`),
    check('business_claims', failing(issue => issueCategory(issue.code) === 'factual_claim'), 'every offer in the text was stated by the owner or the landing page'),
    check('editorial_policy', failing(issue => issueCategory(issue.code) === 'policy'), 'no punctuation, capitals, symbols, phone numbers or web addresses Google refuses'),
    check('keywords', failing(issue => issue.field.includes('keyword')), `${input.keywords.length} keywords and ${input.negativeKeywords.length} negative keywords in valid syntax`),
  ];
}

function landingChecks(url: string, landing: GoogleAdsLanding, issues: readonly GoogleAdsIssue[]): CampaignCheck[] {
  const has = (code: string) => issues.some(issue => issue.code === code);
  return [
    { id: 'https', passed: url.startsWith('https://'), detail: url.startsWith('https://') ? 'the destination uses HTTPS' : 'the destination must use HTTPS' },
    { id: 'reachable', passed: landing.reachable, detail: landing.reachable ? `the page answered HTTP ${landing.status}` : `the page did not load${landing.status ? ` (HTTP ${landing.status})` : ''}` },
    { id: 'same_site', passed: !has('LANDING_REDIRECT'), detail: has('LANDING_REDIRECT') ? 'the page redirects to another site' : 'the page stays on the destination site' },
    { id: 'language', passed: !has('LANDING_LANGUAGE_MISMATCH'), detail: landing.language ? `the page declares language ${landing.language.slice(0, 20)}` : 'the page declares no language' },
    { id: 'keyword_relevance', passed: !has('LANDING_RELEVANCE'), detail: has('LANDING_RELEVANCE') ? 'no keyword appears on the page, which can lower ad quality' : 'at least one keyword appears on the page' },
  ];
}

async function begin(ctx: CampaignContext) {
  if (ctx.state.open) return;
  Object.assign(ctx.state, { serial: ctx.state.serial + 1, open: true, seen: {} });
  await ctx.persist();
  await ctx.emit(taskIdOf(ctx), { type: 'task_started', stepId: 'intent', status: 'passed', data: { kind: 'google_ads_search_campaign', createInAccount: ctx.createInAccount } }, 'task_started');
}

async function learn(ctx: CampaignContext, entry: { category: string; code: string; strategy: string; verifiedBy: LessonVerifier; succeeded: boolean }) {
  // Memory is an aid: failing to write a lesson must never fail the task.
  try { await ctx.ports.lessons.record(ctx.ownerId, entry); } catch { ctx.signal.throwIfAborted(); }
}

async function learnPass(ctx: CampaignContext, pass: CorrectionPass) {
  for (const { code, cleared } of pass.codes) await learn(ctx, { category: issueCategory(code), code, strategy: pass.strategy, verifiedBy: 'local_validator', succeeded: cleared });
  if (pass.failure) await learn(ctx, { category: 'model_output', code: pass.failure, strategy: pass.strategy, verifiedBy: 'local_validator', succeeded: false });
}

const correctionObserver = (ctx: CampaignContext): CorrectionObserver => ({
  validationFailed: (issues, fingerprint) => ctx.emit(taskIdOf(ctx), { type: 'validation_failed', stepId: 'local_validation', status: 'failed', data: { authority: 'local', scope: 'local_text', issues: toIssues(issues), fingerprint } }),
  passStarted: pass => ctx.emit(taskIdOf(ctx), { type: 'correction_started', stepId: 'correction', status: 'running', data: { attempt: pass.attempt, maxAttempts: MAX_CORRECTION_PASSES, strategy: pass.strategy, targets: pass.targets.slice(0, 40) } }),
  passCompleted: async pass => {
    const status: CampaignStepStatus = !pass.remaining || pass.changes.some(change => change.verified) ? 'corrected' : 'failed';
    await ctx.emit(taskIdOf(ctx), { type: 'correction_completed', stepId: 'correction', status, data: { attempt: pass.attempt, strategy: pass.strategy, changes: pass.changes.slice(0, 40), remaining: pass.remaining, failure: pass.failure } });
    await learnPass(ctx, pass);
  },
});

async function correct(ctx: CampaignContext, input: TextInput, validate: (candidate: TextInput) => GoogleAdsIssue[], evidence: string, adLanguage: string | null): Promise<CorrectionResult> {
  // History only reorders strategies that are allowed anyway; it cannot add one or lift a gate.
  const lessons = await ctx.ports.lessons.list(ctx.ownerId).catch(() => [] as RecoveryLesson[]);
  return correctAdText(input, {
    validate, evidence, adLanguage, signal: ctx.signal, observer: correctionObserver(ctx),
    ...(ctx.rewrite ? { rewrite: ctx.rewrite } : {}), skipRewrite: code => lessonAdvisesAgainst(lessons, code, 'model_rewrite'),
  });
}

async function fail(ctx: CampaignContext, failure: Pick<ClassifiedFailure, 'category' | 'code' | 'message' | 'retryable' | 'retryAfterMs' | 'strategy'>, options: { reconciliationRequired?: boolean; action?: string } = {}) {
  await ctx.emit(taskIdOf(ctx), { type: 'task_failed', stepId: 'outcome', status: options.reconciliationRequired ? 'unknown' : 'failed', data: {
    category: failure.category, code: failure.code, message: failure.message.slice(0, 600), action: (options.action ?? FAILURE_ACTIONS[failure.category]).slice(0, 400), retryable: failure.retryable,
    retryAfterSeconds: failure.retryAfterMs === null ? null : Math.ceil(failure.retryAfterMs / 1000), reconciliationRequired: options.reconciliationRequired === true, strategy: failure.strategy,
  } });
  ctx.state.open = false;
  await ctx.persist();
}

/** Counts a failure that survived correction. The same one a third time ends the task instead of looping. */
async function repeated(ctx: CampaignContext, fingerprint: string, issues: readonly GoogleAdsIssue[]): Promise<number> {
  const count = ctx.state.seen[fingerprint] = (ctx.state.seen[fingerprint] ?? 0) + 1;
  if (count < MAX_SAME_FAILURE) { await ctx.persist(); return count; }
  const category = issues[0] ? issueCategory(issues[0].code) : 'schema';
  const message = 'تكرر الخطأ نفسه في نص الحملة بعد كل محاولات التصحيح، فتوقفت بدل التكرار. لم يُكتب شيء في حساب الإعلانات.';
  await fail(ctx, { category, code: 'ADS_CORRECTION_EXHAUSTED', message, retryable: false, retryAfterMs: null, strategy: 'ask_owner' });
  throw new BrowserError('ADS_CORRECTION_EXHAUSTED', message, 409);
}

const changeNote = (result: CorrectionResult) => result.changes.filter(change => change.verified).map(change => `- ${change.field} (${change.reasonCode}): ${JSON.stringify(change.before)} -> ${change.after === null ? 'removed' : JSON.stringify(change.after)}`).join('\n');

/**
 * The chat's text check with self-correction. PASS is returned only when the
 * validator accepts the final text; `corrected` text is what later steps must use.
 */
export async function checkCampaignDraft(ctx: CampaignContext, draft: string, evidence: string): Promise<AdsCheckResult> {
  const { items, problems, total } = parseAdsLines(draft);
  await begin(ctx);
  const emit = (event: CampaignEventInput) => ctx.emit(taskIdOf(ctx), event);
  if (problems.length) {
    // An unreadable line is the model's format error: there is no text yet to correct.
    const fingerprint = hash(problems.join('\n'));
    await emit({ type: 'validation_failed', stepId: 'draft', status: 'failed', data: { authority: 'local', scope: 'local_text', fingerprint, issues: problems.slice(0, 40).map(message => ({ code: 'LINE_UNREADABLE', field: 'draft', category: 'schema' as const, message: message.slice(0, 400) })) } });
    await repeated(ctx, fingerprint, []);
    return { passed: false, approved: null, text: adsFailText(problems, draft) };
  }
  const input = adsTextInput(items);
  const validate = (candidate: TextInput) => validateAdText(candidate, evidence);
  await emit({ type: 'draft_updated', stepId: 'draft', status: 'passed', data: { fields: fieldsOf(input, validate(input)), keywords: input.keywords.length, negativeKeywords: input.negativeKeywords.length, source: 'model_draft' } });
  await emit({ type: 'step_started', stepId: 'local_validation', status: 'running', data: {} });
  const result = await correct(ctx, input, validate, evidence, null);
  if (result.status !== 'clean') await emit({ type: 'draft_updated', stepId: 'draft', status: 'passed', data: { fields: fieldsOf(result.input, result.remaining, new Set(result.changes.flatMap(change => change.after ?? []))), keywords: result.input.keywords.length, negativeKeywords: result.input.negativeKeywords.length, source: 'corrected_draft' } });
  const passed = result.status !== 'unresolved';
  await emit({ type: 'verification_completed', stepId: 'local_validation', status: passed ? 'passed' : 'failed', data: { authority: 'local', scope: 'local_text', passed, checks: textChecks(result.input, result.remaining) } });
  const corrected = adsItemsOf(result.input), lines = adsLines(corrected), note = changeNote(result);
  if (!passed) {
    const count = await repeated(ctx, result.fingerprint, result.remaining);
    const messages = result.remaining.map(issue => issue.message);
    const again = count > 1 ? '\nThis is the same failure as before. Change those lines in a different way, or use ask_user to ask the owner.' : '';
    return { passed: false, approved: null, text: `${adsFailText(messages, '')}${note ? `\nThe program already corrected and verified these, keep them:\n${note}` : ''}\nContinue from this draft and fix only what is listed above:\n${lines}${again}` };
  }
  ctx.state.corrections = [...ctx.state.corrections, ...result.changes.filter(change => change.verified).map(change => ({ list: listOf(change.field), before: change.before, after: change.after }))].slice(-60);
  await ctx.persist();
  if (result.status === 'clean') return { passed: true, approved: adsApprovedText(items), text: adsPassText(total, draft) };
  const count = LISTS.reduce((sum, list) => sum + result.input[list].length, 0);
  return { passed: true, approved: adsApprovedText(corrected), text: `${adsPassText(count, lines)}\nThe program corrected these items and the validator accepted each one. Use the corrected text above, not your original:\n${note}` };
}

const listOf = (field: string): keyof TextInput => field.startsWith('negative keyword') ? 'negativeKeywords' : field.startsWith('keyword') ? 'keywords' : field.startsWith('description') ? 'descriptions' : field.startsWith('path') ? 'paths' : 'headlines';

/** Replays verified corrections on text the model sent again unchanged. Text it already fixed is left alone. */
function applyCorrections(brief: GoogleAdsBrief, corrections: CampaignRunState['corrections']): GoogleAdsBrief {
  const next = { ...brief };
  for (const list of LISTS) next[list] = brief[list].flatMap(text => {
    const known = corrections.find(entry => entry.list === list && entry.before === text);
    return known ? known.after === null ? [] : [known.after] : [text];
  });
  return next;
}

const sameCampaign = (first: GoogleAdsBrief, second: GoogleAdsBrief) => [first.service, first.landingPageUrl, first.locations[0] ?? ''].join('|').toLocaleLowerCase() === [second.service, second.landingPageUrl, second.locations[0] ?? ''].join('|').toLocaleLowerCase();

type Settled = { outcome: 'confirmed_paused' | 'confirmed_absent' | 'mismatch' | 'reconciliation_required'; draft: GoogleAdsDraft; reads: number };

/** Settles a write whose result is unknown by reading the account. It never writes, so it is safe to repeat. */
async function reconcile(ctx: CampaignContext, pending: GoogleAdsDraft): Promise<Settled> {
  const emit = (event: CampaignEventInput) => ctx.emit(taskIdOf(ctx), event);
  await emit({ type: 'external_operation_started', stepId: 'readback', status: 'running', data: { operation: 'readback', mutates: false, attempt: 1 } });
  let draft = pending, reads = 0;
  for (const delay of READBACK_DELAYS_MS) {
    await (ctx.sleep ?? defaultSleep)(delay, ctx.signal);
    await ctx.assertActive();
    reads += 1;
    try { draft = await ctx.ports.reconcile(ctx.ownerId, draft.id, draft.revision); break; } catch (error) {
      ctx.signal.throwIfAborted();
      // Only a transient read failure is worth another read; sign-in or permission problems are not.
      if (!classifyFailure(error).retryable) break;
    }
  }
  const outcome: Settled['outcome'] = draft.state === 'published' && draft.campaignResourceName ? 'confirmed_paused' : draft.state === 'draft' ? 'confirmed_absent' : draft.state === 'failed' ? 'mismatch' : 'reconciliation_required';
  const status: CampaignStepStatus = outcome === 'confirmed_paused' ? 'passed' : outcome === 'reconciliation_required' ? 'unknown' : 'failed';
  await emit({ type: 'external_operation_reconciled', stepId: 'readback', status, data: { operation: 'create_paused', outcome, campaignResourceName: draft.campaignResourceName, readAttempts: reads } });
  await learn(ctx, { category: 'verification', code: 'GOOGLE_ADS_OUTCOME_UNKNOWN', strategy: 'reconcile_by_readback', verifiedBy: 'google_readback', succeeded: outcome !== 'reconciliation_required' });
  return { outcome, draft, reads };
}

const readbackChecks = (draft: GoogleAdsDraft): CampaignCheck[] => [
  { id: 'campaign_identity', passed: true, detail: `the account returned ${draft.campaignResourceName} under the expected name ${JSON.stringify(draft.summary?.campaignName ?? '')}`.slice(0, 600) },
  { id: 'status_paused', passed: true, detail: 'the account reports the campaign as PAUSED; it is not running and spends nothing' },
  { id: 'daily_budget', passed: true, detail: `the account reports the approved daily budget of ${draft.summary?.dailyBudgetMicros ?? '?'} micros` },
];

async function complete(ctx: CampaignContext, draft: GoogleAdsDraft, outcome: 'paused_campaign_created' | 'paused_campaign_recovered') {
  const tracking = draft.verification?.checks.find(check => check.id === 'conversion_tracking')?.passed ?? null;
  await ctx.emit(taskIdOf(ctx), { type: 'task_completed', stepId: 'outcome', status: 'passed', data: { outcome, campaignResourceName: draft.campaignResourceName, conversionTrackingProven: tracking, launchRequiresApproval: true } });
  ctx.state.open = false;
  await ctx.persist();
  return `Google Ads readback confirmed ${outcome === 'paused_campaign_recovered' ? 'the campaign from the earlier request' : 'new campaign'} ${draft.campaignResourceName} in PAUSED state. Draft ${draft.id}. It is not running. Only the owner can approve launch separately. ${tracking ? 'Conversion tracking verified.' : 'Conversion tracking must be verified before launch.'}`;
}

/** Ends the task for a write that was sent but could not be confirmed as the approved PAUSED campaign. */
async function afterReconcile(ctx: CampaignContext, settled: Settled): Promise<string> {
  if (settled.outcome === 'confirmed_paused') {
    await ctx.emit(taskIdOf(ctx), { type: 'verification_completed', stepId: 'readback', status: 'passed', data: { authority: 'google_ads_api', scope: 'readback', passed: true, checks: readbackChecks(settled.draft) } });
    return complete(ctx, settled.draft, 'paused_campaign_recovered');
  }
  const unknown = settled.outcome === 'reconciliation_required';
  const [code, message, action] = unknown
    ? ['ADS_RECONCILIATION_REQUIRED', 'أُرسل طلب إنشاء الحملة لكن لم تتأكد نتيجته من الحساب. لن يُعاد الطلب قبل قراءة الحساب.', 'افتح قسم Google Ads واضغط «مراجعة النتيجة» لهذه المسودة، أو أعد الطلب لاحقًا وسأقرأ الحساب أولًا.']
    : settled.outcome === 'confirmed_absent'
      ? ['ADS_CREATION_CONFIRMED_ABSENT', 'قرأت الحساب وتأكدت أن الحملة لم تُنشأ. لم أكرر الكتابة تلقائيًا.', 'أعد طلب إنشاء الحملة، أو أعد التحقق والموافقة على المسودة من قسم Google Ads.']
      : ['ADS_CAMPAIGN_MISMATCH', 'وُجدت حملة بالاسم المتوقع لكنها لا تطابق ما وُوفق عليه. لم أغيّر شيئًا فيها.', 'راجع الحملة في Google Ads قبل أي طلب جديد.'];
  await fail(ctx, { category: 'verification', code, message, retryable: false, retryAfterMs: null, strategy: unknown ? 'reconcile_by_readback' : 'ask_owner' }, { reconciliationRequired: unknown, action });
  throw new BrowserError(code, message, 409);
}

/**
 * An earlier write whose result was never read blocks every new one. It is read
 * first; a new campaign is created only when the account answered about the old one.
 */
async function settleEarlierWrites(ctx: CampaignContext, brief: GoogleAdsBrief): Promise<string | null> {
  const open = (await ctx.ports.drafts(ctx.ownerId)).filter(draft => draft.state === 'publishing' || draft.state === 'outcome_unknown');
  for (const pending of open) {
    if (pending.state === 'publishing' && Date.now() - Date.parse(pending.updatedAt) < IN_FLIGHT_MS) {
      const message = 'يوجد طلب إنشاء حملة ما زال قيد التنفيذ. انتظر دقيقة ثم أعد الطلب.';
      await fail(ctx, { category: 'verification', code: 'ADS_WRITE_IN_PROGRESS', message, retryable: false, retryAfterMs: IN_FLIGHT_MS, strategy: 'stop_and_report' });
      throw new BrowserError('ADS_WRITE_IN_PROGRESS', message, 409);
    }
    const settled = await reconcile(ctx, pending);
    if (settled.outcome === 'reconciliation_required' || sameCampaign(settled.draft.brief, brief) && settled.outcome !== 'confirmed_absent') return afterReconcile(ctx, settled);
  }
  // A run that was stopped mid-write may have finished in the account without ever reporting it here.
  const recent = (await ctx.ports.drafts(ctx.ownerId)).find(draft => draft.state === 'published' && draft.campaignResourceName && sameCampaign(draft.brief, brief) && Date.now() - Date.parse(draft.updatedAt) < DUPLICATE_WINDOW_MS);
  if (recent) {
    await ctx.emit(taskIdOf(ctx), { type: 'external_operation_reconciled', stepId: 'readback', status: 'passed', data: { operation: 'create_paused', outcome: 'confirmed_paused', campaignResourceName: recent.campaignResourceName, readAttempts: 0 } });
    return complete(ctx, recent, 'paused_campaign_recovered');
  }
  return null;
}

function creationObserver(ctx: CampaignContext, attempt: number, correctedTexts: ReadonlySet<string>): PausedCreationObserver {
  const emit = (event: CampaignEventInput, key: string) => ctx.emit(taskIdOf(ctx), event, `a${attempt}:${key}`);
  return { async stage(stage, draft) {
    if (stage === 'draft_ready' && draft) {
      ctx.state.draftId = draft.id;
      await ctx.persist();
      await emit({ type: 'draft_updated', stepId: 'draft', status: 'passed', data: { fields: fieldsOf(draft.brief, [], correctedTexts), keywords: draft.brief.keywords.length, negativeKeywords: draft.brief.negativeKeywords.length, source: 'saved_draft' } }, stage);
    }
    if (stage === 'validated' && draft?.validation && !draft.validation.passed) await emit({ type: 'validation_failed', stepId: 'local_validation', status: 'failed', data: { authority: 'local', scope: 'local_text', issues: toIssues(draft.validation.issues), fingerprint: hash(draft.validation.issues.map(issue => `${issue.code}|${issue.field}`).sort().join('\n')) } }, stage);
    if (stage === 'verification_started') await emit({ type: 'external_operation_started', stepId: 'remote_validation', status: 'running', data: { operation: 'validate_only', mutates: false, attempt } }, stage);
    if (stage === 'verified' && draft?.verification) {
      const checks = draft.verification.checks, pick = (...ids: string[]) => checks.filter(check => ids.includes(check.id)).map(check => ({ id: check.id, passed: check.passed, detail: check.detail.slice(0, 600) }));
      const report = async (scope: 'draft_integrity' | 'account' | 'conversion_tracking' | 'google_validate_only', authority: 'local' | 'google_ads_api', ids: string[], step: boolean) => {
        const own = pick(...ids);
        if (!own.length) return;
        const passed = own.every(check => check.passed);
        await emit({ type: 'verification_completed', stepId: step ? 'remote_validation' : null, status: passed ? 'passed' : 'failed', data: { authority, scope, passed, checks: own } }, `${stage}:${scope}`);
      };
      // The integrity check reads the operations locally; the other three are answers from the account.
      await report('draft_integrity', 'local', ['draft_correctness'], false);
      await report('account', 'google_ads_api', ['existing_resources_preserved', 'account_permissions'], false);
      await report('conversion_tracking', 'google_ads_api', ['conversion_tracking'], false);
      await report('google_validate_only', 'google_ads_api', ['google_validate_only'], true);
    }
    if (stage === 'authorized') await emit({ type: 'approval_required', stepId: 'approval', status: 'passed', data: { kind: 'publication_gates', satisfied: true, ownerRequested: true, gates: [{ id: 'single_use_approval', passed: true, detail: 'a single-use approval bound to this exact draft hash and account was recorded' }] } }, stage);
    if (stage === 'mutation_started') {
      // Recorded and saved first. If either fails, the control does not send the write.
      ctx.state.writeSent = true;
      await ctx.persist();
      await emit({ type: 'external_operation_started', stepId: 'paused_creation', status: 'running', data: { operation: 'create_paused', mutates: true, attempt } }, stage);
    }
    if (stage === 'readback_confirmed' && draft) {
      await emit({ type: 'external_operation_reconciled', stepId: 'paused_creation', status: 'passed', data: { operation: 'create_paused', outcome: 'confirmed_paused', campaignResourceName: draft.campaignResourceName, readAttempts: 1 } }, stage);
      await emit({ type: 'verification_completed', stepId: 'readback', status: 'passed', data: { authority: 'google_ads_api', scope: 'readback', passed: true, checks: readbackChecks(draft) } }, `${stage}:checks`);
    }
  } };
}

/**
 * Creates one PAUSED campaign for the owner's explicit request. Nothing is sent
 * to the account until the text passed, the landing page was read, every
 * publication gate is open and Google accepted the request in validate-only mode.
 * A failure before the write may be retried with a fresh key; after the write,
 * the only next step is reading the account.
 */
export async function createPausedCampaign(ctx: CampaignContext, text: string, request: string, baseKey: string): Promise<string> {
  await begin(ctx);
  const emit = (event: CampaignEventInput, key?: string) => ctx.emit(taskIdOf(ctx), event, key);
  if (ctx.state.writeSent) {
    const message = 'أُرسل طلب إنشاء حملة في هذه المهمة من قبل. لا أرسل طلبًا ثانيًا في المهمة نفسها؛ راجع النتيجة ثم اطلب من جديد.';
    await fail(ctx, { category: 'verification', code: 'ADS_WRITE_ALREADY_SENT', message, retryable: false, retryAfterMs: null, strategy: 'ask_owner' });
    throw new BrowserError('ADS_WRITE_ALREADY_SENT', message, 409);
  }
  let brief: GoogleAdsBrief;
  try { brief = ctx.ports.parse(text, request); } catch (error) {
    const failure = classifyFailure(error), detail = error instanceof Error ? error.message.slice(0, 400) : 'the draft could not be read';
    const fingerprint = hash(detail);
    await emit({ type: 'validation_failed', stepId: 'draft', status: 'failed', data: { authority: 'local', scope: 'local_text', fingerprint, issues: [{ code: failure.code, field: 'draft', category: 'schema', message: detail }] } });
    await repeated(ctx, fingerprint, []);
    throw error;
  }
  brief = applyCorrections(brief, ctx.state.corrections);
  const earlier = await settleEarlierWrites(ctx, brief);
  if (earlier) return earlier;

  await emit({ type: 'step_started', stepId: 'landing_page', status: 'running', data: {} });
  const page = await ctx.ports.landing(brief.landingPageUrl, ctx.signal);
  const evidence = [...brief.ownerFacts, brief.businessName, brief.service, page.text].join('\n');
  const validate = (candidate: TextInput) => validateBrief({ ...brief, ...candidate }, page.landing, page.text);
  const found = validate(brief);
  await emit({ type: 'draft_updated', stepId: 'draft', status: 'passed', data: { fields: fieldsOf(brief, found), keywords: brief.keywords.length, negativeKeywords: brief.negativeKeywords.length, source: 'model_draft' } });
  const landingPassed = !errorsOf(found).some(issue => issueCategory(issue.code) === 'landing_page');
  await emit({ type: 'verification_completed', stepId: 'landing_page', status: landingPassed ? 'passed' : 'failed', data: { authority: 'local', scope: 'landing_page', passed: landingPassed, checks: landingChecks(brief.landingPageUrl, page.landing, found) } });
  await emit({ type: 'step_started', stepId: 'local_validation', status: 'running', data: {} });
  const result = await correct(ctx, brief, validate, evidence, brief.adLanguage);
  const corrected: GoogleAdsBrief = { ...brief, ...result.input };
  const correctedTexts = new Set(result.changes.flatMap(change => change.after ?? []));
  if (result.status !== 'clean') await emit({ type: 'draft_updated', stepId: 'draft', status: 'passed', data: { fields: fieldsOf(corrected, result.remaining, correctedTexts), keywords: corrected.keywords.length, negativeKeywords: corrected.negativeKeywords.length, source: 'corrected_draft' } });
  const textPassed = result.status !== 'unresolved';
  await emit({ type: 'verification_completed', stepId: 'local_validation', status: textPassed ? 'passed' : 'failed', data: { authority: 'local', scope: 'local_text', passed: textPassed, checks: textChecks(corrected, result.remaining) } });
  if (!textPassed) {
    const landingIssue = result.remaining.find(issue => issueCategory(issue.code) === 'landing_page');
    if (landingIssue) {
      // No rewrite of the ad can repair the page it points to; this is the owner's to fix.
      const message = 'صفحة الهبوط لم تجتز الفحص، فلم يُكتب شيء في حساب الإعلانات.';
      await fail(ctx, { category: 'landing_page', code: landingIssue.code, message, retryable: false, retryAfterMs: null, strategy: 'ask_owner' });
      throw new BrowserError(landingIssue.code, `${message} ${landingIssue.message}`.slice(0, 600), 409);
    }
    await repeated(ctx, result.fingerprint, result.remaining);
    throw new BrowserError('ADS_QUALITY_UNRESOLVED', `The campaign did not pass the quality check and nothing was written to the account. Fix these and call the tool again:\n${result.remaining.slice(0, 20).map(issue => `- ${issue.message}`).join('\n')}${changeNote(result) ? `\nAlready corrected and verified, keep them:\n${changeNote(result)}` : ''}`, 409);
  }

  const gates = await ctx.ports.gates(ctx.ownerId);
  await emit({ type: 'approval_required', stepId: 'approval', status: gates.available ? 'running' : 'failed', data: { kind: 'publication_gates', satisfied: gates.available, ownerRequested: true, gates: gates.gates.slice(0, 12).map(gate => ({ id: gate.id.slice(0, 60), passed: gate.passed, detail: gate.detail.slice(0, 600) })) } });
  if (!gates.available) {
    const message = `إنشاء الحملة مغلق: ${gates.gates.filter(gate => !gate.passed).map(gate => gate.detail).join('؛ ')}`.slice(0, 600);
    await fail(ctx, { category: 'permissions', code: 'GOOGLE_ADS_PUBLISHING_CLOSED', message, retryable: false, retryAfterMs: null, strategy: 'stop_and_report' });
    throw new BrowserError('GOOGLE_ADS_PUBLISHING_CLOSED', message, 403);
  }

  const lessons = await ctx.ports.lessons.list(ctx.ownerId).catch(() => [] as RecoveryLesson[]);
  let retried: ClassifiedFailure | null = null;
  for (;;) {
    await ctx.assertActive();
    const attempt = ctx.state.attempt += 1;
    ctx.state.draftId = null;
    await ctx.persist();
    let draft: GoogleAdsDraft | null = null, failure: ClassifiedFailure, cause: unknown;
    try {
      draft = await ctx.ports.createPaused(ctx.ownerId, corrected, attempt === 1 ? baseKey : `${baseKey}-r${attempt}`, { assertActive: ctx.assertActive }, creationObserver(ctx, attempt, correctedTexts));
      if (draft.state === 'published' && draft.campaignResourceName) {
        // Google's own validate-only pass is the stronger witness for the corrections that reached it.
        for (const change of result.changes.filter(item => item.verified)) await learn(ctx, { category: change.category, code: change.reasonCode, strategy: change.strategy, verifiedBy: 'google_validate_only', succeeded: true });
        if (retried) await learn(ctx, { category: retried.category, code: retried.code, strategy: retried.strategy, verifiedBy: 'google_readback', succeeded: true });
        return complete(ctx, draft, 'paused_campaign_created');
      }
      cause = new BrowserError('GOOGLE_ADS_PAUSED_UNCONFIRMED', 'لم تؤكد قراءة الحساب إنشاء الحملة متوقفة.', 409);
    } catch (error) { cause = error; }
    ctx.signal.throwIfAborted();
    // A run that lost its lease reports nothing more: whoever ended it writes the terminal event.
    await ctx.assertActive();
    failure = classifyFailure(cause);
    const current = draft ?? (ctx.state.draftId ? (await ctx.ports.drafts(ctx.ownerId).catch(() => [] as GoogleAdsDraft[])).find(item => item.id === ctx.state.draftId) ?? null : null);

    if (ctx.state.writeSent) {
      // The write went out. From here only the account can say what happened; nothing is sent again.
      if (current && (current.state === 'publishing' || current.state === 'outcome_unknown')) return afterReconcile(ctx, await reconcile(ctx, current));
      if (current?.state === 'published' && current.campaignResourceName) return complete(ctx, current, 'paused_campaign_recovered');
      if (current?.state === 'draft') return afterReconcile(ctx, { outcome: 'confirmed_absent', draft: current, reads: 1 });
      if (current?.state === 'failed' && current.campaignResourceName) return afterReconcile(ctx, { outcome: 'mismatch', draft: current, reads: 1 });
      if (current?.state === 'failed') {
        // Google answered and refused: nothing was applied, so there is nothing to reconcile.
        await emit({ type: 'external_operation_reconciled', stepId: 'paused_creation', status: 'failed', data: { operation: 'create_paused', outcome: 'rejected', campaignResourceName: null, readAttempts: 0 } });
        await fail(ctx, { ...failure, retryable: false, strategy: 'stop_and_report' });
        throw new BrowserError(failure.code, failure.message, 409);
      }
      const message = 'أُرسل طلب إنشاء الحملة لكن تعذر تحديد نتيجته. لن يُعاد الطلب قبل قراءة الحساب.';
      await fail(ctx, { category: 'verification', code: 'ADS_RECONCILIATION_REQUIRED', message, retryable: false, retryAfterMs: null, strategy: 'reconcile_by_readback' }, { reconciliationRequired: true });
      throw new BrowserError('ADS_RECONCILIATION_REQUIRED', message, 409);
    }

    // Nothing was written. The failure decides what happens next.
    if (failure.strategy === 'reauthenticate') throw new BrowserError('ADS_CONNECT_REQUIRED', 'يلزم تسجيل الدخول إلى Google Ads أولًا.', 409);
    if (failure.code === 'GOOGLE_ADS_QUALITY_REJECTED' && current?.validation) {
      const issues = errorsOf(current.validation.issues);
      await repeated(ctx, hash(issues.map(issue => `${issue.code}|${issue.field}`).sort().join('\n')), issues);
      throw new BrowserError('ADS_QUALITY_UNRESOLVED', `The campaign did not pass the quality check and nothing was written to the account. Fix these and call the tool again:\n${issues.slice(0, 20).map(issue => `- ${issue.message}`).join('\n')}`, 409);
    }
    const mayRetry = failure.retryable && attempt < MAX_CREATE_ATTEMPTS && !lessonAdvisesAgainst(lessons, failure.code, failure.strategy);
    if (!mayRetry) {
      if (failure.retryable) await learn(ctx, { category: failure.category, code: failure.code, strategy: failure.strategy, verifiedBy: 'google_readback', succeeded: false });
      const rejectedByGoogle = failure.code === 'GOOGLE_ADS_VERIFICATION_REJECTED';
      await fail(ctx, rejectedByGoogle ? { ...failure, category: 'policy', message: `${failure.message} ${current?.verification?.checks.filter(check => !check.passed && check.id !== 'conversion_tracking').map(check => check.detail).join(' | ') ?? ''}`.trim() } : failure);
      throw new BrowserError(failure.code, failure.message, 409);
    }
    // The blocked draft of this attempt never reached Google; it is removed so the list shows only real work.
    if (current && ['preview', 'draft', 'rejected', 'validated', 'verified', 'approved', 'failed'].includes(current.state)) await ctx.ports.discard(ctx.ownerId, current.id, current.revision).catch(() => undefined);
    retried = failure;
    await emit({ type: 'step_started', stepId: 'remote_validation', status: 'running', data: { attempt: attempt + 1 } });
    await (ctx.sleep ?? defaultSleep)(backoffDelay(attempt, failure, ctx.random ? { random: ctx.random } : {}), ctx.signal);
  }
}

/** What to record when the conversation ends while a campaign task is still open. */
export function campaignEndEvent(state: CampaignRunState | undefined, textApproved: boolean): CampaignEventInput | null {
  if (!state?.open) return null;
  if (textApproved) return { type: 'task_completed', stepId: 'outcome', status: 'passed', data: { outcome: 'draft_checked', campaignResourceName: null, conversionTrackingProven: null, launchRequiresApproval: true } };
  return { type: 'task_failed', stepId: 'outcome', status: 'failed', data: { category: 'verification', code: 'ADS_TASK_INCOMPLETE', message: 'انتهى الرد قبل أن يجتاز نص الحملة الفحص. لم يُكتب شيء في حساب الإعلانات.', action: FAILURE_ACTIONS.verification, retryable: false, retryAfterSeconds: null, reconciliationRequired: false, strategy: 'ask_owner' } };
}

/** The terminal event for a run that failed while its campaign task was open. */
export function campaignFailureEvent(error: unknown, message: string, unresolvedWrite: boolean): CampaignEventInput {
  const failure = classifyFailure(error);
  return { type: 'task_failed', stepId: 'outcome', status: unresolvedWrite ? 'unknown' : 'failed', data: {
    category: unresolvedWrite ? 'verification' : failure.category, code: unresolvedWrite ? 'ADS_RECONCILIATION_REQUIRED' : failure.code, message: message.slice(0, 600),
    action: unresolvedWrite ? 'افتح قسم Google Ads وراجع نتيجة المسودة قبل أي طلب جديد.' : FAILURE_ACTIONS[failure.category], retryable: !unresolvedWrite && failure.retryable,
    retryAfterSeconds: failure.retryAfterMs === null ? null : Math.ceil(failure.retryAfterMs / 1000), reconciliationRequired: unresolvedWrite, strategy: unresolvedWrite ? 'reconcile_by_readback' : failure.strategy,
  } };
}

export const campaignCancelEvent = (reason: 'owner_cancelled' | 'run_interrupted', unresolvedWrite: boolean): CampaignEventInput => ({ type: 'task_cancelled', stepId: 'outcome', status: unresolvedWrite ? 'unknown' : 'cancelled', data: { reason, reconciliationRequired: unresolvedWrite } });

const unavailable = (): never => { throw new BrowserError('CHAT_TOOL_UNAVAILABLE', 'Google Ads غير مهيأ على هذا الخادم.', 409); };
/** For a server without a Google Ads connection: the text check and its corrections still work, nothing else does. */
export const TEXT_ONLY_PORTS: CampaignPorts = {
  parse: unavailable, landing: unavailable, gates: unavailable, drafts: unavailable, createPaused: unavailable, reconcile: unavailable, discard: unavailable,
  lessons: { list: async () => [], record: async () => undefined },
};
