import { z } from 'zod';

/**
 * Shared contracts of the goal, readiness and clarification core
 * (`@mohassan/cognitive` → clarification.ts). The server persists a GoalFrame in
 * the run state, the web client renders the summary and the decision events, and
 * the cognitive lab reads the same types through the production chat control.
 *
 * Nothing in these types is permission. Readiness, evidence and answers are data;
 * execution authority stays with the server-side gates at each action boundary.
 */

const Slug = z.string().regex(/^[a-z0-9_:.-]{1,64}$/);
const ShortText = z.string().max(400);

/** How much a piece of information may be relied on. Assumptions never become facts by themselves. */
export const EvidenceKindSchema = z.enum(['VERIFIED_FACT', 'USER_CONSTRAINT', 'INFERRED_PREFERENCE', 'WORKING_ASSUMPTION', 'UNKNOWN']);
/** Where a piece of information came from. Only `request` and `clarification_answer` carry the current user's voice. */
export const EvidenceSourceSchema = z.enum(['request', 'conversation', 'clarification_answer', 'memory', 'task_state', 'tool_result', 'retrieved_content', 'default']);
export const GoalDomainSchema = z.enum(['conversation', 'research', 'browser', 'coding', 'files', 'computer', 'skills', 'google_ads']);
/** Kinds of step a task can contain, from harmless to consequential. Readiness is evaluated for each. */
export const StepKindSchema = z.enum(['answer', 'research', 'read', 'draft', 'external_write', 'spend', 'irreversible']);
export const SlotIdSchema = z.enum([
  'subject', 'target_site', 'project', 'change', 'file_path', 'file_operation',
  'ads_service', 'ads_url', 'ads_location', 'ads_language', 'ads_budget', 'ads_objective', 'ads_account', 'ads_conversion',
]);

export const GoalEvidenceSchema = z.object({
  id: Slug,
  slot: SlotIdSchema.nullable(),
  kind: EvidenceKindSchema,
  source: EvidenceSourceSchema,
  value: ShortText,
  /** ISO time the value was observed or stated. */
  observedAt: z.string().max(40),
  /** Untrusted evidence (memory, pages, tool text) can inform a recommendation but never satisfies an authority slot. */
  trusted: z.boolean(),
  stale: z.boolean(),
  /** True while the value still needs a trusted check before an action may rely on it. */
  needsVerification: z.boolean(),
}).strict();

export const RequirementSchema = z.object({
  slot: SlotIdSchema,
  domain: GoalDomainSchema,
  /** `required` blocks the listed steps until satisfied; `optional` only improves quality. */
  necessity: z.enum(['required', 'optional']),
  status: z.enum(['satisfied', 'missing', 'conflicting', 'assumed', 'declined']),
  /** Steps that must not run while this requirement is unresolved. */
  blocks: z.array(StepKindSchema).max(7),
  /** True for values that authorize spending or name the target of a change: only the user can supply them. */
  authority: z.boolean(),
  evidenceIds: z.array(Slug).max(8),
  /** The value the task will use, already chosen by the user or recorded as an assumption. */
  value: ShortText.nullable(),
}).strict();

export const ReadinessStatusSchema = z.enum(['READY', 'NEEDS_CLARIFICATION', 'NEEDS_RESEARCH', 'NEEDS_APPROVAL', 'BLOCKED']);
export const ClarificationOutcomeSchema = z.enum(['PROCEED', 'RESEARCH', 'ASK_USER', 'PREPARE_DRAFT', 'REQUEST_APPROVAL', 'BLOCKED']);

export const ReadinessReasonSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  message: ShortText,
  slot: SlotIdSchema.nullable(),
}).strict();

export const StepReadinessSchema = z.object({
  step: StepKindSchema,
  status: ReadinessStatusSchema,
  reasons: z.array(ReadinessReasonSchema).max(12),
}).strict();

/** Explainable heuristic factors behind a question's value. Not a probability. */
export const QuestionScoreSchema = z.object({
  value: z.number().int().min(-100).max(100),
  impact: z.number().int().min(0).max(3),
  assumptionRisk: z.number().int().min(0).max(3),
  changesPlan: z.boolean(),
  answerableFromSources: z.boolean(),
  interruptionCost: z.number().int().min(0).max(10),
  mandatory: z.boolean(),
}).strict();

export const ClarificationQuestionSpecSchema = z.object({
  id: Slug,
  slots: z.array(SlotIdSchema).min(1).max(3),
  prompt: z.string().min(1).max(1000),
  reason: z.string().max(300),
  options: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/), label: z.string().min(1).max(160) }).strict()).max(5),
  recommendedOptionId: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/).nullable(),
  allowText: z.boolean(),
  score: QuestionScoreSchema,
  /** The slot values an option stands for. Server-side only; never sent to the client. */
  optionValues: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/), z.partialRecord(SlotIdSchema, ShortText)),
}).strict();

export const ReadinessAssessmentSchema = z.object({
  status: ReadinessStatusSchema,
  outcome: ClarificationOutcomeSchema,
  /** The step the request is mainly about. */
  primaryStep: StepKindSchema,
  steps: z.array(StepReadinessSchema).max(7),
  reasons: z.array(ReadinessReasonSchema).max(16),
  question: ClarificationQuestionSpecSchema.nullable(),
}).strict();

