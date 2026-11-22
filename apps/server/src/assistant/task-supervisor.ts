import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentPage, AgentPostcondition, AgentVerificationReport } from '@mohassan/browser';
import { assessBrowserVerification } from './verification.js';

/**
 * Controller-owned task supervision. Only the host may construct contracts and
 * observations from tool results. Provider JSON, page text and model assertions
 * must never be forwarded into this API as evidence, even if their fields look
 * like an observation. This module does not dispatch tools or grant authority.
 *
 * The host must declare goal criteria before execution; a criterion proving only
 * that a field was filled must not be used to certify an entire booking task.
 * `verified` describes the declared criteria, not arbitrary claims in a reply.
 * A conversation with no objective criteria remains unscoped, rather than being
 * forced into a blocked outcome. Finishing a partial answer is always possible;
 * allowCompletion means that the host can mark the task itself accomplished.
 */

const MAX_STEPS = 64;
const MAX_CRITERIA = 16;
const MAX_OBSERVATIONS_PER_STEP = 8;
const MAX_STATE_BYTES = 128 * 1024;
const DEFAULT_EVIDENCE_AGE_MS = 5 * 60_000;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema = z.string().trim().min(1).max(160);
const targetSchema = z.string().trim().min(1).max(2500);
const referenceSchema = z.string().trim().min(1).max(300);
const timeSchema = z.number().int().min(0).max(8_640_000_000_000_000);
const outcomeSchema = z.enum(['confirmed', 'contradicted', 'unknown']);

const criterionCommon = {
  id: identitySchema,
  target: targetSchema,
  description: z.string().trim().min(1).max(500),
  required: z.boolean().default(true),
  maxAgeMs: z.number().int().min(1).max(24 * 60 * 60_000).default(DEFAULT_EVIDENCE_AGE_MS),
};

export const TaskCriterionSchema = z.discriminatedUnion('kind', [
  z.object({ ...criterionCommon, kind: z.literal('navigation') }).strict(),
  z.object({ ...criterionCommon, kind: z.literal('answer_evidence') }).strict(),
  z.object({ ...criterionCommon, kind: z.literal('effect'), expectationHash: hashSchema }).strict(),
  z.object({ ...criterionCommon, kind: z.literal('artifact'), artifactType: z.enum(['screenshot', 'file']) }).strict(),
]);
export type TaskCriterion = z.infer<typeof TaskCriterionSchema>;
export type TaskCriterionInput = z.input<typeof TaskCriterionSchema>;

const observationCommon = {
  criterionId: identitySchema,
  target: targetSchema,
  reference: referenceSchema,
  observedAt: timeSchema,
};

export const TaskObservationSchema = z.discriminatedUnion('kind', [
  z.object({
    ...observationCommon, kind: z.literal('navigation'), source: z.literal('browser-observation'),
    httpStatus: z.number().int().min(100).max(599),
    contentHash: z.string().regex(/^(?:[a-f0-9]{24}|[a-f0-9]{64})$/),
  }).strict(),
  z.object({
    ...observationCommon, kind: z.literal('answer_evidence'),
    source: z.enum(['memory-read', 'computation', 'knowledge-verifier', 'browser-verifier', 'computer-observation']),
    outcome: outcomeSchema, independentlyVerified: z.boolean(), answerHash: hashSchema,
  }).strict(),
  z.object({
    ...observationCommon, kind: z.literal('effect'),
    source: z.enum(['browser-verifier', 'authoritative-readback', 'tool-receipt']),
    outcome: outcomeSchema, independentlyVerified: z.boolean(), expectationHash: hashSchema,
    actionRef: referenceSchema,
  }).strict(),
  z.object({
    ...observationCommon, kind: z.literal('artifact'), source: z.literal('artifact'),
    artifactType: z.enum(['screenshot', 'file']), artifactHash: hashSchema,
    /** For screenshots this is the browser observation captured, not an image caption. */
    pageRef: referenceSchema.optional(),
  }).strict(),
]);
export type TaskObservation = z.infer<typeof TaskObservationSchema>;

