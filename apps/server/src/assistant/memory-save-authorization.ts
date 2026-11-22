import { deniesMemoryWrite } from './brain.js';
import { analyzeCompoundRequest, MAX_COMPOUND_REQUEST, type RequestSpan } from './compound-request.js';

export interface CompoundMemorySaveWording {
  version: 1;
  scope: 'wording_intent_only';
  allowed: boolean;
  reason: 'explicit_memory_result' | 'invalid_input' | 'invalid_sequence' | 'not_compound'
    | 'denied' | 'question_or_condition' | 'source_text' | 'unsupported_primary'
    | 'ambiguous_actions' | 'not_explicit_memory_result';
  /** Original UTF-16 spans, supplied only for the narrowly recognized wording. */
  primary?: RequestSpan;
  clause?: RequestSpan;
}

const fold = (value: string) => value.normalize('NFKC')
  .replace(/[\u0640\u064b-\u065f\u0670]|\p{Cf}/gu, '').replace(/[أإآٱ]/gu, 'ا')
  .replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').replace(/’/gu, "'").replace(/\s+/gu, ' ').trim().toLowerCase();
const COURTESY = /^(?:(?:please|kindly|من فضلك|لو سمحت|رجاء)[,،:\s]+)+/iu;
const cleanClause = (value: string) => fold(value).replace(COURTESY, '').replace(/[\s.!;,؛،]+$/gu, '');
const COMPUTE_PRIMARY = /^(?:calculate|compute|convert|multiply|divide|add|subtract|احسب|حول|اضرب|اقسم|اجمع|اطرح)(?!\p{L})/iu;
const QUESTION_OR_CONDITION = /[?؟]|\b(?:can|could|would|should|may|might|if|unless|whether|maybe|perhaps|suppose|imagine|example|hypothetically)\b|(?:^|\s)(?:هل|اذا|لو|لولا|ربما|يمكن|افترض|تخيل|مثال)(?!\p{L})/iu;
// This first version accepts an explicit arithmetic/unit/date primary only.
// Source/data/report vocabulary outside literals is deliberately not promoted
// into authority, even when the general compound parser finds a save-shaped tail.
const SOURCE_MATERIAL = /\b(?:page|webpage|website|file|document|source|text|content|message|email|note|data|input|output|instruction|prompt|assistant|model|system|developer|code|html|json|xml|csv|markdown|log|transcript|says|said|reads|contains|quoted|quote|reported)\b|(?:^|\s)(?:الصفحه|صفحه|الموقع|موقع|الملف|ملف|المستند|مستند|الوثيقه|وثيقه|المصدر|مصدر|النص|نص|المحتوي|محتوي|الرساله|رساله|البيانات|بيانات|المدخلات|المخرجات|التعليمات|تعليمات|الكود|كود|الشفره|شفره|يقول|تقول|يطلب|تطلب|قال|قالت|مقتبس|النموذج|المساعد|النظام|المطور)(?!\p{L})/iu;
const STRUCTURED_SOURCE = /[<>\[\]{}]|\/\*|\*\/|(?:^|\s)\/\/|(?:^|\s)#/u;
const FILE_OR_EXTERNAL_TARGET = /\b(?:desktop|folder|directory|download|drive|disk|file|document|screenshot|image|photo|browser|cache|notes|notebook|calendar|reminder)\b|(?:^|\s)(?:سطح المكتب|مجلد|المجلد|ملف|الملف|مستند|المستند|لقطه|صوره|المتصفح|متصفح|الكاش|الملاحظات|ملاحظاتي|تقويم|تذكير)(?!\p{L})|(?:[a-z]:[\\/]|\\\\|\/(?:tmp|home|users|downloads)\/)/iu;

