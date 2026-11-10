import { z } from 'zod';

/**
 * Structured progress of one Google Ads campaign task, shared by the server that
 * emits it and every client that draws it. Each event states where its fact came
 * from, so a local check can never read as something Google said or did.
 */

export const CampaignFailureCategorySchema = z.enum(['schema', 'character_limit', 'factual_claim', 'landing_page', 'provider', 'model_output', 'authentication', 'permissions', 'quota', 'network', 'verification', 'policy', 'unknown']);
export type CampaignFailureCategory = z.infer<typeof CampaignFailureCategorySchema>;

export const CampaignStepIdSchema = z.enum(['intent', 'draft', 'local_validation', 'correction', 'landing_page', 'remote_validation', 'approval', 'paused_creation', 'readback', 'outcome']);
export type CampaignStepId = z.infer<typeof CampaignStepIdSchema>;
export const CAMPAIGN_STEP_ORDER: readonly CampaignStepId[] = CampaignStepIdSchema.options;

export const CampaignStepStatusSchema = z.enum(['pending', 'running', 'passed', 'failed', 'corrected', 'waiting', 'skipped', 'unknown', 'cancelled']);
export type CampaignStepStatus = z.infer<typeof CampaignStepStatusSchema>;

/** `local` is this program's own check; `google_ads_api` is an answer from the account itself. */
export const CampaignAuthoritySchema = z.enum(['local', 'google_ads_api']);
export type CampaignAuthority = z.infer<typeof CampaignAuthoritySchema>;

export const CampaignCorrectionStrategySchema = z.enum(['deterministic', 'model_rewrite', 'remove_item']);
export type CampaignCorrectionStrategy = z.infer<typeof CampaignCorrectionStrategySchema>;

export const CampaignRecoveryStrategySchema = z.enum(['correct_and_revalidate', 'retry_with_backoff', 'wait_retry_after', 'reauthenticate', 'reconcile_by_readback', 'ask_owner', 'stop_and_report']);
export type CampaignRecoveryStrategy = z.infer<typeof CampaignRecoveryStrategySchema>;

const Code = z.string().min(1).max(60);
const FieldName = z.string().min(1).max(40);
const AdText = z.string().max(200);

export const CampaignFieldSchema = z.object({
  kind: z.enum(['headline', 'description', 'path']), index: z.number().int().min(1).max(50), text: AdText,
  length: z.number().int().min(0), limit: z.number().int().min(1),
  status: z.enum(['valid', 'invalid', 'corrected']), issues: z.array(Code).max(12),
}).strict();
export type CampaignField = z.infer<typeof CampaignFieldSchema>;

export const CampaignIssueSchema = z.object({ code: Code, field: FieldName, category: CampaignFailureCategorySchema, message: z.string().max(400) }).strict();
export type CampaignIssue = z.infer<typeof CampaignIssueSchema>;

/**
 * One correction. `reason` is the validator's own finding (observed). `basis` says who
 * wrote the new text: this program, or a model whose output was then checked again.
 */
export const CampaignChangeSchema = z.object({
  field: FieldName, before: AdText, after: AdText.nullable(), reasonCode: Code, reason: z.string().max(400),
  category: CampaignFailureCategorySchema, strategy: CampaignCorrectionStrategySchema, basis: z.enum(['observed', 'model']), verified: z.boolean(),
}).strict();
export type CampaignChange = z.infer<typeof CampaignChangeSchema>;

export const CampaignCheckSchema = z.object({ id: Code, passed: z.boolean(), detail: z.string().max(600) }).strict();
export type CampaignCheck = z.infer<typeof CampaignCheckSchema>;

export const CampaignVerificationScopeSchema = z.enum(['local_text', 'landing_page', 'draft_integrity', 'account', 'conversion_tracking', 'google_validate_only', 'readback']);
export type CampaignVerificationScope = z.infer<typeof CampaignVerificationScopeSchema>;

export const CampaignOperationSchema = z.enum(['validate_only', 'create_paused', 'readback']);
/** `rejected` is Google's own refusal of the write: nothing was applied, so no read is needed to know it. */
export const CampaignReconciliationSchema = z.enum(['confirmed_paused', 'confirmed_absent', 'mismatch', 'rejected', 'reconciliation_required']);

const base = {
  id: z.uuid(), taskId: z.string().regex(/^[a-zA-Z0-9:_-]{8,80}$/), seq: z.number().int().min(1),
  stepId: CampaignStepIdSchema.nullable(), status: CampaignStepStatusSchema, at: z.string(),
};
const event = <Type extends string, Data extends z.ZodType>(type: Type, data: Data) => z.object({ ...base, type: z.literal(type), data }).strict();

