import { z } from 'zod';
import { ClarifiedRequestSourceSchema } from './effective-request-source.js';
import { restoreUserFactMemoryFlowState, validateUserFactMemoryReadback, type UserFactMemoryFlowState } from './user-fact-memory-flow.js';
import { maskRequestLiteralData, parseUserRequestConstraints } from './request-constraints.js';
import { createTaskSupervisor, taskEvidenceHash, type TaskObservation, type TaskSupervisorState } from './task-supervisor.js';

const instant = z.number().int().min(0).max(8_640_000_000_000_000);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const identity = z.string().min(1).max(160).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value));
const BindingSchema = z.object({ ownerId: identity, conversationId: identity, runId: identity, createdAt: instant, evaluatedAt: instant }).strict()
  .refine(value => value.evaluatedAt >= value.createdAt);
export type UserFactMemoryVerificationBinding = z.infer<typeof BindingSchema>;
const AnchorSchema = z.object({ ownerId: identity, conversationId: identity, sourceRunId: identity, sourceCreatedAt: instant, sourceEvaluatedAt: instant,
  sourceOriginalRequestHash: digest, sourceRequestHash: digest, receiptHash: digest, operationKey: digest, attemptedAt: instant }).strict();
export type UserFactMemoryVerificationAnchor = z.infer<typeof AnchorSchema>;
const CheckSchema = z.object({ outcome: z.enum(['active', 'missing', 'unavailable', 'unknown']), checkedAt: instant }).strict();
export const UserFactMemoryVerificationStateSchema = z.object({ version: z.literal(1), kind: z.literal('user_fact_memory_verification'),
  ownerId: identity, conversationId: identity, verificationRunId: identity, verificationCreatedAt: instant, verificationEvaluatedAt: instant,
  verificationRequestHash: digest, source: AnchorSchema, lastCheck: CheckSchema.optional() }).strict();
export type UserFactMemoryVerificationState = z.infer<typeof UserFactMemoryVerificationStateSchema>;
/** Host DB projection only, scoped to the current owner+conversation. Neither time nor original hash may be copied from a receipt. */
export interface UserFactMemoryVerificationRun {
  id: string; ownerId: string; conversationId: string; goal: string; createdAt: number;
  /** Resolved from the actual DB run/user clarification message by the trusted host. */
  evaluatedAt: number;
  /** Separate pre-schema hash pinned in host run metadata. Mandatory for the original literal-save run. */
  originalRequestHash?: string;
  status: string; state: unknown;
}
export interface UserFactMemoryVerificationRequest {
  version: 1; kind: 'user_fact_memory_verification'; requestHash: string; language: 'ar' | 'en'; allowed: boolean;
  reason: 'recognized' | 'memory_read_forbidden' | 'ambiguous_constraints'; questionSpan: { start: number; end: number };
}
export type UserFactMemoryVerificationBlockReason = 'not_verification' | 'memory_read_forbidden' | 'ambiguous_constraints' | 'invalid_input'
  | 'no_prior_run' | 'ambiguous_latest' | 'active_prior_run' | 'unrelated_prior_run' | 'invalid_prior_state';
export type UserFactMemoryVerificationSelection = { status: 'selected'; anchor: UserFactMemoryVerificationAnchor }
  | { status: 'blocked'; reason: UserFactMemoryVerificationBlockReason; text: string };
type Attempted = Exclude<UserFactMemoryFlowState, { phase: 'prepared' }>;
/** Ephemeral host data. Persist ONLY the flattened verification state, never this old request/payload/flow. */
export interface UserFactMemoryVerificationSource {
  request: string; current: UserFactMemoryVerificationBinding; anchor: UserFactMemoryVerificationAnchor; sourceRequest: string; flow: Attempted;
}
export interface UserFactMemoryVerificationAssessment {
  scope: 'user_statement_memory_read_status_only'; status: 'completed' | 'partial' | 'blocked'; persistence: 'verified' | 'missing' | 'unavailable' | 'unknown';
  reason: 'verified' | 'missing' | 'unavailable' | 'invalid_source' | 'invalid_clock' | 'invalid_readback'; text: string;
  check?: z.infer<typeof CheckSchema>; observation?: Extract<TaskObservation, { kind: 'answer_evidence' }>;
}
const terminal = new Set(['completed', 'partial', 'blocked', 'failed', 'cancelled', 'interrupted']);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function own(value: unknown, field: string): { present: boolean; value?: unknown; invalid?: boolean } {
  if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return { present: false, invalid: true };
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (!descriptor) return { present: false, ...(field in value ? { invalid: true } : {}) };
  return 'value' in descriptor && descriptor.enumerable ? { present: true, value: descriptor.value } : { present: true, invalid: true };
}
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4000 && !!value.trim()
  && !/[\u0000\ud800-\udfff]/u.test(value);
