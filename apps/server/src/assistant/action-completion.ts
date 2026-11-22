import { createHash } from 'node:crypto';
import { z } from 'zod';
import { asksToRemember } from './brain.js';
import { analyzeCompoundRequest } from './compound-request.js';
import { requestScopeActionText } from './request-scope.js';

/**
 * Host-only, bounded action-accounting boundary. It neither authorizes nor
 * dispatches a tool. Existing owner/conversation/account/lease fences still apply.
 */
export const MAX_ACTION_COMPLETION_EVENTS = 32;
export const MAX_ACTION_COMPLETION_REQUIREMENTS = 8;
export const actionCompletionKinds = ['memory_read', 'memory_write', 'computer_view', 'computer_click', 'computer_type', 'computer_key', 'delivery'] as const;
export type ActionCompletionKind = typeof actionCompletionKinds[number];
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const identity = z.string().min(1).max(160).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value));
const Kind = z.enum(actionCompletionKinds);
const Proof = z.enum(['adapter_ack', 'authoritative_readback']);
const Requirement = z.object({ id: identity, kind: Kind, binding: z.enum(['request', 'operand', 'unresolved']),
  targetHash: digest, minimumProof: Proof }).strict();
const Contract = z.object({ version: z.literal(1), scope: z.literal('original_outer_request_actions_only'), runId: identity,
  requestHash: digest, lang: z.enum(['ar', 'en']), coverage: z.enum(['bounded', 'incomplete_sequence']),
  requirements: z.array(Requirement).max(MAX_ACTION_COMPLETION_REQUIREMENTS), hash: digest }).strict();
export type ActionCompletionContract = z.infer<typeof Contract>;
const EventInput = z.discriminatedUnion('phase', [
  z.object({ attemptId: identity, kind: Kind, targetHash: digest, phase: z.literal('started'), proof: z.literal('none') }).strict(),
  z.object({ attemptId: identity, kind: Kind, targetHash: digest, phase: z.literal('acknowledged'), proof: Proof, receiptHash: digest.optional() }).strict(),
  z.object({ attemptId: identity, kind: Kind, targetHash: digest, phase: z.literal('denied'), proof: z.literal('none') }).strict(),
  z.object({ attemptId: identity, kind: Kind, targetHash: digest, phase: z.literal('unknown'), proof: z.literal('none') }).strict(),
]);
export type ActionCompletionEventInput = z.infer<typeof EventInput>;
const Record = z.object({ sequence: z.number().int().min(1).max(MAX_ACTION_COMPLETION_EVENTS), previousHash: digest,
  event: EventInput, hash: digest }).strict();
const Ledger = z.object({ version: z.literal(1), contract: Contract, events: z.array(Record).max(MAX_ACTION_COMPLETION_EVENTS),
  fault: z.enum(['capacity', 'invalid_event']).optional() }).strict();
export type ActionCompletionLedger = z.infer<typeof Ledger>;
export type ActionCompletionProof = 'none' | 'adapter_ack' | 'authoritative_readback';
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const objectHash = (value: unknown) => hash(JSON.stringify(value));
const wellFormed = (value: string) => !/[\ud800-\udfff]/u.test(value);
const mutation = (kind: ActionCompletionKind) => !['memory_read', 'computer_view'].includes(kind);
const fold = (text: string) => text.normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670]|\p{Cf}/gu, '')
  .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').toLowerCase().replace(/\s+/gu, ' ').trim();
const COURTESY = /^(?:(?:please|kindly|من فضلك|لو سمحت|رجاء)[,،:\s]+)+/iu;
const PC = /\b(?:pc|computer|notepad|desktop)\b|(?:الكمبيوتر|الحاسوب|كمبيوتري|حاسوبي|جهازي|المفكره|نافذه (?:البرنامج|الحاسوب|الكمبيوتر))/iu;
const MEMORY = /\b(?:memory|my saved|saved notes|saved records)\b|(?:ذاكرتي|الذاكره|المحفوظ|المسجل)/iu;
const TRANSFORM = /^(?:translate|rewrite|summari[sz]e|paraphrase|explain|describe|ترجم|اعد صياغه|لخص|اشرح|صف)(?!\p{L})/iu;
const NARRATIVE = /^(?:write|draft|compose|tell|اكتب|الف|احك)\s+[\s\S]{0,100}?(?:story|fiction|scene|dialogue|play|poem|قصه|حكايه|حوار|مشهد|مسرحيه|قصيده)\s+(?:where|in which|whose|about|عن|حيث|فيها)(?!\p{L})/iu;