const contractFields = {
  version: z.literal(1),
  id: identitySchema,
  revision: z.number().int().min(1).max(2_147_483_647),
  objective: z.string().trim().min(1).max(4000),
  kind: z.enum(['conversation', 'task', 'unsupported']),
  mode: z.enum(['advisory', 'enforced']),
  criteria: z.array(TaskCriterionSchema).max(MAX_CRITERIA),
};
export const TaskContractSchema = z.object({ ...contractFields, hash: hashSchema }).strict();
export type TaskContract = z.infer<typeof TaskContractSchema>;

export const TaskStepInputSchema = z.object({
  stepId: identitySchema,
  /** Monotonically increasing within this contract revision. Replays cannot advance it. */
  sequence: z.number().int().min(1).max(2_147_483_647),
  tool: z.string().trim().min(1).max(100),
  startedAt: timeSchema,
  finishedAt: timeSchema,
  result: z.enum(['succeeded', 'failed', 'unknown']),
  resultRef: referenceSchema.optional(),
  /** Hash of actual host-read result content; an effect flag is not content evidence. */
  resultHash: hashSchema.optional(),
  changed: z.boolean().nullable().optional(),
  /** A later attempted mutation invalidates earlier evidence for these criteria. */
  affects: z.array(identitySchema).max(MAX_CRITERIA).default([]),
  observations: z.array(TaskObservationSchema).max(MAX_OBSERVATIONS_PER_STEP).default([]),
}).strict();
export type TaskStepInput = z.input<typeof TaskStepInputSchema>;
type ParsedTaskStep = z.infer<typeof TaskStepInputSchema>;

const TaskStepRecordSchema = TaskStepInputSchema.extend({
  contractHash: hashSchema,
  inputHash: hashSchema,
  progressed: z.boolean(),
}).strict();
type TaskStepRecord = z.infer<typeof TaskStepRecordSchema>;

export const TaskSupervisorStateSchema = z.object({
  version: z.literal(1),
  contract: TaskContractSchema,
  startedAt: timeSchema,
  lastSequence: z.number().int().min(0).max(2_147_483_647),
  stagnantSteps: z.number().int().min(0).max(MAX_STEPS),
  steps: z.array(TaskStepRecordSchema).max(MAX_STEPS),
}).strict();
export type TaskSupervisorState = z.infer<typeof TaskSupervisorStateSchema>;

export const taskEvidenceHash = (value: string): string => createHash('sha256').update(value).digest('hex');
const objectHash = (value: unknown) => taskEvidenceHash(JSON.stringify(value));

