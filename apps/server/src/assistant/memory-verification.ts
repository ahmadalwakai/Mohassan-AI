import { z } from 'zod';
import { restoreComputationMemoryFlowState, validateComputationMemoryReadback, type ComputationMemoryFlowState } from './computation-memory-flow.js';
import { maskRequestLiteralData, parseUserRequestConstraints } from './request-constraints.js';
import { ClarifiedRequestSourceSchema } from './effective-request-source.js';
import { createTaskSupervisor, taskEvidenceHash, type TaskObservation, type TaskSupervisorState } from './task-supervisor.js';

/** Host-only recovery of a previous save's status. No write, permission, quota or old-run resumption is represented here. */
const instant = z.number().int().min(0).max(8_640_000_000_000_000);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1).max(160).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value));
const BindingSchema = z.object({ ownerId: identity, conversationId: identity, runId: identity, createdAt: instant }).strict();
export type MemoryVerificationBinding = z.infer<typeof BindingSchema>;
const AnchorSchema = z.object({ ownerId: identity, conversationId: identity, sourceRunId: identity, sourceCreatedAt: instant,
  sourceRequestHash: digest, operationKey: digest, receiptHash: digest, attemptedAt: instant, sourceEvaluatedAt: instant.optional() }).strict();
export type MemoryVerificationAnchor = z.infer<typeof AnchorSchema>;
const CheckSchema = z.object({ outcome: z.enum(['active', 'missing', 'unavailable', 'unknown']), checkedAt: instant }).strict();
export const MemoryVerificationStateSchema = z.object({ version: z.literal(1), kind: z.literal('memory_verification'),
  ownerId: identity, conversationId: identity, verificationRunId: identity, verificationCreatedAt: instant, verificationRequestHash: digest,
  source: AnchorSchema, lastCheck: CheckSchema.optional() }).strict();
export type MemoryVerificationState = z.infer<typeof MemoryVerificationStateSchema>;

/** Rows MUST come from an owner+conversation scoped host query, newest first LIMIT 2, before inserting the new run. */
export interface MemoryVerificationRun {
  id: string;
  ownerId: string;
  conversationId: string;
  goal: string;
  createdAt: number;
  /** Trusted host DB resolver result only; never receipt/model/state-provided time. */
  evaluatedAt?: number;
  status: string;
  state: unknown;
}
export interface MemoryVerificationRequest {
  version: 1;
  kind: 'memory_verification';
  requestHash: string;
  language: 'ar' | 'en';
  allowed: boolean;
  reason: 'recognized' | 'memory_read_forbidden' | 'ambiguous_constraints';
  /** Matching only. The full original request remains the hash/identity input. */
  questionSpan: { start: number; end: number };
}
export type MemoryVerificationBlockReason = 'not_verification' | 'memory_read_forbidden' | 'ambiguous_constraints' | 'invalid_input'
  | 'no_prior_run' | 'ambiguous_latest' | 'active_prior_run' | 'unrelated_prior_run' | 'invalid_prior_state';
export type MemoryVerificationSelection = { status: 'selected'; anchor: MemoryVerificationAnchor }
  | { status: 'blocked'; reason: MemoryVerificationBlockReason; text: string };
type AttemptedFlow = Exclude<ComputationMemoryFlowState, { phase: 'prepared' }>;
/** Ephemeral host data ONLY: never persist this object, offer it to a model, or put its flow in the current run's computationMemory. */
export interface MemoryVerificationSource {
  request: string;
  current: MemoryVerificationBinding;
  anchor: MemoryVerificationAnchor;
  sourceRequest: string;
  flow: AttemptedFlow;
}
export interface MemoryVerificationAssessment {
  scope: 'memory_read_status_only';
  status: 'completed' | 'partial' | 'blocked';
  persistence: 'verified' | 'missing' | 'unavailable' | 'unknown';
  reason: 'verified' | 'missing' | 'unavailable' | 'invalid_source' | 'invalid_clock' | 'invalid_readback';
  text: string;
  check?: z.infer<typeof CheckSchema>;
  /** The CURRENT run's read-status answer, never an effect or the old goal's completion. */
  observation?: Extract<TaskObservation, { kind: 'answer_evidence' }>;
}