export const CampaignEventSchema = z.discriminatedUnion('type', [
  event('task_started', z.object({ kind: z.literal('google_ads_search_campaign'), createInAccount: z.boolean() }).strict()),
  event('step_started', z.object({ attempt: z.number().int().min(1).max(20).optional() }).strict()),
  event('draft_updated', z.object({ fields: z.array(CampaignFieldSchema).max(40), keywords: z.number().int().min(0), negativeKeywords: z.number().int().min(0), source: z.enum(['model_draft', 'corrected_draft', 'saved_draft']) }).strict()),
  event('validation_failed', z.object({ authority: CampaignAuthoritySchema, scope: CampaignVerificationScopeSchema, issues: z.array(CampaignIssueSchema).max(40), fingerprint: z.string().regex(/^[a-f0-9]{16,64}$/) }).strict()),
  event('correction_started', z.object({ attempt: z.number().int().min(1).max(20), maxAttempts: z.number().int().min(1).max(20), strategy: CampaignCorrectionStrategySchema, targets: z.array(FieldName).max(40) }).strict()),
  event('correction_completed', z.object({ attempt: z.number().int().min(1).max(20), strategy: CampaignCorrectionStrategySchema, changes: z.array(CampaignChangeSchema).max(40), remaining: z.number().int().min(0), failure: Code.nullable() }).strict()),
  event('verification_completed', z.object({ authority: CampaignAuthoritySchema, scope: CampaignVerificationScopeSchema, passed: z.boolean(), checks: z.array(CampaignCheckSchema).max(20) }).strict()),
  event('approval_required', z.object({ kind: z.enum(['publication_gates', 'launch']), satisfied: z.boolean(), ownerRequested: z.boolean(), gates: z.array(CampaignCheckSchema).max(12) }).strict()),
  event('external_operation_started', z.object({ operation: CampaignOperationSchema, mutates: z.boolean(), attempt: z.number().int().min(1).max(20) }).strict()),
  event('external_operation_reconciled', z.object({ operation: CampaignOperationSchema, outcome: CampaignReconciliationSchema, campaignResourceName: z.string().max(120).nullable(), readAttempts: z.number().int().min(0).max(20) }).strict()),
  event('task_completed', z.object({ outcome: z.enum(['paused_campaign_created', 'paused_campaign_recovered', 'draft_checked']), campaignResourceName: z.string().max(120).nullable(), conversionTrackingProven: z.boolean().nullable(), launchRequiresApproval: z.boolean() }).strict()),
  event('task_failed', z.object({ category: CampaignFailureCategorySchema, code: Code, message: z.string().max(600), action: z.string().max(400), retryable: z.boolean(), retryAfterSeconds: z.number().int().min(0).nullable(), reconciliationRequired: z.boolean(), strategy: CampaignRecoveryStrategySchema }).strict()),
  event('task_cancelled', z.object({ reason: z.enum(['owner_cancelled', 'run_interrupted']), reconciliationRequired: z.boolean() }).strict()),
]);
export type CampaignEvent = z.infer<typeof CampaignEventSchema>;
export type CampaignEventType = CampaignEvent['type'];
/** What an emitter supplies; identity, order and time are assigned by the store. */
export type CampaignEventInput = { [Type in CampaignEventType]: Pick<Extract<CampaignEvent, { type: Type }>, 'type' | 'stepId' | 'status' | 'data'> }[CampaignEventType];

export const CampaignEventStreamSchema = z.object({ taskId: base.taskId, lastSeq: z.number().int().min(0), events: z.array(CampaignEventSchema).max(400) }).strict();
export type CampaignEventStream = z.infer<typeof CampaignEventStreamSchema>;

export type CampaignTaskStatus = 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'reconciliation_required';

export interface CampaignProgress {
  taskId: string;
  lastSeq: number;
  status: CampaignTaskStatus;
  createInAccount: boolean;
  steps: { id: CampaignStepId; status: CampaignStepStatus }[];
  fields: CampaignField[];
  keywords: number;
  negativeKeywords: number;
  issues: (CampaignIssue & { authority: CampaignAuthority })[];
  corrections: (CampaignChange & { attempt: number })[];
  correctionFailure: string | null;
  verifications: { scope: CampaignVerificationScope; authority: CampaignAuthority; passed: boolean; checks: CampaignCheck[]; at: string }[];
  approval: Extract<CampaignEvent, { type: 'approval_required' }>['data'] | null;
  operations: { operation: z.infer<typeof CampaignOperationSchema>; mutates: boolean; state: 'started' | z.infer<typeof CampaignReconciliationSchema>; campaignResourceName: string | null }[];
  outcome: Extract<CampaignEvent, { type: 'task_completed' }>['data'] | null;
  error: Extract<CampaignEvent, { type: 'task_failed' }>['data'] | null;
  cancelled: Extract<CampaignEvent, { type: 'task_cancelled' }>['data'] | null;
  updatedAt: string | null;
}

