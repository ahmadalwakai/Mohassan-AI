import { createHash, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { redactCredentialText } from '@mohassan/cognitive';
import { redactSecrets } from '@mohassan/providers';

export const experienceSourceKinds = ['chat_run', 'runtime_task'] as const;
export type ExperienceSourceKind = (typeof experienceSourceKinds)[number];
export type ExperienceCategory = 'conversation' | 'research' | 'browser' | 'coding' | 'computer';
export type ExperienceOutcome = 'verified_success' | 'verified_failure' | 'unverified';
type ObservationKind = 'test_result' | 'page_observation' | 'api_readback';

export interface ExperienceExpectation {
  kind: ObservationKind;
  target: string;
  value: string | number | boolean | null;
}

export interface ExperienceObservation extends ExperienceExpectation {
  reference: string;
}

interface ExperienceIdentity {
  ownerId: string;
  sourceKind: ExperienceSourceKind;
  sourceId: string;
}

export interface ExperienceInput extends ExperienceIdentity {
  parentRunId?: string | null;
  attempt?: number;
  goal: string;
  category: ExperienceCategory;
  terminalStatus: string;
  plan?: readonly string[];
  trail?: readonly { step: number; action: string; result?: string; changed?: boolean | null }[];
  models?: readonly { model: string; inputTokens: number | null; outputTokens: number | null; usageKnown: boolean }[];
  artifactHashes?: readonly string[];
  expected?: ExperienceExpectation;
  observation?: ExperienceObservation;
  redact?: (text: string) => string;
}

const terminalStatuses = new Set(['completed', 'partial', 'blocked', 'failed', 'cancelled', 'interrupted']);
const observationKinds = new Set(['test_result', 'page_observation', 'api_readback']);
const tools = new Set([
  'open', 'click', 'type', 'select', 'press', 'scroll', 'back', 'wait', 'read_more',
  'search', 'look', 'ask_user', 'request_login', 'hands_on', 'answer', 'load_skill', 'run_skill',
  'memory_search', 'memory_save', 'workspace_list', 'code_change', 'studio_change',
  'computer_view', 'computer_click', 'computer_type', 'computer_key',
  'ads_check', 'ads_status', 'ads_report', 'ads_draft', 'ads_create_paused',
  'system.diagnostic', 'plan.draft', 'coding.change', 'studio.change', 'browser.open',
  'skill.run', 'skill.node', 'skill.rollback',
]);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/i;
const modelPattern = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i;

function sanitizeText(value: string, limit: number, redact?: (text: string) => string): string {
  return redactCredentialText(redactSecrets(redact ? redact(value) : value))
    .replace(/data:[^,\s]+,[^\s"'<>]+/gi, '[محتوى محجوب]')
    .replace(/(?:https?|ftp):\/\/[^\s"'<>]+/gi, '[رابط محجوب]')
    .replace(/\b(?:ghp_|github_pat_|xox[baprs]-|AIza)[a-z0-9_-]{12,}/gi, '[اعتماد محجوب]')
    .replace(/\bBearer[ \t]+[a-z0-9._~+/=-]+/gi, 'Bearer [محجوب]')
    .replace(/\b(password|passwd|pin|secret|authorization|api[_ -]?key|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token)\s*(?:[:=]|\bis\b)\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1=[محجوب]')
    .replace(/(كلمة المرور\s*(?:هي|[:=])\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s،؛]+)/gu, '$1[محجوب]')
    .replace(/(?<!\p{Decimal_Number})(?:\p{Decimal_Number}[ -]?){12,}\p{Decimal_Number}(?!\p{Decimal_Number})/gu, '[رقم محجوب]')
    .replace(/((?:\b(?:otp|one[- ]time (?:code|password)|verification code|cvv|cvc)\b|رمز التحقق|رمز الأمان)\s*(?:is|هو|[:=])?\s*)[\p{Decimal_Number} -]{3,12}/giu, '$1[محجوب]')
    .replace(/^\s*\p{Decimal_Number}{4,8}\s*$/u, '[رقم محجوب]')
    .replaceAll('\u0000', '')
    .slice(0, limit);
}

function validValue(value: ExperienceExpectation['value']): boolean {
  return value === null || typeof value === 'boolean' || typeof value === 'string' || Number.isFinite(value);
}

/**
 * The caller supplies a requirement established before execution and an observation
 * read by a trusted verifier. A tool action or a model verdict is not an observation.
 */
export function classifyExperience(expected?: ExperienceExpectation, observation?: ExperienceObservation): ExperienceOutcome {
  if (!expected || !observation || !observationKinds.has(expected.kind) ||
      expected.kind !== observation.kind || !expected.target.trim() || expected.target !== observation.target ||
      !observation.reference.trim() || !validValue(expected.value) || !validValue(observation.value)) return 'unverified';
  return expected.value === observation.value ? 'verified_success' : 'verified_failure';
}

function modelUsage(input: NonNullable<ExperienceInput['models']>, redact?: ExperienceInput['redact']) {
  return input.slice(0, 128).flatMap(({ model, inputTokens, outputTokens, usageKnown }) => {
    if (!modelPattern.test(model) || sanitizeText(model, 128, redact) !== model) return [];
    const known = usageKnown && inputTokens !== null && outputTokens !== null &&
      Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens) && inputTokens >= 0 && outputTokens >= 0;
    return [{ model, inputTokens: known ? inputTokens : null, outputTokens: known ? outputTokens : null, usageKnown: known }];
  });
}

/** Insert once per owner and source, or advance the same row for a newer attempt. */
export async function recordExperience(db: Kysely<any>, input: ExperienceInput): Promise<void> {
  if (!terminalStatuses.has(input.terminalStatus)) throw new Error('EXPERIENCE_REQUIRES_TERMINAL_STATUS');
  const attempt = input.attempt ?? 1;
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > 2_147_483_647) throw new Error('EXPERIENCE_INVALID_ATTEMPT');
  const { expected, observation, redact } = input;
  const outcome = classifyExperience(expected, observation);
  const evidence = outcome !== 'unverified' && expected && observation ? {
    targetHash: hash(expected.target),
    expectedHash: hash(JSON.stringify(expected.value)),
    observedHash: hash(JSON.stringify(observation.value)),
    referenceHash: hash(observation.reference),
  } : null;
  const trail = (input.trail ?? []).slice(-128).map(({ step, action, result, changed }) => {
    const tool = action.trim().split(/\s/, 1)[0];
    return {
      step,
      action: tools.has(tool) ? tool : 'other',
      resultHash: result === undefined ? null : hash(sanitizeText(result, 16_384, redact)),
      changed: changed ?? null,
    };
  });
  const values = {
    parent_run_id: input.parentRunId ?? null,
    attempt,
    goal: sanitizeText(input.goal, 2_000, redact),
    category: input.category,
    terminal_status: input.terminalStatus,
    plan: JSON.stringify((input.plan ?? []).slice(0, 32).map(step => sanitizeText(step, 320, redact))),
    trail: JSON.stringify(trail),
    models: JSON.stringify(modelUsage(input.models ?? [], redact)),
    artifact_hashes: JSON.stringify([...new Set((input.artifactHashes ?? []).filter(value => hashPattern.test(value)).map(value => value.toLowerCase()))].slice(0, 64)),
    outcome,
    evidence_kind: evidence && observation ? observation.kind : 'none',
    evidence: evidence ? JSON.stringify(evidence) : null,
  };
  await db.insertInto('experiences').values({
    owner_id: input.ownerId, source_kind: input.sourceKind, source_id: input.sourceId, ...values,
  }).onConflict(conflict => conflict.columns(['owner_id', 'source_kind', 'source_id'])
    .doUpdateSet({ ...values, updated_at: new Date() })
    .whereRef('experiences.attempt', '<', 'excluded.attempt')).execute();
}

export const ExperienceFeedbackSchema = z.object({
  submissionKey: z.string().min(8).max(100),
  expectedAttempt: z.number().int().min(0).max(2_147_483_647).optional(),
  rating: z.number().int().min(1).max(5).optional(),
  confirmed: z.enum(['success', 'failure']).optional(),
  memoryFeedbackId: z.uuid().optional(),
}).strict()
  .refine(input => input.rating !== undefined || input.confirmed !== undefined || input.memoryFeedbackId !== undefined)
  .refine(input => input.expectedAttempt !== undefined || (input.memoryFeedbackId !== undefined && input.confirmed === undefined));

export class ExperienceFeedbackError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'ExperienceFeedbackError';
  }
}

type FeedbackInput = ExperienceIdentity & z.infer<typeof ExperienceFeedbackSchema>;

/** Feedback is owner scoped. Only an explicit confirmation can establish an otherwise unverified outcome. */
export async function recordExperienceFeedback(
  db: Kysely<any>,
  { ownerId, sourceKind, sourceId, ...payload }: FeedbackInput,
): Promise<{ id: string; outcome: ExperienceOutcome }> {
  const parsed = ExperienceFeedbackSchema.safeParse(payload);
  if (!parsed.success) throw new ExperienceFeedbackError('EXPERIENCE_FEEDBACK_INVALID', 'بيانات التقييم غير صالحة.', 400);
  const request = parsed.data;
  const write = async (tx: Kysely<any>) => {
    const experience = await tx.selectFrom('experiences').select(['attempt', 'outcome', 'evidence_kind'])
      .where('owner_id', '=', ownerId).where('source_kind', '=', sourceKind).where('source_id', '=', sourceId)
      .forUpdate().executeTakeFirst();
    if (!experience) throw new ExperienceFeedbackError('EXPERIENCE_NOT_FOUND', 'لم يُعثر على التجربة.', 404);
    if (request.expectedAttempt !== undefined && request.expectedAttempt !== experience.attempt) {
      throw new ExperienceFeedbackError('EXPERIENCE_ATTEMPT_CHANGED', 'تغيّرت محاولة التنفيذ. حدّث التجربة قبل تقييمها.', 409);
    }

    let rating = request.rating ?? null;
    if (request.memoryFeedbackId) {
      const feedback = await tx.selectFrom('memory_feedback as f').innerJoin('tasks as t', 't.id', 'f.task_id')
        .select(['f.rating', 't.id', 't.experience_parent_run_id'])
        .where('f.id', '=', request.memoryFeedbackId).where('f.owner_id', '=', ownerId).where('t.owner_id', '=', ownerId)
        .executeTakeFirst();
      const linkedSource = sourceKind === 'chat_run' ? feedback?.experience_parent_run_id : feedback?.id;
      if (!feedback || linkedSource !== sourceId || (rating !== null && rating !== feedback.rating)) {
        throw new ExperienceFeedbackError('EXPERIENCE_FEEDBACK_UNLINKED', 'التقييم غير مرتبط بهذه التجربة.', 400);
      }
      rating = feedback.rating;
    }
    const confirmed = request.confirmed ?? null;
    if (rating === null && confirmed === null) {
      throw new ExperienceFeedbackError('EXPERIENCE_FEEDBACK_INVALID', 'يلزم إدخال درجة أو تأكيد النتيجة.', 400);
    }

    const submissionHash = hash(request.submissionKey);
    const inserted = await tx.insertInto('experience_feedback').values({
      id: randomUUID(), owner_id: ownerId, source_kind: sourceKind, source_id: sourceId, attempt: experience.attempt,
      submission_hash: submissionHash, rating, confirmed, memory_feedback_id: request.memoryFeedbackId ?? null,
    }).onConflict(conflict => conflict.columns(['owner_id', 'submission_hash']).doNothing()).returning('id').executeTakeFirst();
    let outcome: ExperienceOutcome = experience.outcome;
    if (!inserted) {
      const existing = await tx.selectFrom('experience_feedback').selectAll()
        .where('owner_id', '=', ownerId).where('submission_hash', '=', submissionHash).executeTakeFirstOrThrow();
      if (existing.source_kind !== sourceKind || existing.source_id !== sourceId || existing.rating !== rating ||
          existing.confirmed !== confirmed || existing.memory_feedback_id !== (request.memoryFeedbackId ?? null) ||
          (request.expectedAttempt !== undefined && existing.attempt !== request.expectedAttempt)) {
        throw new ExperienceFeedbackError('EXPERIENCE_FEEDBACK_CONFLICT', 'مفتاح التقييم مرتبط بطلب مختلف.', 409);
      }
      return { id: existing.id as string, outcome };
    }
    if (confirmed && (experience.evidence_kind === 'none' || experience.evidence_kind === 'owner_confirmed')) {
      outcome = confirmed === 'success' ? 'verified_success' : 'verified_failure';
      await tx.updateTable('experiences').set({
        outcome, evidence_kind: 'owner_confirmed', evidence: JSON.stringify({ referenceHash: hash(inserted.id) }),
        updated_at: new Date(),
      }).where('owner_id', '=', ownerId).where('source_kind', '=', sourceKind).where('source_id', '=', sourceId).execute();
    }
    return { id: inserted.id as string, outcome };
  };
  return db.isTransaction ? write(db) : db.transaction().execute(write);
}