/** Exact UTF-8 operands; do not normalize labels, typed content or key names. */
export function actionOperandHash(kind: ActionCompletionKind, value: string): string {
  if (!actionCompletionKinds.includes(kind) || typeof value !== 'string' || value.length > 4000 || !wellFormed(value)) throw new Error('ACTION_OPERAND_INVALID');
  return objectHash(['mohassan:action-operand:v1', kind, value]);
}
export function actionRequestHash(request: string): string {
  if (typeof request !== 'string' || !request.trim() || request.length > 4000 || !wellFormed(request)) throw new Error('ACTION_REQUEST_INVALID');
  return hash(request);
}

function pcOperand(action: string, kind: ActionCompletionKind): string | null {
  if (kind === 'computer_key') {
    const match = /^(?:press|hit|اضغط)\s+(?:the\s+)?(?:key\s+|مفتاح\s+)?(Enter|إدخال|ادخال|Tab|Escape|Space|Delete|Backspace|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|(?:Ctrl|Control|Alt|Shift)\+[A-Za-z0-9]+)(?=\s|[.!؟?]|$)/iu.exec(action);
    return match?.[1] && /^(?:Enter|إدخال|ادخال)$/iu.test(match[1]) ? 'Enter' : match?.[1] ?? null;
  }
  const prefix = kind === 'computer_type'
    ? /^(?:type\s+(?:(?:the\s+)?text\s+)?|(?:اكتب|اطبع)\s+(?:النص\s+)?)/iu.exec(action)
    : /^(?:(?:click|press)\s+(?:(?:the|a)\s+)?(?:button\s+)?|(?:اضغط|إضغط|انقر)\s+(?:على\s+)?(?:زر\s+)?)/iu.exec(action);
  if (!prefix) return null;
  const rest = action.slice(prefix[0].length);
  const destination = /\s+(?:into|in|on|within|في|داخل|على)\s+(?=(?:(?:the|my|this|current|active)\s+)*(?:pc\b|computer\b|notepad\b|desktop\b|window\b)|(?:نافذة|النافذة|نافذه|المفكرة|المفكره|الحاسوب|الكمبيوتر|كمبيوتري|حاسوبي|جهازي))/giu;
  const pairs: Readonly<Record<string, string>> = { '"': '"', "'": "'", '«': '»', '“': '”', '`': '`' };
  const close = pairs[rest[0]!];
  if (close) {
    const marker = rest.startsWith('```') ? '```' : close, opening = rest.startsWith('```') ? 3 : 1;
    let end = opening;
    for (; end < rest.length; end++) if (rest.slice(end, end + marker.length) === marker && rest[end - 1] !== '\\') break;
    if (end >= rest.length) return null;
    const suffix = rest.slice(end + marker.length).replace(kind === 'computer_click' ? /^\s+button(?=\s)/iu : /$^/u, '');
    // A destination is outside the literal. Never split at an 'in' in its body.
    if (destination.exec(suffix)?.index !== 0) return null;
    return end > opening ? rest.slice(opening, end) : null;
  }
  const delimiters = [...rest.matchAll(destination)];
  // Ambiguous unquoted destinations fail closed instead of binding a prefix.
  if (delimiters.length !== 1) return null;
  const value = rest.slice(0, delimiters[0]!.index).replace(kind === 'computer_click' ? /\s+button$/iu : /$^/u, '').trim();
  return value || null;
}

/**
 * Recognizes narrow CURRENT USER outer instructions, not a universal planner.
 * Requirements and hashes are completion conditions only, never permissions.
 * Memory writes bind to the authorized request, NOT semantic payload equality:
 * the legacy adapter can paraphrase/translate and append the original request.
 */