/**
 * Joins what a client already holds with what just arrived. Events are keyed by
 * their sequence number, so a replayed or repeated event changes nothing and a
 * late page of older events cannot erase newer ones. A different task replaces the list.
 */
export function mergeCampaignEvents(held: readonly CampaignEvent[], incoming: readonly CampaignEvent[]): CampaignEvent[] {
  const taskId = incoming[0]?.taskId ?? held[0]?.taskId;
  const bySeq = new Map<number, CampaignEvent>();
  for (const item of [...held, ...incoming]) if (item.taskId === taskId && !bySeq.has(item.seq)) bySeq.set(item.seq, item);
  return [...bySeq.values()].sort((first, second) => first.seq - second.seq);
}

const TERMINAL: ReadonlySet<CampaignEventType> = new Set(['task_completed', 'task_failed', 'task_cancelled']);
export const isCampaignTerminal = (item: Pick<CampaignEvent, 'type'>) => TERMINAL.has(item.type);

/** The card's state, derived only from events. Order and duplicates in the input do not matter. */
export function reduceCampaignEvents(input: readonly CampaignEvent[]): CampaignProgress | null {
  const events = mergeCampaignEvents([], input);
  if (!events.length) return null;
  const steps = new Map<CampaignStepId, CampaignStepStatus>();
  const progress: CampaignProgress = {
    taskId: events[0]!.taskId, lastSeq: events.at(-1)!.seq, status: 'running', createInAccount: false, steps: [], fields: [], keywords: 0, negativeKeywords: 0,
    issues: [], corrections: [], correctionFailure: null, verifications: [], approval: null, operations: [], outcome: null, error: null, cancelled: null, updatedAt: events.at(-1)!.at,
  };
  for (const item of events) {
    // Nothing after the terminal event may reopen the task.
    if (progress.status !== 'running') break;
    if (item.stepId) steps.set(item.stepId, item.status);
    switch (item.type) {
      case 'task_started': progress.createInAccount = item.data.createInAccount; break;
      case 'step_started': break;
      case 'draft_updated': progress.fields = item.data.fields; progress.keywords = item.data.keywords; progress.negativeKeywords = item.data.negativeKeywords; break;
      case 'validation_failed': progress.issues = item.data.issues.map(issue => ({ ...issue, authority: item.data.authority })); break;
      case 'correction_started': break;
      case 'correction_completed':
        progress.corrections.push(...item.data.changes.map(change => ({ ...change, attempt: item.data.attempt })));
        progress.correctionFailure = item.data.failure;
        if (!item.data.remaining) progress.issues = [];
        break;
      case 'verification_completed': {
        progress.verifications = [...progress.verifications.filter(entry => entry.scope !== item.data.scope), { scope: item.data.scope, authority: item.data.authority, passed: item.data.passed, checks: item.data.checks, at: item.at }];
        if (item.data.passed && item.data.scope === 'local_text') progress.issues = [];
        break;
      }
      case 'approval_required': progress.approval = item.data; break;
      case 'external_operation_started':
        progress.operations = [...progress.operations.filter(entry => entry.operation !== item.data.operation), { operation: item.data.operation, mutates: item.data.mutates, state: 'started', campaignResourceName: null }];
        break;
      case 'external_operation_reconciled': {
        const known = progress.operations.find(entry => entry.operation === item.data.operation);
        const next = { operation: item.data.operation, mutates: known?.mutates ?? item.data.operation === 'create_paused', state: item.data.outcome, campaignResourceName: item.data.campaignResourceName };
        progress.operations = [...progress.operations.filter(entry => entry.operation !== item.data.operation), next];
        break;
      }
      case 'task_completed':
        progress.outcome = item.data;
        progress.status = item.data.outcome === 'draft_checked' ? 'partial' : 'completed';
        break;
      case 'task_failed':
        progress.error = item.data;
        progress.status = item.data.reconciliationRequired ? 'reconciliation_required' : 'failed';
        break;
      case 'task_cancelled':
        progress.cancelled = item.data;
        progress.status = item.data.reconciliationRequired ? 'reconciliation_required' : 'cancelled';
        break;
    }
  }
  // A step still marked running when the task ended did not finish.
  const closed: CampaignStepStatus | null = progress.status === 'running' ? null : progress.status === 'cancelled' ? 'cancelled' : progress.status === 'reconciliation_required' ? 'unknown' : progress.status === 'failed' ? 'failed' : 'skipped';
  progress.steps = CAMPAIGN_STEP_ORDER.filter(id => steps.has(id)).map(id => ({ id, status: closed && steps.get(id) === 'running' ? closed : steps.get(id)! }));
  return progress;
}
