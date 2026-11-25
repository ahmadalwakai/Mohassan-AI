import { z } from 'zod';
import { MAX_EARLIER_THOUGHT_RECORDS, ThoughtRecordSchema } from './deliberation';

/**
 * One chat run as the server's runtime records it (2026-11-23; docs/architecture/agent-execution.md). Every field is
 * written by host code at the moment the runtime commits a state: model text, page text, skill files, memory excerpts
 * and client fields never set any of it. Clients render it and never infer a phase or a verdict of their own.
 */
export const runPhases = ['received', 'understanding', 'selecting', 'planning', 'answering', 'awaiting_input', 'awaiting_approval',
  'executing', 'verifying', 'repairing', 'completed', 'partial', 'blocked', 'cancelled'] as const;
export const RunPhaseSchema = z.enum(runPhases);
export type RunPhase = z.infer<typeof RunPhaseSchema>;
export const terminalRunPhases = ['completed', 'partial', 'blocked', 'cancelled'] as const satisfies readonly RunPhase[];
export type TerminalRunPhase = (typeof terminalRunPhases)[number];

/** `direct`: answered from the request, the conversation and local knowledge, with no external action. `action`: research or tools. */
export const RunPathSchema = z.enum(['direct', 'action']);
export type RunPath = z.infer<typeof RunPathSchema>;

/**
 * Who decided this run's steps. `rules`: fixed host code (parsers, tables, deterministic checks), with no language model.
 * `model`: at least one model call of this run returned a valid result and was recorded. Never inferred from a configured name.
 */
export const RunEngineSchema = z.object({ kind: z.enum(['rules', 'model']), modelCalls: z.number().int().min(0).max(10_000) }).strict();
export type RunEngine = z.infer<typeof RunEngineSchema>;

export const planStepStates = ['pending', 'running', 'awaiting_approval', 'verified', 'failed', 'unknown', 'skipped', 'invalidated'] as const;
export type PlanStepState = (typeof planStepStates)[number];
/**
 * How a step's outcome is checked. `adapter_report` means only the tool's own report exists: it is shown as such and is
 * never counted as independent evidence.
 */
export const verificationMethods = ['deterministic', 'observation', 'readback', 'source_check', 'adapter_report', 'owner_review', 'none'] as const;
export type VerificationMethod = (typeof verificationMethods)[number];
export const RunRiskSchema = z.enum(['none', 'read', 'reversible_write', 'irreversible_write']);
export type RunRisk = z.infer<typeof RunRiskSchema>;
export const StepAuthorizationSchema = z.enum(['not_needed', 'required', 'granted', 'refused', 'invalidated']);
export type StepAuthorization = z.infer<typeof StepAuthorizationSchema>;

export const planStepIdPattern = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const stepIdSchema = z.string().regex(planStepIdPattern);

export const PlanStepSchema = z.object({
  id: stepIdSchema,
  /** The intended outcome of the step, in the request's language. */
  outcome: z.string().min(1).max(200),
  dependsOn: z.array(stepIdSchema).max(8),
  /** A capability the server registered (assistant/agent-run.ts RUN_CAPABILITIES); anything else is rejected. */
  capability: z.string().regex(/^[a-z]+(?:[._][a-z]+)*$/).max(60),
  /** The validated input the step acts on (a query, an address, a file name), as text. Secrets are never kept here. */
  input: z.string().max(300).nullable(),
  /** Observable acceptance criteria. */
  acceptance: z.array(z.string().min(1).max(200)).min(1).max(4),
  verification: z.enum(verificationMethods),
  /** A required step must be verified for the run to complete. */
  required: z.boolean(),
  risk: RunRiskSchema,
  authorization: StepAuthorizationSchema,
  state: z.enum(planStepStates),
  attempts: z.number().int().min(0).max(20),
}).strict();
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const ExecutionPlanSchema = z.object({ version: z.literal(1), steps: z.array(PlanStepSchema).min(1).max(16) }).strict();
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;