export function compileActionCompletionContract(input: { runId: string; request: string }): ActionCompletionContract | null {
  try {
    const runId = identity.parse(input.runId), requestHash = actionRequestHash(input.request);
    const action = requestScopeActionText(input.request).replace(COURTESY, '').trim();
    const analysis = analyzeCompoundRequest(action);
    if (analysis.kind === 'invalid') return null;
    const outer = fold(analysis.outerText), head = fold(action);
    const describesPC = PC.test(outer) && (
      /^describe\s+(?:(?:the\s+)?(?:current|active|visible)\b|my\b|what\s+(?:is\s+)?(?:currently\s+)?(?:visible|shown|displayed)\s+(?:on|in)\s+(?:my|the\s+(?:current|active))\b)/iu.test(outer)
      || /^صف\s+(?:لي\s+)?(?:نافذه|شاشه|ما\s+(?:يظهر|هو\s+ظاهر))(?!\p{L})/u.test(outer)
        && /(?:الحاليه?|النشطه|المفتوحه|جهازي|امامي|الظاهره)/u.test(outer));
    const requirements: ActionCompletionContract['requirements'] = [];
    const add = (kind: ActionCompletionKind, value?: string | null) => {
      const isPCOperand = ['computer_click', 'computer_type', 'computer_key'].includes(kind);
      requirements.push({ id: `${requirements.length + 1}:${kind}`, kind,
        binding: isPCOperand ? value ? 'operand' : 'unresolved' : 'request',
        targetHash: isPCOperand && value ? actionOperandHash(kind, value) : requestHash,
        minimumProof: kind === 'delivery' ? 'authoritative_readback' : 'adapter_ack' });
    };
    // Questions/capability explanations and transformations of supplied text do
    // not create imperative actions from their bodies.
    const explanatory = TRANSFORM.test(outer) && !describesPC || NARRATIVE.test(outer);
    if (!explanatory && asksToRemember(action)
      && !/\b(?:desktop|folder|directory|disk|file)\b|(?:سطح المكتب|مجلد|ملف)/iu.test(outer)) add('memory_write');
    else if (!explanatory && MEMORY.test(outer)
      && /^(?:what\b|where\b|which\b|search\b|find\b|read\b|recall\b|retrieve\b|ما\s|ماذا\s|وش\s|ايش\s|ابحث\s|اقرا\s|استرجع\s)/iu.test(outer)) add('memory_read');
    if (!explanatory && PC.test(outer)) {
      if (/^(?:type|اكتب|اطبع)(?!\p{L})/iu.test(head)) add('computer_type', pcOperand(action, 'computer_type'));
      else if (/^(?:press|hit|اضغط)\s+(?:the\s+)?(?:key\s+|مفتاح\s+)?(?:Enter|إدخال|ادخال|Tab|Escape|Space|Delete|Backspace|Arrow|Ctrl|Control|Alt|Shift)/iu.test(action)) add('computer_key', pcOperand(action, 'computer_key'));
      else if (/^(?:click|press|اضغط|انقر)(?!\p{L})/iu.test(head)) add('computer_click', pcOperand(action, 'computer_click'));
      else if (describesPC || /^(?:read|view|inspect|look at|show|اقرا|اعرض|شاهد|افحص|انظر)(?!\p{L})/iu.test(head)) add('computer_view');
    }
    const deliveryHead = /^(?:send|email|mail|deliver|publish|post|ارسل|ابعث|ابعت|انشر)(?:ها|ه|هم)?(?!\p{L})/iu.test(outer);
    if (!explanatory && deliveryHead) add('delivery');
    if (!NARRATIVE.test(outer)) for (const pending of analysis.pendingActions) {
      if (pending.kind === 'send' || pending.kind === 'publish') add('delivery');
    }
    if (requirements.length > MAX_ACTION_COMPLETION_REQUIREMENTS) return null;
    const remainder = fold(action.slice(analysis.primary.end)).replace(/^[\s,.;،؛]+/u, '')
      .replace(/^(?:and then|then|and|also|but|ثم|وبعدها|وبعدين|كذلك|لكن)\s+/iu, '');
    // An explanation/formatting tail is not another effect. An outer additional
    // action outside this small taxonomy cannot disappear behind the first ack.
    const uncovered = requirements.length > 0 && (analysis.pendingActions.some(item => !['send', 'publish'].includes(item.kind))
      || analysis.kind === 'unsupported_tail' && /^(?:print|delete|remove|erase|type|click|press|save|store|send|open|run|execute|schedule|اطبع|احذف|امسح|اكتب|اضغط|انقر|احفظ|ارسل|افتح|شغل|نفذ|جدول)(?!\p{L})/iu.test(remainder));
    const body = { version: 1 as const, scope: 'original_outer_request_actions_only' as const, runId, requestHash,
      lang: /\p{Script=Arabic}/u.test(input.request) ? 'ar' as const : 'en' as const,
      coverage: uncovered ? 'incomplete_sequence' as const : 'bounded' as const, requirements };
    return Contract.parse({ ...body, hash: objectHash(body) });
  } catch { return null; }
}