/** Exact canonical URL, including path, query and fragment. Redirects need their own criterion. */
function navigationTarget(value: string): string | null {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function contractBody(contract: TaskContract) {
  const { hash: _hash, ...body } = contract;
  return body;
}

function validContract(contract: TaskContract): boolean {
  if (objectHash(contractBody(contract)) !== contract.hash || new Set(contract.criteria.map(item => item.id)).size !== contract.criteria.length) return false;
  if ((contract.kind === 'task') !== Boolean(contract.criteria.length)
      || (contract.kind === 'task' && !contract.criteria.some(item => item.required))) return false;
  return contract.criteria.every(item => item.kind !== 'navigation' && !(item.kind === 'artifact' && item.artifactType === 'screenshot')
    || navigationTarget(item.target) === item.target);
}

const CreateTaskSupervisorSchema = z.object({
  id: identitySchema,
  revision: z.number().int().min(1).max(2_147_483_647).default(1),
  objective: z.string().trim().min(1).max(4000),
  kind: z.enum(['conversation', 'task', 'unsupported']).optional(),
  mode: z.enum(['advisory', 'enforced']).default('advisory'),
  criteria: z.array(TaskCriterionSchema).max(MAX_CRITERIA).default([]),
  now: timeSchema.optional(),
}).strict();
export type CreateTaskSupervisorInput = z.input<typeof CreateTaskSupervisorSchema>;

export function createTaskSupervisor(input: CreateTaskSupervisorInput): TaskSupervisorState {
  const parsed = CreateTaskSupervisorSchema.parse(input);
  const criteria = parsed.criteria.map(item => {
    if (item.kind !== 'navigation' && !(item.kind === 'artifact' && item.artifactType === 'screenshot')) return item;
    const target = navigationTarget(item.target);
    if (!target) throw new Error('TASK_SUPERVISOR_INVALID_TARGET');
    return { ...item, target };
  });
  const body = { version: 1 as const, id: parsed.id, revision: parsed.revision, objective: parsed.objective,
    kind: parsed.kind ?? (criteria.length ? 'task' : 'conversation'), mode: parsed.mode, criteria };
  const contract: TaskContract = { ...body, hash: objectHash(body) };
  if (!validContract(contract)) throw new Error('TASK_SUPERVISOR_INVALID_CONTRACT');
  const state: TaskSupervisorState = { version: 1, contract, startedAt: parsed.now ?? Date.now(), lastSequence: 0, stagnantSteps: 0, steps: [] };
  if (Buffer.byteLength(JSON.stringify(state), 'utf8') > MAX_STATE_BYTES) throw new Error('TASK_SUPERVISOR_STATE_LIMIT');
  return state;
}

export interface CompiledTaskSupervisorInput {
  id: string;
  objective: string;
  revision?: number;
  mode?: 'advisory' | 'enforced';
  now?: number;
  /** The host has already classified the operation; no language/model guess is trusted here. */
  operation:
    | { kind: 'conversation' }
    | { kind: 'unsupported' }
    | { kind: 'navigation'; url: string; screenshot?: boolean }
    | { kind: 'memory_recall'; target?: string }
    | { kind: 'effect'; target: string; description: string; expectationHash: string };
}

/** Small compiler for explicit, supported operations. Other tasks can declare criteria directly. */
export function compileTaskSupervisor(input: CompiledTaskSupervisorInput): TaskSupervisorState {
  const { operation, ...base } = input;
  if (operation.kind === 'conversation' || operation.kind === 'unsupported') {
    return createTaskSupervisor({ ...base, kind: operation.kind, criteria: [] });
  }
  const criteria: TaskCriterionInput[] = operation.kind === 'navigation'
    ? [{ id: 'navigation', kind: 'navigation', target: operation.url, description: 'The requested page loaded successfully.' },
      ...(operation.screenshot ? [{ id: 'screenshot', kind: 'artifact' as const, artifactType: 'screenshot' as const,
        target: operation.url, description: 'An actual screenshot of the requested page was captured.' }] : [])]
    : operation.kind === 'memory_recall'
      ? [{ id: 'memory-answer', kind: 'answer_evidence', target: operation.target ?? 'memory:recall', description: 'The final answer matches retrieved memory evidence.' }]
      : [{ id: 'effect', kind: 'effect', target: operation.target, description: operation.description, expectationHash: operation.expectationHash }];
  return createTaskSupervisor({ ...base, kind: 'task', criteria });
}

function validStep(step: ParsedTaskStep, state: TaskSupervisorState): boolean {
  if (step.startedAt < state.startedAt || step.finishedAt < step.startedAt) return false;
  if (step.affects.some(id => !state.contract.criteria.some(item => item.id === id)) || new Set(step.affects).size !== step.affects.length) return false;
  return step.observations.every(observation => {
    const criterion = state.contract.criteria.find(item => item.id === observation.criterionId);
    return criterion?.kind === observation.kind && observation.observedAt >= step.startedAt && observation.observedAt <= step.finishedAt;
  });
}

function parsedStep(record: TaskStepRecord): ParsedTaskStep {
  const { contractHash: _contractHash, inputHash: _inputHash, progressed: _progressed, ...step } = record;
  return step;
}

function observationFingerprint(observation: TaskObservation): string {
  // Receipt IDs and timestamps change on repeated reads, while the underlying
  // evidence may be identical. Such reads must not repeatedly reset stagnation.
  const { reference: _reference, observedAt: _observedAt, ...body } = observation;
  if (body.kind === 'effect') {
    const { actionRef: _actionRef, ...effect } = body;
    return objectHash(effect);
  }
  if (body.kind === 'artifact') {
    const { pageRef: _pageRef, ...artifact } = body;
    return objectHash(artifact);
  }
  return objectHash(body);
}

function stepProgressed(state: TaskSupervisorState, step: ParsedTaskStep): boolean {
  if (step.result === 'failed') return false;
  if (step.resultHash && !state.steps.some(previous => previous.resultHash === step.resultHash)) return true;
  const previous = new Set(state.steps.flatMap(item => item.observations.map(observationFingerprint)));
  return step.observations.some(observation => observation.source !== 'tool-receipt' && !previous.has(observationFingerprint(observation)));
}

function validState(state: TaskSupervisorState): boolean {
  if (!validContract(state.contract)) return false;
  const replay: TaskSupervisorState = { version: 1, contract: state.contract, startedAt: state.startedAt, lastSequence: 0, stagnantSteps: 0, steps: [] };
  for (const record of state.steps) {
    const step = parsedStep(record);
    if (record.contractHash !== state.contract.hash || objectHash(step) !== record.inputHash || !validStep(step, replay)
        || replay.steps.some(previous => previous.stepId === step.stepId) || step.sequence <= replay.lastSequence
        || (replay.steps.length && step.finishedAt < replay.steps.at(-1)!.finishedAt)) return false;
    const progressed = stepProgressed(replay, step);
    if (progressed !== record.progressed) return false;
    replay.stagnantSteps = progressed ? 0 : replay.stagnantSteps + 1;
    replay.lastSequence = step.sequence;
    replay.steps.push(record);
  }
  return replay.lastSequence === state.lastSequence && replay.stagnantSteps === state.stagnantSteps;
}

export interface TaskStepUpdate {
  accepted: boolean;
  reason: 'recorded' | 'duplicate' | 'duplicate_conflict' | 'out_of_order' | 'invalid_step' | 'capacity';
  progressed: boolean;
  stagnantSteps: number;
}

/** Mutates state only after validating the complete new record. Schema errors throw before mutation. */
export function observeTaskStep(state: TaskSupervisorState, input: TaskStepInput): TaskStepUpdate {
  const current = TaskSupervisorStateSchema.parse(state);
  if (!validState(current)) throw new Error('TASK_SUPERVISOR_INVALID_STATE');
  const step = TaskStepInputSchema.parse(input);
  const inputHash = objectHash(step);
  const result = (reason: TaskStepUpdate['reason']): TaskStepUpdate => ({ accepted: false, reason, progressed: false, stagnantSteps: state.stagnantSteps });
  const previous = current.steps.find(item => item.stepId === step.stepId);
  if (previous) return result(previous.inputHash === inputHash ? 'duplicate' : 'duplicate_conflict');
  if (step.sequence <= current.lastSequence || (current.steps.length && step.finishedAt < current.steps.at(-1)!.finishedAt)) return result('out_of_order');
  if (!validStep(step, current)) return result('invalid_step');
  if (current.steps.length >= MAX_STEPS) return result('capacity');
  const progressed = stepProgressed(current, step);
  const next: TaskSupervisorState = { ...current, lastSequence: step.sequence,
    stagnantSteps: progressed ? 0 : current.stagnantSteps + 1,
    steps: [...current.steps, { ...step, contractHash: current.contract.hash, inputHash, progressed }] };
  if (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_STATE_BYTES) return result('capacity');
  Object.assign(state, next);
  return { accepted: true, reason: 'recorded', progressed, stagnantSteps: next.stagnantSteps };
}

interface LinkedObservation { step: TaskStepRecord; observation: TaskObservation }
export type TaskCriterionStatus = 'verified' | 'failed' | 'unverified' | 'expired' | 'missing';
export interface TaskCriterionReview {
  id: string;
  required: boolean;
  status: TaskCriterionStatus;
  reason: 'matched' | 'contradicted' | 'missing_evidence' | 'expired_evidence' | 'future_evidence' | 'target_mismatch'
    | 'verification_unavailable' | 'answer_changed' | 'expectation_changed' | 'artifact_unbound' | 'newer_unverified_step';
  evidenceRef?: string;
}
export interface TaskCompletionReview {
  status: 'verified' | 'partial' | 'unverified' | 'failed' | 'unscoped' | 'unsupported';
  allowCompletion: boolean;
  shouldBlockCompletion: boolean;
  missingCriteria: string[];
  criteria: TaskCriterionReview[];
  stagnantSteps: number;
}

function sameTarget(criterion: TaskCriterion, observation: TaskObservation): boolean {
  return criterion.kind === 'navigation' || (criterion.kind === 'artifact' && criterion.artifactType === 'screenshot')
    ? navigationTarget(observation.target) === criterion.target : observation.target === criterion.target;
}

function reviewCriterion(criterion: TaskCriterion, state: TaskSupervisorState, now: number, answerHash: string | undefined): TaskCriterionReview {
  const result = (status: TaskCriterionStatus, reason: TaskCriterionReview['reason'], evidenceRef?: string): TaskCriterionReview =>
    ({ id: criterion.id, required: criterion.required, status, reason, ...(evidenceRef ? { evidenceRef } : {}) });
  const linked: LinkedObservation[] = state.steps.flatMap(step => step.observations.filter(observation => observation.criterionId === criterion.id).map(observation => ({ step, observation })));
  // Later contradictory/unknown evidence supersedes a former success. Within
  // one step a contradiction takes precedence when timestamps are identical.
  const priority = (item: LinkedObservation) => 'outcome' in item.observation && item.observation.outcome === 'contradicted' ? 2
    : 'outcome' in item.observation && item.observation.outcome === 'unknown' ? 1 : 0;
  linked.sort((a, b) => b.step.sequence - a.step.sequence || b.observation.observedAt - a.observation.observedAt || priority(b) - priority(a));
  const latest = linked[0];
  const affecting = state.steps.findLast(step => step.affects.includes(criterion.id));
  if (affecting && (!latest || affecting.sequence > latest.step.sequence)) return result('unverified', 'newer_unverified_step');
  if (!latest) return result('missing', 'missing_evidence');
  const { observation } = latest;
  if (observation.observedAt > now) return result('unverified', 'future_evidence');
  if (now - observation.observedAt > criterion.maxAgeMs) return result('expired', 'expired_evidence');
  if (!sameTarget(criterion, observation)) return result('unverified', 'target_mismatch');
  if (observation.kind === 'navigation') {
    return observation.httpStatus >= 200 && observation.httpStatus < 300
      ? result('verified', 'matched', observation.reference) : result('failed', 'contradicted', observation.reference);
  }
  if (observation.kind === 'answer_evidence') {
    if (!observation.independentlyVerified || observation.outcome === 'unknown') return result('unverified', 'verification_unavailable');
    if (observation.answerHash === taskEvidenceHash('')) return result('unverified', 'verification_unavailable');
    if (!answerHash || answerHash !== observation.answerHash) return result('unverified', 'answer_changed');
    return observation.outcome === 'confirmed' ? result('verified', 'matched', observation.reference) : result('failed', 'contradicted', observation.reference);
  }
  if (observation.kind === 'effect') {
    if (criterion.kind !== 'effect' || criterion.expectationHash !== observation.expectationHash) return result('unverified', 'expectation_changed');
    if (!observation.independentlyVerified || observation.source === 'tool-receipt' || observation.outcome === 'unknown') return result('unverified', 'verification_unavailable');
    return observation.outcome === 'confirmed' ? result('verified', 'matched', observation.reference) : result('failed', 'contradicted', observation.reference);
  }
  if (criterion.kind !== 'artifact' || criterion.artifactType !== observation.artifactType) return result('unverified', 'artifact_unbound');
  if (observation.artifactType === 'screenshot') {
    if (observation.artifactHash === taskEvidenceHash('')) return result('unverified', 'artifact_unbound');
    const page = state.steps.flatMap(step => step.observations).find(item => item.kind === 'navigation'
      && item.reference === observation.pageRef && sameTarget(criterion, item) && item.httpStatus >= 200 && item.httpStatus < 300
      && item.observedAt <= observation.observedAt && now - item.observedAt <= criterion.maxAgeMs);
    if (!page) return result('unverified', 'artifact_unbound');
  }
  return result('verified', 'matched', observation.reference);
}

export function reviewTaskCompletion(state: TaskSupervisorState, options: { now?: number; answerHash?: string } = {}): TaskCompletionReview {
  const current = TaskSupervisorStateSchema.parse(state);
  if (!validState(current)) throw new Error('TASK_SUPERVISOR_INVALID_STATE');
  const now = timeSchema.parse(options.now ?? Date.now());
  if (options.answerHash !== undefined) hashSchema.parse(options.answerHash);
  const criteria = current.contract.criteria.map(item => reviewCriterion(item, current, now, options.answerHash));
  const required = criteria.filter(item => item.required);
  const missingCriteria = required.filter(item => item.status !== 'verified').map(item => item.id);
  const status: TaskCompletionReview['status'] = current.contract.kind === 'unsupported' ? 'unsupported'
    : current.contract.kind === 'conversation' ? 'unscoped'
      : required.length > 0 && !missingCriteria.length ? 'verified'
        : required.some(item => item.status === 'failed') ? 'failed'
          : required.some(item => item.status === 'verified') ? 'partial' : 'unverified';
  const allowCompletion = status === 'verified' || status === 'unscoped';
  return { status, allowCompletion, shouldBlockCompletion: current.contract.mode === 'enforced' && !allowCompletion,
    missingCriteria, criteria, stagnantSteps: current.stagnantSteps };
}

/**
 * Restore only against the current host-built contract. Evidence from another
 * objective/revision cannot become valid by resuming an old JSON state. Snapshot
 * storage itself must be trusted; hashes here bind identity, not authenticate an
 * attacker with write access to the snapshot store.
 */
export function restoreTaskSupervisor(value: unknown, expected: TaskContract, options: { now?: number } = {}): TaskSupervisorState | null {
  try {
    if (!value || typeof value !== 'object' || !('steps' in value) || !Array.isArray(value.steps) || value.steps.length > MAX_STEPS) return null;
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_STATE_BYTES) return null;
    const state = TaskSupervisorStateSchema.parse(value);
    const contract = TaskContractSchema.parse(expected);
    const now = timeSchema.parse(options.now ?? Date.now());
    if (!validContract(contract) || !validContract(state.contract) || contract.hash !== state.contract.hash || state.startedAt > now) return null;
    const { version: _version, ...replayInput } = contractBody(contract);
    const replay = createTaskSupervisor({ ...replayInput, now: state.startedAt });
    for (const record of state.steps) {
      const step = parsedStep(record);
      if (record.contractHash !== contract.hash || objectHash(step) !== record.inputHash || step.finishedAt > now) return null;
      const update = observeTaskStep(replay, step);
      if (!update.accepted || update.progressed !== record.progressed) return null;
    }
    if (state.lastSequence !== replay.lastSequence || state.stagnantSteps !== replay.stagnantSteps) return null;
    return replay;
  } catch { return null; }
}

/** Adapter around the existing independent browser checker, never a model verdict. */
export function browserEffectTaskObservation(input: {
  criterion: Extract<TaskCriterion, { kind: 'effect' }>;
  expected: readonly AgentPostcondition[];
  report: AgentVerificationReport | undefined;
  page: Pick<AgentPage, 'id' | 'hash' | 'observedAt'>;
  actionRef: string;
  actionStartedAt: number;
  now?: number;
}): Extract<TaskObservation, { kind: 'effect' }> {
  const checked = assessBrowserVerification(input.expected, input.report, input.page, { actionStartedAt: input.actionStartedAt, now: input.now });
  return TaskObservationSchema.parse({
    kind: 'effect', source: 'browser-verifier', criterionId: input.criterion.id, target: input.criterion.target,
    reference: input.page.id, observedAt: Date.parse(input.page.observedAt), actionRef: input.actionRef,
    expectationHash: objectHash(input.expected), independentlyVerified: checked.status !== 'unverified',
    outcome: checked.status === 'verified' ? 'confirmed' : checked.status === 'failed' ? 'contradicted' : 'unknown',
  }) as Extract<TaskObservation, { kind: 'effect' }>;
}