const terminal = new Set(['completed', 'partial', 'blocked', 'failed', 'cancelled', 'interrupted']);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const textInput = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4000
  && !!value.trim() && !/[\u0000\ud800-\udfff]/u.test(value);
const fold = (value: string) => value.normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه')
  .toLowerCase().replace(/\s+/gu, ' ').trim();
const question = (value: string) => {
  const text = fold(value).replace(/^(?:(?:please|kindly|من فضلك|لو سمحت)[,،\s]+)+/u, '').replace(/[.!?؟\s]+$/u, '');
  return /^(?:(?:did you|have you) (?:save|store|record|remember)(?:d)? the (?:result|answer|value)|(?:was|has) the (?:result|answer|value) (?:been )?(?:saved|stored|recorded))(?: (?:in|to) (?:my|your|the) memory)?$/u.test(text)
    || /^(?:هل (?:حفظت|خزنت|سجلت|تذكرت) (?:النتيجه|الناتج|الجواب)|هل تم (?:حفظ|تخزين|تسجيل) (?:النتيجه|الناتج|الجواب))(?: في (?:ذاكرتي|ذاكرتك|الذاكره))?$/u.test(text);
};
function writeOnlyProhibition(value: string): boolean {
  const text = fold(value).replace(/^(?:(?:please|kindly|من فضلك|لو سمحت)[,،\s]+)+/u, '');
  return /^(?:do not|don't|don’t|never|avoid) (?:save|store|record|remember)(?: (?:anything|any (?:data|information)|it|this|that|the (?:result|answer|value)))?(?: (?:in|to) (?:my |your |the )?memory)?$/u.test(text)
    || /^(?:لا|ممنوع|بلاش) (?:تحفظ|تخزن|تسجل|تتذكر)(?: (?:اي شيء|شيئا|النتيجه|الناتج|الجواب|البيانات|المعلومات))?(?: في (?:ذاكرتي|ذاكرتك|الذاكره))?$/u.test(text);
}
const trimmedSpan = (raw: string, start: number, end: number) => {
  while (start < end && /[\s;؛,.!?؟،]/u.test(raw[start]!)) start++;
  while (end > start && /[\s;؛,.!?؟،]/u.test(raw[end - 1]!)) end--;
  return { start, end };
};

/** Closed past-tense status questions from the CURRENT outer user text only; no inferred action or tool authorization. */
export function recognizeMemoryVerificationRequest(raw: unknown): MemoryVerificationRequest | null {
  if (!textInput(raw) || maskRequestLiteralData(raw) !== raw) return null;
  try {
    const constraints = parseUserRequestConstraints(raw);
    let span = trimmedSpan(raw, 0, raw.length);
    if (constraints) {
      // Strip only exact parser-owned prohibition spans for matching. Unclassified
      // restrictions remain a veto, never permission. Any other positive clause fails.
      let matching = raw;
      for (const item of constraints.prohibitions) matching = matching.slice(0, item.span.start)
        + ' '.repeat(item.span.end - item.span.start) + matching.slice(item.span.end);
      // The parser owns each negative clause, but deliberately leaves its outer
      // conjunction outside both spans. Remove only a whole, pure linker gap
      // between two classified negatives. A positive/mixed body stays visible.
      const ordered = [...constraints.prohibitions].sort((left, right) => left.span.start - right.span.start);
      for (let index = 1; index < ordered.length; index++) {
        const before = ordered[index - 1]!, after = ordered[index]!;
        if (!before.capabilities.length || !after.capabilities.length || before.span.end > after.span.start
          || !/^(?:and|or|nor|و|او)$/u.test(fold(raw.slice(before.span.end, after.span.start)))) continue;
        matching = matching.slice(0, before.span.end) + ' '.repeat(after.span.start - before.span.end) + matching.slice(after.span.start);
      }
      span = trimmedSpan(matching, 0, matching.length);
      if (!question(matching.slice(span.start, span.end))) return null;
      const readVeto = constraints.forbiddenCapabilities.includes('memory_read');
      const onlyWrite = constraints.prohibitions.every(item => item.capabilities.length === 1 && item.capabilities[0] === 'memory_write'
        && writeOnlyProhibition(raw.slice(item.span.start, item.span.end)));
      // A write-only prefix is safe because the remaining anchored question has
      // no action. A suffix is accepted only with the parser's own safe span.
      const safePrefix = onlyWrite && constraints.prohibitions.every(item => item.span.end <= span.start);
      const safeSpan = onlyWrite && !constraints.ambiguous && constraints.positiveSpan?.start === span.start && constraints.positiveSpan.end === span.end;
      const allowed = !readVeto && (safePrefix || safeSpan);
      return { version: 1, kind: 'memory_verification', requestHash: taskEvidenceHash(raw), language: /\p{Script=Arabic}/u.test(raw) ? 'ar' : 'en', allowed,
        reason: readVeto ? 'memory_read_forbidden' : allowed ? 'recognized' : 'ambiguous_constraints', questionSpan: span };
    }
    if (!question(raw.slice(span.start, span.end))) return null;
    return { version: 1, kind: 'memory_verification', requestHash: taskEvidenceHash(raw), language: /\p{Script=Arabic}/u.test(raw) ? 'ar' : 'en',
      allowed: true, reason: 'recognized', questionSpan: span };
  } catch { return null; }
}

function blocked(raw: unknown, reason: MemoryVerificationBlockReason): Extract<MemoryVerificationSelection, { status: 'blocked' }> {
  const ar = typeof raw === 'string' && /\p{Script=Arabic}/u.test(raw);
  const text = reason === 'memory_read_forbidden'
    ? ar ? 'لم أقرأ الذاكرة لأن طلبك يمنع قراءتها.' : 'I did not read memory because this request forbids reading it.'
    : reason === 'active_prior_run'
      ? ar ? 'توجد مهمة معلّقة في هذه المحادثة. لم أستأنفها أو أتحقق من الحفظ.' : 'This conversation has a pending task. I have not resumed it or checked the save.'
      : ar ? 'لم أجد محاولة حفظ سابقة محددة وصالحة في هذه المحادثة يمكن التحقق منها.' : 'I could not identify a valid, unambiguous earlier save attempt in this conversation to check.';
  return { status: 'blocked', reason, text };
}
function validAnchor(value: unknown, current: MemoryVerificationBinding): MemoryVerificationAnchor | null {
  const parsed = AnchorSchema.safeParse(value);
  if (!parsed.success) return null;
  const anchor = parsed.data;
  const evaluatedAt = anchor.sourceEvaluatedAt ?? anchor.sourceCreatedAt;
  return anchor.ownerId === current.ownerId && anchor.conversationId === current.conversationId && anchor.sourceRunId !== current.runId
    && anchor.sourceCreatedAt < current.createdAt && evaluatedAt >= anchor.sourceCreatedAt
    && (anchor.sourceEvaluatedAt === undefined || anchor.sourceEvaluatedAt > anchor.sourceCreatedAt)
    && anchor.attemptedAt >= evaluatedAt && anchor.attemptedAt <= current.createdAt ? anchor : null;
}
function validRow(row: MemoryVerificationRun, current: MemoryVerificationBinding): boolean {
  return record(row) && identity.safeParse(row.id).success && row.id !== current.runId && row.ownerId === current.ownerId
    && row.conversationId === current.conversationId && instant.safeParse(row.createdAt).success && row.createdAt < current.createdAt
    && textInput(row.goal) && typeof row.status === 'string' && record(row.state)
    && (row.evaluatedAt === undefined || instant.safeParse(row.evaluatedAt).success && row.evaluatedAt >= row.createdAt && row.evaluatedAt <= current.createdAt)
    && (row.evaluatedAt === undefined || row.evaluatedAt === row.createdAt || 'clarifiedRequestSource' in row.state)
    && (!('clarifiedRequestSource' in row.state) || row.evaluatedAt !== undefined);
}
function effectiveRequest(row: MemoryVerificationRun): string | null {
  if (!record(row.state)) return null;
  if ('clarifiedRequest' in row.state) return textInput(row.state.clarifiedRequest) ? row.state.clarifiedRequest : null;
  return textInput(row.goal) ? row.goal : null;
}
function sourceFromRow(row: MemoryVerificationRun, current: MemoryVerificationBinding, now: number): { sourceRequest: string; flow: AttemptedFlow; anchor: MemoryVerificationAnchor } | null {
  if (!validRow(row, current) || !terminal.has(row.status) || !record(row.state) || 'memoryVerification' in row.state) return null;
  const sourceRequest = effectiveRequest(row);
  if (!sourceRequest) return null;
  if ('clarifiedRequestSource' in row.state) {
    const pointer = ClarifiedRequestSourceSchema.safeParse(row.state.clarifiedRequestSource);
    if (!pointer.success || pointer.data.requestHash !== taskEvidenceHash(sourceRequest)) return null;
  }
  const evaluatedAt = row.evaluatedAt ?? row.createdAt;
  const flow = restoreComputationMemoryFlowState(row.state.computationMemory, sourceRequest,
    { ownerId: row.ownerId, conversationId: row.conversationId, runId: row.id, evaluatedAt }, now);
  if (!flow || flow.phase === 'prepared') return null;
  const receipt = flow.receipt;
  const anchor = validAnchor({ ownerId: row.ownerId, conversationId: row.conversationId, sourceRunId: row.id, sourceCreatedAt: row.createdAt,
    sourceRequestHash: receipt.requestHash, operationKey: receipt.operationKey, receiptHash: taskEvidenceHash(JSON.stringify(receipt)), attemptedAt: flow.attemptedAt,
    ...(evaluatedAt !== row.createdAt ? { sourceEvaluatedAt: evaluatedAt } : {}) }, current);
  return anchor ? { sourceRequest, flow, anchor } : null;
}

/** No history scan. LIMIT 2 is needed to detect equal creation-time ambiguity; arbitrary UUID ordering is not evidence of recency. */
export function selectMemoryVerificationAnchor(raw: unknown, currentValue: MemoryVerificationBinding, recent: readonly MemoryVerificationRun[], now: number): MemoryVerificationSelection {
  try {
    const intent = recognizeMemoryVerificationRequest(raw);
    if (!intent) return blocked(raw, 'not_verification');
    if (!intent.allowed) return blocked(raw, intent.reason === 'memory_read_forbidden' ? 'memory_read_forbidden' : 'ambiguous_constraints');
    const parsed = BindingSchema.safeParse(currentValue);
    if (!parsed.success || !instant.safeParse(now).success || now < parsed.data.createdAt || !Array.isArray(recent) || recent.length > 2) return blocked(raw, 'invalid_input');
    const current = parsed.data;
    if (!recent.length) return blocked(raw, 'no_prior_run');
    if (recent.some(row => !validRow(row, current)) || recent.length === 2 && recent[0]!.createdAt < recent[1]!.createdAt) return blocked(raw, 'invalid_input');
    if (recent.length === 2 && (recent[0]!.createdAt === recent[1]!.createdAt || recent[0]!.id === recent[1]!.id)) return blocked(raw, 'ambiguous_latest');
    const latest = recent[0]!;
    if (!terminal.has(latest.status)) return blocked(raw, 'active_prior_run');
    if (record(latest.state) && 'memoryVerification' in latest.state) {
      if ('computationMemory' in latest.state) return blocked(raw, 'invalid_prior_state');
      const priorRequest = effectiveRequest(latest);
      const prior = priorRequest && restoreMemoryVerificationState(latest.state.memoryVerification, priorRequest,
        { ownerId: latest.ownerId, conversationId: latest.conversationId, runId: latest.id, createdAt: latest.createdAt });
      const anchor = prior && (!prior.lastCheck || prior.lastCheck.checkedAt <= current.createdAt) && validAnchor(prior.source, current);
      return anchor ? { status: 'selected', anchor } : blocked(raw, 'invalid_prior_state');
    }
    const source = sourceFromRow(latest, current, now);
    return source ? { status: 'selected', anchor: source.anchor } : blocked(raw, record(latest.state) && 'computationMemory' in latest.state ? 'invalid_prior_state' : 'unrelated_prior_run');
  } catch { return blocked(raw, 'invalid_input'); }
}

/** Persist only this flattened identity pointer and current check metadata, never the old payload or write state. */
export function createMemoryVerificationState(raw: unknown, currentValue: MemoryVerificationBinding, anchorValue: MemoryVerificationAnchor,
  lastCheck?: z.infer<typeof CheckSchema>): MemoryVerificationState | null {
  try {
    const intent = recognizeMemoryVerificationRequest(raw), current = BindingSchema.safeParse(currentValue);
    if (!intent?.allowed || !current.success) return null;
    const source = validAnchor(anchorValue, current.data);
    if (!source || lastCheck && (!CheckSchema.safeParse(lastCheck).success || lastCheck.checkedAt < current.data.createdAt)) return null;
    return MemoryVerificationStateSchema.parse({ version: 1, kind: 'memory_verification', ownerId: current.data.ownerId, conversationId: current.data.conversationId,
      verificationRunId: current.data.runId, verificationCreatedAt: current.data.createdAt, verificationRequestHash: intent.requestHash,
      source, ...(lastCheck ? { lastCheck } : {}) });
  } catch { return null; }
}
export function restoreMemoryVerificationState(value: unknown, raw: unknown, current: MemoryVerificationBinding): MemoryVerificationState | null {
  try {
    const parsed = MemoryVerificationStateSchema.safeParse(value);
    if (!parsed.success) return null;
    const expected = createMemoryVerificationState(raw, current, parsed.data.source, parsed.data.lastCheck);
    return expected && JSON.stringify(parsed.data) === JSON.stringify(expected) ? expected : null;
  } catch { return null; }
}

/** Reload the exact original owner+conversation+run row on EVERY check, even when a prior verification pointer was selected. */
export function restoreMemoryVerificationSource(raw: unknown, currentValue: MemoryVerificationBinding, anchorValue: MemoryVerificationAnchor,
  original: MemoryVerificationRun, now: number): MemoryVerificationSource | null {
  try {
    const current = BindingSchema.safeParse(currentValue), intent = recognizeMemoryVerificationRequest(raw);
    if (!current.success || !intent?.allowed || !textInput(raw) || !instant.safeParse(now).success || now < current.data.createdAt) return null;
    const anchor = validAnchor(anchorValue, current.data);
    if (!anchor || original.id !== anchor.sourceRunId || original.createdAt !== anchor.sourceCreatedAt) return null;
    const source = sourceFromRow(original, current.data, now);
    return source && JSON.stringify(anchor) === JSON.stringify(source.anchor)
      ? { request: raw, current: current.data, anchor, sourceRequest: source.sourceRequest, flow: source.flow } : null;
  } catch { return null; }
}

const target = (anchor: MemoryVerificationAnchor) => `memory-status:${anchor.sourceRunId}:${anchor.operationKey}`;
export function createMemoryVerificationSupervisor(raw: unknown, current: MemoryVerificationBinding, anchor: MemoryVerificationAnchor): TaskSupervisorState | null {
  if (!createMemoryVerificationState(raw, current, anchor) || !textInput(raw)) return null;
  return createTaskSupervisor({ id: current.runId, objective: raw, kind: 'task', mode: 'advisory', now: current.createdAt,
    criteria: [{ id: 'memory-status-answer', kind: 'answer_evidence', target: target(anchor), required: true,
      description: 'Fresh readback confirms the selected original save is still active; this answer certifies no new write or old task completion.' }] });
}

/** Assess ONLY the result of a direct reconcileExact read with trusted host clock brackets. The caller fences the CURRENT run before and after I/O. */
export function assessMemoryVerificationReadback(source: MemoryVerificationSource, value: unknown,
  bracket: { startedAt: number; finishedAt: number }): MemoryVerificationAssessment {
  const ar = record(source) && typeof source.request === 'string' && /\p{Script=Arabic}/u.test(source.request);
  const unknown = ar ? 'لم أتمكن من التحقق من حالة محاولة الحفظ هذه في الذاكرة الآن.' : 'I could not verify the current memory status of that save attempt.';
  const failure = (reason: 'invalid_source' | 'invalid_clock' | 'invalid_readback'): MemoryVerificationAssessment => ({ scope: 'memory_read_status_only',
    status: reason === 'invalid_source' ? 'blocked' : 'partial', persistence: 'unknown', reason, text: unknown,
    ...(reason === 'invalid_readback' ? { check: { outcome: 'unknown' as const, checkedAt: bracket.finishedAt } } : {}) });
  try {
    if (!record(bracket) || !instant.safeParse(bracket.startedAt).success || !instant.safeParse(bracket.finishedAt).success || bracket.finishedAt < bracket.startedAt) return failure('invalid_clock');
    if (!record(source) || !record(source.current) || !record(source.anchor) || !createMemoryVerificationState(source.request, source.current, source.anchor)) return failure('invalid_source');
    const { current, anchor } = source;
    if (bracket.startedAt < current.createdAt) return failure('invalid_clock');
    const flow = restoreComputationMemoryFlowState(source.flow, source.sourceRequest,
      { ownerId: anchor.ownerId, conversationId: anchor.conversationId, runId: anchor.sourceRunId,
        evaluatedAt: anchor.sourceEvaluatedAt ?? anchor.sourceCreatedAt }, bracket.finishedAt);
    if (!flow || flow.phase === 'prepared' || flow.attemptedAt !== anchor.attemptedAt || flow.receipt.requestHash !== anchor.sourceRequestHash
      || flow.receipt.operationKey !== anchor.operationKey || taskEvidenceHash(JSON.stringify(flow.receipt)) !== anchor.receiptHash) return failure('invalid_source');
    const checked = validateComputationMemoryReadback(value, flow.receipt, flow, bracket.startedAt, bracket.finishedAt);
    if (!checked) return failure('invalid_readback');
    if (checked.status !== 'verified') return { scope: 'memory_read_status_only', status: 'partial', persistence: checked.status, reason: checked.status,
      text: checked.status === 'missing'
        ? ar ? 'لم يظهر سجل حفظ ملتزم لمحاولة الحفظ هذه وقت التحقق. لم أؤكد أن النتيجة محفوظة.' : 'No committed record was visible for that save attempt at the time of this check. I could not confirm that the result remains saved.'
        : ar ? 'يوجد سجل لعملية الحفظ، لكن الملاحظة المرتبطة به ليست متاحة كذاكرة نشطة الآن.' : 'The save operation has a record, but its memory item is not available as active now.',
      check: { outcome: checked.status, checkedAt: bracket.finishedAt } };
    const text = ar ? 'نعم، تحققت الآن من أن النتيجة المحفوظة ما زالت نشطة في ذاكرتك.' : 'Yes. I verified that the saved result is currently active in your memory.';
    return { scope: 'memory_read_status_only', status: 'completed', persistence: 'verified', reason: 'verified', text,
      check: { outcome: 'active', checkedAt: bracket.finishedAt }, observation: { kind: 'answer_evidence', source: 'memory-read', criterionId: 'memory-status-answer',
        target: target(anchor), reference: `memory-status:${anchor.operationKey}:${checked.item.id}:v${checked.item.version}`,
        observedAt: Date.parse(checked.observedAt), outcome: 'confirmed', independentlyVerified: true, answerHash: taskEvidenceHash(text) } };
  } catch { return failure('invalid_source'); }
}