function validContract(value: unknown): ActionCompletionContract | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Array.isArray((value as ActionCompletionContract).requirements)
    || (value as ActionCompletionContract).requirements.length > MAX_ACTION_COMPLETION_REQUIREMENTS) return null;
  const parsed = Contract.safeParse(value);
  if (!parsed.success) return null;
  const { hash: supplied, ...body } = parsed.data;
  return objectHash(body) === supplied && new Set(body.requirements.map(item => item.id)).size === body.requirements.length ? parsed.data : null;
}
export function createActionCompletionLedger(contract: ActionCompletionContract): ActionCompletionLedger {
  const checked = validContract(contract);
  if (!checked) throw new Error('ACTION_CONTRACT_INVALID');
  return { version: 1, contract: checked, events: [] };
}

function pendingMutation(events: ActionCompletionLedger['events']): boolean {
  const latest = new Map<string, ActionCompletionEventInput>();
  for (const record of events) latest.set(record.event.attemptId, record.event);
  return [...latest.values()].some(event => mutation(event.kind) && (event.phase === 'started' || event.phase === 'unknown'));
}
function transition(events: ActionCompletionLedger['events'], event: ActionCompletionEventInput): boolean {
  const previous = events.findLast(record => record.event.attemptId === event.attemptId)?.event;
  if (!previous) return (event.phase === 'started' && (!mutation(event.kind) || !pendingMutation(events))) || event.phase === 'denied';
  if (previous.phase !== 'started' || previous.kind !== event.kind || previous.targetHash !== event.targetHash || event.phase === 'started') return false;
  return event.phase !== 'acknowledged' || (event.kind !== 'delivery' || event.proof === 'authoritative_readback')
    && (event.proof !== 'authoritative_readback' || Boolean(event.receiptHash));
}
function validLedger(value: unknown): ActionCompletionLedger | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Array.isArray((value as ActionCompletionLedger).events)
    || (value as ActionCompletionLedger).events.length > MAX_ACTION_COMPLETION_EVENTS
    || !validContract((value as ActionCompletionLedger).contract)) return null;
  const parsed = Ledger.safeParse(value);
  if (!parsed.success || !validContract(parsed.data.contract)) return null;
  const state = parsed.data, prior: ActionCompletionLedger['events'] = [];
  for (const record of state.events) {
    const { hash: supplied, ...body } = record;
    if (record.sequence !== prior.length + 1 || record.previousHash !== (prior.at(-1)?.hash ?? state.contract.hash)
      || objectHash(body) !== supplied || !transition(prior, record.event)) return null;
    prior.push(record);
  }
  return state;
}

/** DB/host state only. Parse bounded fields before hashing; never parse model prose. */
export function restoreActionCompletionLedger(value: unknown, input: { runId: string; request: string }): ActionCompletionLedger | null {
  try {
    const expected = compileActionCompletionContract(input), state = validLedger(value);
    return expected && state && expected.hash === state.contract.hash ? state : null;
  } catch { return null; }
}

/**
 * Call immediately at a real host boundary. Check accepted before dispatch.
 * Persist the returned started ledger before mutation; restore never retries.
 * A denied proposal has no dispatch. Unknown is sticky, even for another payload.
 * Acknowledged means the adapter returned successfully; only a separately
 * validated authoritative receipt may use authoritative_readback.
 */