const RESULT_EN = '(?:(?:the|this|that|my)\\s+)?(?:result|answer|value)';
const MEMORY_EN = '(?:in|into|to)\\s+(?:(?:my|your|the)\\s+)?memory';
const REMEMBER_EN = new RegExp(`^remember\\s+${RESULT_EN}(?:\\s+${MEMORY_EN})?$`, 'iu');
const SAVE_EN = new RegExp(`^(?:save|store|record)\\s+${RESULT_EN}\\s+${MEMORY_EN}$`, 'iu');
const RESULT_AR = '(?:(?:هذه|هذا|تلك|ذلك)\\s+)?(?:ال)?(?:نتيجه|ناتج|قيمه|اجابه|جواب)';
const MEMORY_AR = '(?:في|الي)\\s+(?:ذاكرتي|ذاكرتك|الذاكره)';
const REMEMBER_AR = new RegExp(`^تذكر\\s+${RESULT_AR}(?:\\s+${MEMORY_AR})?$`, 'u');
const SAVE_AR = new RegExp(`^(?:احفظ|خزن|سجل)\\s+${RESULT_AR}\\s+${MEMORY_AR}$`, 'u');

/**
 * Recognize wording in the ORIGINAL CURRENT USER request only. Never call this
 * on model output, page/file content, a resolved/inherited request, or caller-
 * supplied compound analysis. It does not authorize a memory tool or its payload.
 *
 * The host must separately bind the primary to a successful, independently
 * verified computation from THIS SAME request, and save exactly that verified
 * result. Missing primary evidence, model notes/assertions, or a different value
 * must never be accepted because allowed is true. Existing owner/account, tool
 * availability, redaction, quota and idempotency checks remain mandatory.
 *
 * Existing leading asksToRemember policy is not extended here. This conservative
 * addition recognizes one explicit result/answer/value tail after an imperative
 * computation, with no quoted operands, sources, questions or conditional work.
 */
export function assessCompoundMemorySaveAuthorization(currentUserRequest: unknown): CompoundMemorySaveWording {
  const result = (reason: CompoundMemorySaveWording['reason']): CompoundMemorySaveWording => ({
    version: 1, scope: 'wording_intent_only', allowed: false, reason,
  });
  if (typeof currentUserRequest !== 'string' || !currentUserRequest.trim() || currentUserRequest.length > MAX_COMPOUND_REQUEST) return result('invalid_input');
  // Share the existing policy exactly. In particular, later denials win over
  // earlier affirmative wording, even when an ordinary clause parser skips them.
  if (deniesMemoryWrite(currentUserRequest)) return result('denied');
  const analysis = analyzeCompoundRequest(currentUserRequest);
  if (analysis.kind === 'invalid' || analysis.kind === 'unsupported_tail') return result('invalid_sequence');
  if (analysis.kind !== 'compound') return result('not_compound');
  if (analysis.forbiddenActions.some(action => action.kind === 'save' || action.kind === 'change')) return result('denied');
  const outer = fold(analysis.outerText).replace(/لو سمحت/gu, '');
  if (QUESTION_OR_CONDITION.test(outer)) return result('question_or_condition');
  if (SOURCE_MATERIAL.test(outer)) return result('source_text');
  const primary = cleanClause(analysis.outerText.slice(analysis.primary.start, analysis.primary.end));
  if (STRUCTURED_SOURCE.test(primary)) return result('source_text');
  if (!COMPUTE_PRIMARY.test(primary)) return result('unsupported_primary');
  if (analysis.pendingActions.length !== 1 || analysis.pendingActions[0].kind !== 'save') return result('ambiguous_actions');
  const clause = analysis.pendingActions[0];
  // Literal ranges include URLs/code/quotes and source bodies. They can supply
  // neither this directive nor its destination; do not normalize them into one.
  if (analysis.literalRanges.some(range => range.start < analysis.primary.end && range.end > analysis.primary.start
    || range.start < clause.end && range.end > clause.start)) return result('source_text');
  const directive = cleanClause(analysis.outerText.slice(clause.start, clause.end));
  if (FILE_OR_EXTERNAL_TARGET.test(directive)
    || ![REMEMBER_EN, SAVE_EN, REMEMBER_AR, SAVE_AR].some(pattern => pattern.test(directive))) return result('not_explicit_memory_result');
  return { version: 1, scope: 'wording_intent_only', allowed: true, reason: 'explicit_memory_result',
    primary: { ...analysis.primary }, clause: { text: clause.text, start: clause.start, end: clause.end } };
}