const fold = (value: string) => value.normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه')
  .toLowerCase().replace(/\s+/gu, ' ').trim();
const lead = (value: string) => fold(value).replace(/^(?:(?:please|kindly|من فضلك|لو سمحت)[,،\s]+)+/u, '');
function question(value: string): boolean {
  const view = lead(value).replace(/[.!?؟\s]+$/u, '');
  return /^(?:(?:did you (?:save|store|record|remember)|have you (?:saved|stored|recorded|remembered)) (?:the|my) note|was (?:the|my) note (?:saved|stored|recorded)|has (?:the|my) note been (?:saved|stored|recorded))(?: (?:in|to) (?:my|your|the) memory)?$/u.test(view)
    || /^(?:هل (?:حفظت|خزنت|سجلت|تذكرت) (?:الملاحظه|ملاحظتي)|هل تم (?:حفظ|تخزين|تسجيل) (?:الملاحظه|ملاحظتي))(?: في (?:ذاكرتي|ذاكرتك|الذاكره))?$/u.test(view);
}
const writeOnly = (value: string) => /^(?:do not|don't|don’t|never|avoid) (?:save|store|record|remember)(?: (?:anything|any (?:data|information)|it|this|that|the (?:note|statement)))?(?: (?:in|to) (?:my |your |the )?memory)?$/u.test(lead(value))
  || /^(?:لا|ممنوع|بلاش) (?:تحفظ|تخزن|تسجل|تتذكر)(?: (?:اي شيء|شيئا|الملاحظه|العباره|البيانات|المعلومات))?(?: في (?:ذاكرتي|ذاكرتك|الذاكره))?$/u.test(lead(value));
const trimmed = (raw: string, start: number, end: number) => {
  while (start < end && /[\s;؛,.!?؟،]/u.test(raw[start]!)) start++;
  while (end > start && /[\s;؛,.!?؟،]/u.test(raw[end - 1]!)) end--;
  return { start, end };
};

/** Closed CURRENT USER note-status wording only. Never rewrites a note question into the calculation verifier or grants memory authority. */
export function recognizeUserFactMemoryVerificationRequest(raw: unknown): UserFactMemoryVerificationRequest | null {
  if (!text(raw) || maskRequestLiteralData(raw) !== raw) return null;
  try {
    const constraints = parseUserRequestConstraints(raw);
    let span = trimmed(raw, 0, raw.length), allowed = true, reason: UserFactMemoryVerificationRequest['reason'] = 'recognized';
    if (constraints) {
      let matching = raw;
      const ordered = [...constraints.prohibitions].sort((a, b) => a.span.start - b.span.start);
      for (const item of ordered) matching = matching.slice(0, item.span.start) + ' '.repeat(item.span.end - item.span.start) + matching.slice(item.span.end);
      for (let index = 1; index < ordered.length; index++) {
        const before = ordered[index - 1]!, after = ordered[index]!;
        if (before.capabilities.length && after.capabilities.length && before.span.end <= after.span.start
          && /^(?:and|or|nor|و|او)$/u.test(fold(raw.slice(before.span.end, after.span.start))))
          matching = matching.slice(0, before.span.end) + ' '.repeat(after.span.start - before.span.end) + matching.slice(after.span.start);
      }
      span = trimmed(matching, 0, matching.length);
      if (!question(matching.slice(span.start, span.end))) return null;
      const veto = constraints.forbiddenCapabilities.includes('memory_read');
      const writes = ordered.every(item => item.capabilities.length === 1 && item.capabilities[0] === 'memory_write' && writeOnly(raw.slice(item.span.start, item.span.end)));
      allowed = !veto && writes && (ordered.every(item => item.span.end <= span.start)
        || !constraints.ambiguous && constraints.positiveSpan?.start === span.start && constraints.positiveSpan.end === span.end);
      reason = veto ? 'memory_read_forbidden' : allowed ? 'recognized' : 'ambiguous_constraints';
    } else if (!question(raw.slice(span.start, span.end))) return null;
    return { version: 1, kind: 'user_fact_memory_verification', requestHash: taskEvidenceHash(raw), language: /\p{Script=Arabic}/u.test(raw) ? 'ar' : 'en',
      allowed, reason, questionSpan: span };
  } catch { return null; }
}

function blocked(raw: unknown, reason: UserFactMemoryVerificationBlockReason): Extract<UserFactMemoryVerificationSelection, { status: 'blocked' }> {
  const ar = typeof raw === 'string' && /\p{Script=Arabic}/u.test(raw);
  return { status: 'blocked', reason, text: reason === 'memory_read_forbidden'
    ? ar ? 'لم أقرأ الذاكرة لأن طلبك يمنع قراءتها.' : 'I did not read memory because this request forbids reading it.'
    : reason === 'active_prior_run'
      ? ar ? 'توجد مهمة معلقة في هذه المحادثة. لم أستأنفها أو أتحقق من الملاحظة.' : 'This conversation has a pending task. I have not resumed it or checked the note.'
      : ar ? 'لم أجد محاولة حفظ ملاحظة سابقة محددة وصالحة في هذه المحادثة للتحقق منها.' : 'I could not identify a valid, unambiguous earlier note-save attempt in this conversation to check.' };
}
function anchorFor(value: unknown, current: UserFactMemoryVerificationBinding): UserFactMemoryVerificationAnchor | null {
  const parsed = AnchorSchema.safeParse(value);
  if (!parsed.success) return null;
  const a = parsed.data;
  return a.ownerId === current.ownerId && a.conversationId === current.conversationId && a.sourceRunId !== current.runId
    && a.sourceCreatedAt < current.createdAt && a.sourceEvaluatedAt >= a.sourceCreatedAt && a.attemptedAt >= a.sourceEvaluatedAt
    && a.attemptedAt <= current.createdAt && a.sourceRequestHash === a.sourceOriginalRequestHash ? a : null;
}
function rowRecency(row: UserFactMemoryVerificationRun, current: UserFactMemoryVerificationBinding): boolean {
  return record(row) && identity.safeParse(row.id).success && row.id !== current.runId && row.ownerId === current.ownerId
    && row.conversationId === current.conversationId && instant.safeParse(row.createdAt).success && row.createdAt < current.createdAt && typeof row.status === 'string';
}
function rowRequest(row: UserFactMemoryVerificationRun, current: UserFactMemoryVerificationBinding): string | null {
  if (!rowRecency(row, current) || !instant.safeParse(row.evaluatedAt).success
    || row.evaluatedAt < row.createdAt || row.evaluatedAt > current.createdAt || !text(row.goal) || typeof row.status !== 'string') return null;
  const clarified = own(row.state, 'clarifiedRequest'), pointer = own(row.state, 'clarifiedRequestSource');
  if (clarified.invalid || pointer.invalid || pointer.present !== clarified.present || row.evaluatedAt !== row.createdAt && !pointer.present) return null;
  const request = clarified.present ? clarified.value : row.goal;
  if (!text(request)) return null;
  if (pointer.present) {
    const parsed = ClarifiedRequestSourceSchema.safeParse(pointer.value);
    if (!parsed.success || parsed.data.requestHash !== taskEvidenceHash(request)) return null;
  }
  return request;
}
function originalSource(row: UserFactMemoryVerificationRun, current: UserFactMemoryVerificationBinding, now: number) {
  const sourceRequest = rowRequest(row, current);
  if (!sourceRequest || !terminal.has(row.status)) return null;
  for (const key of ['computationMemory', 'memoryVerification', 'userFactMemoryVerification']) {
    const field = own(row.state, key); if (field.invalid || field.present) return null;
  }
  const metadata = own(row.state, 'requestOriginalHash'), stored = own(row.state, 'userFactMemory');
  if (metadata.invalid || !metadata.present || !digest.safeParse(metadata.value).success || metadata.value !== row.originalRequestHash
    || !stored.present || stored.invalid || row.originalRequestHash !== taskEvidenceHash(sourceRequest)) return null;
  const flow = restoreUserFactMemoryFlowState(stored.value, sourceRequest, { ownerId: row.ownerId, conversationId: row.conversationId, runId: row.id,
    evaluatedAt: row.evaluatedAt, originalRequestHash: row.originalRequestHash }, now);
  if (!flow || flow.phase === 'prepared') return null;
  const anchor = anchorFor({ ownerId: row.ownerId, conversationId: row.conversationId, sourceRunId: row.id, sourceCreatedAt: row.createdAt, sourceEvaluatedAt: row.evaluatedAt,
    sourceOriginalRequestHash: row.originalRequestHash, sourceRequestHash: flow.receipt.requestHash, receiptHash: taskEvidenceHash(JSON.stringify(flow.receipt)),
    operationKey: flow.receipt.operationKey, attemptedAt: flow.attemptedAt }, current);
  return anchor ? { sourceRequest, flow, anchor } : null;
}

/** Newest owner+conversation LIMIT2 only, before insertion. Ties, unrelated work and cross-purpose pointers never trigger a backwards search. */
export function selectUserFactMemoryVerificationAnchor(raw: unknown, currentValue: UserFactMemoryVerificationBinding,
  recent: readonly UserFactMemoryVerificationRun[], now: number): UserFactMemoryVerificationSelection {
  try {
    const intent = recognizeUserFactMemoryVerificationRequest(raw), parsed = BindingSchema.safeParse(currentValue);
    if (!intent) return blocked(raw, 'not_verification');
    if (!intent.allowed) return blocked(raw, intent.reason === 'memory_read_forbidden' ? 'memory_read_forbidden' : 'ambiguous_constraints');
    if (!parsed.success || !instant.safeParse(now).success || now < parsed.data.evaluatedAt || !Array.isArray(recent) || recent.length > 2) return blocked(raw, 'invalid_input');
    const current = parsed.data;
    if (!recent.length) return blocked(raw, 'no_prior_run');
    // The second row establishes recency/tie ambiguity only. Its old request
    // provenance must not veto a valid newest source (including legacy rows).
    if (recent.some(row => !rowRecency(row, current)) || recent.length === 2 && recent[0]!.createdAt < recent[1]!.createdAt) return blocked(raw, 'invalid_input');
    const latest = recent[0]!;
    if (recent.length === 2 && (latest.createdAt === recent[1]!.createdAt || latest.id === recent[1]!.id)) return blocked(raw, 'ambiguous_latest');
    if (!terminal.has(latest.status)) return blocked(raw, 'active_prior_run');
    const latestRequest = rowRequest(latest, current);
    if (!latestRequest) return blocked(raw, 'invalid_prior_state');
    const pointer = own(latest.state, 'userFactMemoryVerification');
    if (pointer.invalid) return blocked(raw, 'invalid_prior_state');
    if (pointer.present) {
      if (['userFactMemory', 'computationMemory', 'memoryVerification'].some(key => own(latest.state, key).present || own(latest.state, key).invalid)) return blocked(raw, 'invalid_prior_state');
      const prior = restoreUserFactMemoryVerificationState(pointer.value, latestRequest, { ownerId: latest.ownerId, conversationId: latest.conversationId,
        runId: latest.id, createdAt: latest.createdAt, evaluatedAt: latest.evaluatedAt });
      const anchor = prior && (!prior.lastCheck || prior.lastCheck.checkedAt <= current.createdAt) && anchorFor(prior.source, current);
      return anchor ? { status: 'selected', anchor } : blocked(raw, 'invalid_prior_state');
    }
    const source = originalSource(latest, current, now);
    return source ? { status: 'selected', anchor: source.anchor } : blocked(raw, own(latest.state, 'userFactMemory').present ? 'invalid_prior_state' : 'unrelated_prior_run');
  } catch { return blocked(raw, 'invalid_input'); }
}

export function createUserFactMemoryVerificationState(raw: unknown, currentValue: UserFactMemoryVerificationBinding, anchorValue: UserFactMemoryVerificationAnchor,
  lastCheck?: z.infer<typeof CheckSchema>): UserFactMemoryVerificationState | null {
  try {
    const intent = recognizeUserFactMemoryVerificationRequest(raw), current = BindingSchema.safeParse(currentValue);
    if (!intent?.allowed || !current.success) return null;
    const source = anchorFor(anchorValue, current.data);
    if (!source || lastCheck && (!CheckSchema.safeParse(lastCheck).success || lastCheck.checkedAt < current.data.evaluatedAt)) return null;
    return UserFactMemoryVerificationStateSchema.parse({ version: 1, kind: 'user_fact_memory_verification', ownerId: current.data.ownerId,
      conversationId: current.data.conversationId, verificationRunId: current.data.runId, verificationCreatedAt: current.data.createdAt,
      verificationEvaluatedAt: current.data.evaluatedAt, verificationRequestHash: intent.requestHash, source, ...(lastCheck ? { lastCheck } : {}) });
  } catch { return null; }
}
export function restoreUserFactMemoryVerificationState(value: unknown, raw: unknown, current: UserFactMemoryVerificationBinding): UserFactMemoryVerificationState | null {
  try {
    const parsed = UserFactMemoryVerificationStateSchema.safeParse(value);
    if (!parsed.success) return null;
    const expected = createUserFactMemoryVerificationState(raw, current, parsed.data.source, parsed.data.lastCheck);
    return expected && JSON.stringify(expected) === JSON.stringify(parsed.data) ? expected : null;
  } catch { return null; }
}
/** Must reload this exact original DB row and re-resolve its effective time/raw metadata on EVERY verification, including repetitions. */
export function restoreUserFactMemoryVerificationSource(raw: unknown, currentValue: UserFactMemoryVerificationBinding, anchorValue: UserFactMemoryVerificationAnchor,
  original: UserFactMemoryVerificationRun, now: number): UserFactMemoryVerificationSource | null {
  try {
    const current = BindingSchema.safeParse(currentValue);
    if (!current.success || !text(raw) || !recognizeUserFactMemoryVerificationRequest(raw)?.allowed || !instant.safeParse(now).success || now < current.data.evaluatedAt) return null;
    const anchor = anchorFor(anchorValue, current.data);
    if (!anchor || original.id !== anchor.sourceRunId || original.createdAt !== anchor.sourceCreatedAt || original.evaluatedAt !== anchor.sourceEvaluatedAt) return null;
    const source = originalSource(original, current.data, now);
    return source && JSON.stringify(source.anchor) === JSON.stringify(anchor) ? { request: raw, current: current.data, anchor, sourceRequest: source.sourceRequest, flow: source.flow } : null;
  } catch { return null; }
}

const target = (anchor: UserFactMemoryVerificationAnchor) => `memory-note-status:${anchor.sourceRunId}:${anchor.operationKey}`;
export function createUserFactMemoryVerificationSupervisor(raw: unknown, current: UserFactMemoryVerificationBinding, anchor: UserFactMemoryVerificationAnchor): TaskSupervisorState | null {
  if (!text(raw) || !createUserFactMemoryVerificationState(raw, current, anchor)) return null;
  return createTaskSupervisor({ id: current.runId, objective: raw, kind: 'task', mode: 'advisory', now: current.evaluatedAt,
    criteria: [{ id: 'user-note-status-answer', kind: 'answer_evidence', target: target(anchor), required: true,
      description: 'Fresh manual/user-asserted note readback supports this status answer only; no new write, old goal completion or factual truth.' }] });
}

/** Direct reconcileExact result ONLY. No write port, old-run checkpoint, quota reservation or payload echo exists here. Current lease/account fences belong to the host. */
export function assessUserFactMemoryVerificationReadback(source: UserFactMemoryVerificationSource, value: unknown,
  bracket: { startedAt: number; finishedAt: number }): UserFactMemoryVerificationAssessment {
  const ar = record(source) && typeof source.request === 'string' && /\p{Script=Arabic}/u.test(source.request);
  const unknown = ar ? 'لم أتمكن من التحقق من حالة الملاحظة المحفوظة الآن.' : 'I could not verify the current status of that saved note.';
  const failure = (reason: 'invalid_source' | 'invalid_clock' | 'invalid_readback'): UserFactMemoryVerificationAssessment => ({ scope: 'user_statement_memory_read_status_only',
    status: reason === 'invalid_source' ? 'blocked' : 'partial', persistence: 'unknown', reason, text: unknown,
    ...(reason === 'invalid_readback' ? { check: { outcome: 'unknown' as const, checkedAt: bracket.finishedAt } } : {}) });
  try {
    if (!record(bracket) || !instant.safeParse(bracket.startedAt).success || !instant.safeParse(bracket.finishedAt).success || bracket.finishedAt < bracket.startedAt) return failure('invalid_clock');
    if (!record(source) || !record(source.current) || !record(source.anchor) || !createUserFactMemoryVerificationState(source.request, source.current, source.anchor)) return failure('invalid_source');
    const { current, anchor } = source;
    if (bracket.startedAt < current.evaluatedAt) return failure('invalid_clock');
    const flow = restoreUserFactMemoryFlowState(source.flow, source.sourceRequest, { ownerId: anchor.ownerId, conversationId: anchor.conversationId,
      runId: anchor.sourceRunId, evaluatedAt: anchor.sourceEvaluatedAt, originalRequestHash: anchor.sourceOriginalRequestHash }, bracket.finishedAt);
    if (!flow || flow.phase === 'prepared' || flow.attemptedAt !== anchor.attemptedAt || flow.receipt.requestHash !== anchor.sourceRequestHash
      || flow.receipt.operationKey !== anchor.operationKey || taskEvidenceHash(JSON.stringify(flow.receipt)) !== anchor.receiptHash) return failure('invalid_source');
    const checked = validateUserFactMemoryReadback(value, flow.receipt, flow, bracket.startedAt, bracket.finishedAt);
    if (!checked) return failure('invalid_readback');
    const endExpired = checked.status === 'verified' && (Date.parse(checked.receipt.expiresAt) <= bracket.finishedAt
      || checked.item.provenance[0]!.expiresAt !== null && Date.parse(checked.item.provenance[0]!.expiresAt) <= bracket.finishedAt);
    if (checked.status !== 'verified' || endExpired) {
      const missing = checked.status === 'missing';
      return { scope: 'user_statement_memory_read_status_only', status: 'partial', persistence: missing ? 'missing' : 'unavailable', reason: missing ? 'missing' : 'unavailable',
        text: missing ? ar ? 'لم يظهر سجل ملتزم لمحاولة حفظ هذه الملاحظة وقت التحقق. لم أؤكد بقاءها محفوظة.' : 'No committed record was visible for this note-save attempt at the time of the check. I could not confirm that the note remains saved.'
          : ar ? 'لم أؤكد أن الملاحظة المرتبطة بعملية الحفظ متاحة كذاكرة نشطة الآن.' : 'I could not confirm that the note associated with this save operation is available as active now.',
        check: { outcome: missing ? 'missing' : 'unavailable', checkedAt: bracket.finishedAt } };
    }
    const answer = ar ? 'نعم، تحققت الآن من أن الملاحظة المحفوظة ما زالت نشطة في ذاكرتك.' : 'Yes. I verified that the saved note is currently active in your memory.';
    return { scope: 'user_statement_memory_read_status_only', status: 'completed', persistence: 'verified', reason: 'verified', text: answer,
      check: { outcome: 'active', checkedAt: bracket.finishedAt }, observation: { kind: 'answer_evidence', source: 'memory-read', criterionId: 'user-note-status-answer',
        target: target(anchor), reference: `memory-note-status:${anchor.operationKey}:${checked.item.id}:v${checked.item.version}`, observedAt: Date.parse(checked.observedAt),
        outcome: 'confirmed', independentlyVerified: true, answerHash: taskEvidenceHash(answer) } };
  } catch { return failure('invalid_source'); }
}