export function recordActionCompletionEvent(value: ActionCompletionLedger, input: ActionCompletionEventInput): {
  accepted: boolean; reason: 'recorded' | 'invalid_ledger' | 'invalid_event' | 'capacity'; ledger: ActionCompletionLedger | null;
} {
  const state = validLedger(value);
  if (!state) return { accepted: false, reason: 'invalid_ledger', ledger: null };
  if (state.fault) return { accepted: false, reason: state.fault, ledger: state };
  if (state.events.length >= MAX_ACTION_COMPLETION_EVENTS) return { accepted: false, reason: 'capacity', ledger: { ...state, fault: 'capacity' } };
  const parsed = EventInput.safeParse(input);
  if (!parsed.success || !transition(state.events, parsed.data)) return { accepted: false, reason: 'invalid_event', ledger: { ...state, fault: 'invalid_event' } };
  const body = { sequence: state.events.length + 1, previousHash: state.events.at(-1)?.hash ?? state.contract.hash, event: parsed.data };
  return { accepted: true, reason: 'recorded', ledger: { ...state, events: [...state.events, { ...body, hash: objectHash(body) }] } };
}

export interface ActionCompletionReview {
  /** Side-effect permission for done only; never promotes a model partial/blocked result. */
  allowDone: boolean;
  proofLevel: ActionCompletionProof;
  pendingKinds: ActionCompletionKind[];
  reason: 'unscoped' | 'acknowledged' | 'verified_read_only_answer' | 'invalid_state' | 'ledger_fault' | 'effect_unknown'
    | 'effect_pending' | 'denied_mutation' | 'unexpected_mutation' | 'action_not_performed' | 'operand_unresolved' | 'incomplete_sequence';
  replacement?: { status: 'partial' | 'blocked'; text: string };
}

/**
 * No final-prose regex. Missing actions/denials use fixed truthful replacement
 * text; quoted drafts/translations have no action contract. A host may narrowly
 * preserve an independently verified exact memory answer, bound to this final
 * answer hash, despite an unrelated earlier DENIED (not unknown) proposal.
 */