export const ClarificationAnswerRecordSchema = z.object({
  questionId: Slug,
  slots: z.array(SlotIdSchema).max(3),
  kind: z.enum(['answer', 'decline', 'cancel', 'new_goal']),
  /** Slots the answer actually filled. */
  filled: z.array(SlotIdSchema).max(8),
  at: z.string().max(40),
}).strict();

/**
 * The task's goal as understood so far. `version` increases on every material
 * change; an approval or readiness result for an older version is stale.
 */
export const GoalFrameSchema = z.object({
  version: z.number().int().min(1).max(1000),
  /** The user's request, redacted. Clarification answers never replace it. */
  request: z.string().max(4000),
  language: z.enum(['ar', 'en']),
  domains: z.array(GoalDomainSchema).min(1).max(8),
  primaryStep: StepKindSchema,
  /** Constraints the user stated in their own words, such as "paused only" or "do not spend". */
  constraints: z.array(ShortText).max(12),
  requirements: z.array(RequirementSchema).max(24),
  evidence: z.array(GoalEvidenceSchema).max(48),
  conflicts: z.array(z.object({ slot: SlotIdSchema, values: z.array(ShortText).min(2).max(4) }).strict()).max(8),
  /** Engine-raised questions so far in this task, newest last. Bounds the loop. */
  asked: z.array(z.object({ id: Slug, slots: z.array(SlotIdSchema).max(3), at: z.string().max(40) }).strict()).max(8),
  answers: z.array(ClarificationAnswerRecordSchema).max(8),
}).strict();

/** What the web client shows about the current task. Concise summaries only; no model reasoning. */
export const ChatGoalSummarySchema = z.object({
  version: z.number().int().min(1).max(1000),
  outcome: ClarificationOutcomeSchema,
  status: ReadinessStatusSchema,
  domains: z.array(GoalDomainSchema).max(8),
  known: z.array(z.object({ slot: SlotIdSchema, label: z.string().max(80), value: ShortText, kind: EvidenceKindSchema }).strict()).max(16),
  missing: z.array(z.object({ slot: SlotIdSchema, label: z.string().max(80) }).strict()).max(16),
  assumptions: z.array(z.object({ slot: SlotIdSchema, label: z.string().max(80), value: ShortText }).strict()).max(16),
  blockers: z.array(ReadinessReasonSchema).max(12),
  steps: z.array(StepReadinessSchema).max(7),
}).strict();

export const ChatDecisionEventTypeSchema = z.enum([
  'goal_interpreted', 'context_retrieved', 'ambiguity_detected', 'requirement_missing',
  'clarification_requested', 'clarification_answered', 'assumption_updated', 'research_required',
  'readiness_evaluated', 'plan_revised', 'approval_requested', 'execution_resumed',
  'verification_completed', 'task_blocked', 'task_completed',
]);

/** One observable decision. `seq` is gap-free per conversation, so a client can resume after the last one it holds. */
export const ChatDecisionEventSchema = z.object({
  seq: z.number().int().min(1),
  runId: z.uuid(),
  type: ChatDecisionEventTypeSchema,
  summary: z.string().min(1).max(300),
  data: z.record(z.string().max(40), z.union([z.string().max(400), z.number(), z.boolean(), z.null(), z.array(z.string().max(80)).max(16)])),
  at: z.string(),
}).strict();

export const ChatDecisionStreamSchema = z.object({
  lastSeq: z.number().int().min(0),
  events: z.array(ChatDecisionEventSchema).max(200),
}).strict();

export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;
export type GoalDomain = z.infer<typeof GoalDomainSchema>;
export type StepKind = z.infer<typeof StepKindSchema>;
export type SlotId = z.infer<typeof SlotIdSchema>;
export type GoalEvidence = z.infer<typeof GoalEvidenceSchema>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type ReadinessStatus = z.infer<typeof ReadinessStatusSchema>;
export type ClarificationOutcome = z.infer<typeof ClarificationOutcomeSchema>;
export type ReadinessReason = z.infer<typeof ReadinessReasonSchema>;
export type StepReadiness = z.infer<typeof StepReadinessSchema>;
export type QuestionScore = z.infer<typeof QuestionScoreSchema>;
export type ClarificationQuestionSpec = z.infer<typeof ClarificationQuestionSpecSchema>;
export type ReadinessAssessment = z.infer<typeof ReadinessAssessmentSchema>;
export type ClarificationAnswerRecord = z.infer<typeof ClarificationAnswerRecordSchema>;
export type GoalFrame = z.infer<typeof GoalFrameSchema>;
export type ChatGoalSummary = z.infer<typeof ChatGoalSummarySchema>;
export type ChatDecisionEventType = z.infer<typeof ChatDecisionEventTypeSchema>;
export type ChatDecisionEvent = z.infer<typeof ChatDecisionEventSchema>;
export type ChatDecisionStream = z.infer<typeof ChatDecisionStreamSchema>;