export const evidenceKinds = ['observation', 'computation', 'readback', 'source', 'user_statement', 'adapter_report', 'model_output'] as const;
export type EvidenceKind = (typeof evidenceKinds)[number];
export const EvidenceRecordSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  stepId: stepIdSchema.nullable(),
  kind: z.enum(evidenceKinds),
  label: z.string().min(1).max(200),
  /** An address, a receipt or a file reference the host itself read. */
  reference: z.string().max(500).nullable(),
  observedAt: z.iso.datetime(),
  /** True only for a deterministic check or an observation the host made itself. A tool's own report, a user's statement and model text never are. */
  independent: z.boolean(),
}).strict();
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

export const permissionDecisions = ['asked', 'granted', 'refused', 'consumed', 'invalidated', 'expired'] as const;
export const PermissionDecisionSchema = z.object({
  /** The approval card's id. */
  id: z.uuid(),
  stepId: stepIdSchema.nullable(),
  action: z.string().min(1).max(200),
  target: z.string().max(300),
  consequence: z.string().max(300),
  /** Null when the server cannot tell. */
  reversible: z.boolean().nullable(),
  /** SHA-256 of the action's material details (kind, target, arguments). A changed detail is a different action. */
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(permissionDecisions),
  reason: z.string().regex(/^[a-z_]{1,40}$/),
  decidedAt: z.iso.datetime(),
}).strict();
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const VerificationResultSchema = z.object({
  status: z.enum(['verified', 'partial', 'unverified', 'failed', 'not_applicable']),
  criteria: z.array(z.object({
    id: z.string().min(1).max(160),
    label: z.string().min(1).max(200),
    required: z.boolean(),
    status: z.enum(['verified', 'failed', 'unverified', 'expired', 'missing']),
  }).strict()).max(24),
  checkedAt: z.iso.datetime(),
}).strict();
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const RunVerdictSchema = z.object({
  status: z.enum(terminalRunPhases),
  reason: z.string().regex(/^[a-z_]{1,40}$/),
  decidedAt: z.iso.datetime(),
}).strict();
export type RunVerdict = z.infer<typeof RunVerdictSchema>;

/** The bounded understanding of the turn the runtime acted on (the task context). Data to show, never instructions. */
export const RunContextSchema = z.object({
  objective: z.string().min(1).max(400),
  previousTurns: z.number().int().min(0).max(50),
  /** Capabilities the request's own words forbid («لا تبحث في الويب»). */
  constraints: z.array(z.string().max(60)).max(12),
  /** Earlier requests this one corrected while they were running or waiting. */
  corrections: z.array(z.string().max(300)).max(3),
  capabilities: z.array(z.string().max(40)).max(20),
  limitations: z.array(z.string().max(40)).max(12),
}).strict();
export type RunContext = z.infer<typeof RunContextSchema>;

export const ChatRunViewSchema = z.object({
  id: z.uuid(),
  phase: RunPhaseSchema,
  path: RunPathSchema.nullable(),
  engine: RunEngineSchema,
  context: RunContextSchema.nullable(),
  plan: ExecutionPlanSchema.nullable(),
  evidence: z.array(EvidenceRecordSchema).max(24),
  permissions: z.array(PermissionDecisionSchema).max(12),
  verification: VerificationResultSchema.nullable(),
  verdict: RunVerdictSchema.nullable(),
  repairs: z.object({ used: z.number().int().min(0).max(20), limit: z.number().int().min(0).max(20) }).strict(),
  /** The run this one replaced after the owner corrected it while it was working or waiting. */
  steeredFrom: z.uuid().nullable(),
  /** Grows with every state the runtime commits for this run; a client keeps the snapshot with the higher value. */
  sequence: z.number().int().min(0).max(1_000_000),
  updatedAt: z.iso.datetime(),
  deliberation: ThoughtRecordSchema.optional(),
  earlierDeliberation: z.array(ThoughtRecordSchema).max(MAX_EARLIER_THOUGHT_RECORDS).optional(),
}).strict();
export type ChatRunView = z.infer<typeof ChatRunViewSchema>;