export function reviewActionCompletion(value: unknown, input: { runId: string; request: string; outcome: 'done' | 'partial' | 'blocked'; answerHash?: string;
  verifiedReadOnlyAnswer?: { source: 'exact_memory_recall'; runId: string; requestHash: string; answerHash: string };
}): ActionCompletionReview {
  const state = restoreActionCompletionLedger(value, input);
  const ar = state?.contract.lang === 'ar' || !state && typeof input.request === 'string' && /\p{Script=Arabic}/u.test(input.request);
  const fail = (reason: ActionCompletionReview['reason'], pendingKinds: ActionCompletionKind[] = []): ActionCompletionReview => {
    const text = ar ? {
      invalid_state: 'لم أتحقق من سجل إجراءات صالح لهذا الطلب؛ لا أستطيع تأكيد التنفيذ.',
      ledger_fault: 'لم أتحقق من اكتمال سجل الإجراءات؛ لا أستطيع تأكيد التنفيذ.',
      effect_unknown: 'نتيجة إجراء سابق غير محسومة؛ يلزم التحقق منها قبل أي إجراء جديد.',
      effect_pending: 'إجراء سابق لم تتأكد نتيجته بعد؛ لا أستطيع تأكيد اكتماله.',
      denied_mutation: 'رُفض اقتراح لتغيير البيانات أو تنفيذ إدخال؛ لم أنفّذ ذلك الاقتراح. لا أستطيع تأكيد اكتمال الطلب.',
      unexpected_mutation: 'استجابت أداة لإجراء لم أطابقه مع إجراء مطلوب في هذا الطلب؛ راجع النتيجة قبل المتابعة.',
      action_not_performed: pendingKinds.includes('delivery') ? 'لم أتحقق من إرسال أو نشر أي رسالة لهذا الطلب؛ الإرسال ما زال معلقًا.' : 'لم أتحقق من تنفيذ الأداة للإجراء المطلوب لهذا الطلب؛ التنفيذ ما زال معلقًا.',
      operand_unresolved: 'لم أحدد هدف الإدخال المطلوب بدقة؛ لم أتحقق من تنفيذ الطلب.',
      incomplete_sequence: 'لم أتحقق من جميع الأفعال في هذا الطلب المركب؛ العمل ما زال جزئيًا.',
    } : {
      invalid_state: 'I could not validate an action ledger for this request, so I cannot confirm execution.',
      ledger_fault: 'I could not validate the complete action history, so I cannot confirm execution.',
      effect_unknown: 'A previous action has an unknown result. Verify its outcome before any new action.',
      effect_pending: 'A previous action has no confirmed outcome yet, so I cannot confirm completion.',
      denied_mutation: 'A proposed change or input was denied; that proposal was not performed. I cannot confirm completion of the request.',
      unexpected_mutation: 'A tool acknowledged an action that I did not match to a requested action. Review the result before continuing.',
      action_not_performed: pendingKinds.includes('delivery') ? 'I have not verified any message delivery or publication for this request; sending remains pending.' : 'I have not verified that the tool performed the requested action for this request; execution remains pending.',
      operand_unresolved: 'I did not identify the requested input target precisely, so I could not verify execution.',
      incomplete_sequence: 'I could not verify every action in this compound request; the work remains partial.',
    };
    return { allowDone: false, proofLevel: 'none', pendingKinds: [...new Set(pendingKinds)], reason,
      replacement: { status: input.outcome === 'blocked' || reason === 'invalid_state' || reason === 'ledger_fault' ? 'blocked' : 'partial', text: text[reason as keyof typeof text] } };
  };
  if (!state) return fail('invalid_state');
  const latest = new Map<string, ActionCompletionEventInput>();
  for (const record of state.events) latest.set(record.event.attemptId, record.event);
  const events = [...latest.values()], requirements = state.contract.requirements;
  const uncertain = events.filter(event => mutation(event.kind) && (event.phase === 'unknown' || event.phase === 'started'));
  if (uncertain.length) return fail(uncertain.some(event => event.phase === 'unknown') ? 'effect_unknown' : 'effect_pending', uncertain.map(event => event.kind));
  if (state.fault) return fail('ledger_fault');
  const acknowledged = events.filter(event => event.phase === 'acknowledged');
  if (acknowledged.some(event => mutation(event.kind) && !requirements.some(item => item.kind === event.kind && item.targetHash === event.targetHash && item.binding !== 'unresolved')))
    return fail('unexpected_mutation');
  const exact = input.verifiedReadOnlyAnswer;
  const verifiedRead = exact?.source === 'exact_memory_recall' && exact.runId === state.contract.runId && exact.requestHash === state.contract.requestHash
    && digest.safeParse(input.answerHash).success && exact.answerHash === input.answerHash
    && requirements.every(item => item.kind === 'memory_read');
  if (verifiedRead) return { allowDone: true, proofLevel: 'authoritative_readback', pendingKinds: [], reason: 'verified_read_only_answer' };
  const denied = state.events.filter(record => mutation(record.event.kind) && record.event.phase === 'denied');
  // A rejected proposal remains in history. Only a later real, matching,
  // host-authorized acknowledgment can satisfy that requested action instead.
  // A read-only request cannot acquire mutation authority through correction.
  const correctedDenials = denied.every(rejected => requirements.some(requirement => mutation(requirement.kind)
    && requirement.kind === rejected.event.kind && requirement.binding !== 'unresolved'
    && state.events.some(record => record.sequence > rejected.sequence && record.event.phase === 'acknowledged'
      && record.event.kind === requirement.kind && record.event.targetHash === requirement.targetHash
      && (requirement.minimumProof === 'adapter_ack' || record.event.proof === 'authoritative_readback'))));
  if (!correctedDenials) return fail('denied_mutation');
  if (state.contract.coverage === 'incomplete_sequence') return fail('incomplete_sequence', requirements.map(item => item.kind));
  if (!requirements.length) return { allowDone: true, proofLevel: 'none', pendingKinds: [], reason: 'unscoped' };
  const remaining = [...acknowledged];
  const missing: typeof requirements = [];
  let proofLevel: ActionCompletionProof = 'authoritative_readback';
  for (const requirement of requirements) {
    const at = requirement.binding === 'unresolved' ? -1 : remaining.findIndex(event => event.kind === requirement.kind && event.targetHash === requirement.targetHash
      && event.phase === 'acknowledged' && (requirement.minimumProof === 'adapter_ack' || event.proof === 'authoritative_readback'));
    if (at < 0) missing.push(requirement);
    else if (remaining.splice(at, 1)[0]!.proof === 'adapter_ack') proofLevel = 'adapter_ack';
  }
  if (missing.length) return fail(missing.some(item => item.binding === 'unresolved') ? 'operand_unresolved' : 'action_not_performed', missing.map(item => item.kind));
  return { allowDone: true, proofLevel, pendingKinds: [], reason: 'acknowledged' };
}
