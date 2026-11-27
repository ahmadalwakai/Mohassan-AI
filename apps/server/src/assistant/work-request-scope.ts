import type { RequestResolution } from './request-context.js';
import { analyzeCompoundRequest } from './compound-request.js';
import { projectInventoryFormat } from './inventory.js';
import { isCurrentComputerReadRequest } from './computer-request-language.js';
import { assessRequestScope, maskRequestLiteralData, parseRequestScopeAssessment, requestOperationText,
  requestScopeActionText, type RequestScopeAssessment } from './request-scope.js';

export type WorkRequestCapability = 'workspace_read' | 'code_prepare' | 'studio_prepare' | 'skill_prepare';
export type WorkRequestUnderstanding = Pick<RequestResolution, 'original' | 'intent' | 'scope' | 'sourceAssessment'>;
export type WorkRequestScope = 'unscoped' | 'private_memory_lookup' | 'private_memory_transform' | 'local_content_lookup' | 'local_content_transform'
  | 'supplied_transform' | 'supplied_content' | 'explicit_work_goal';
export type WorkRequestScopeReason = 'invalid_request' | 'invalid_capability' | 'outside_scoped_sources'
  | 'private_memory_lookup' | 'private_memory_transform' | 'local_content_lookup' | 'local_content_transform'
  | 'supplied_transform' | 'supplied_content' | 'explicit_outer_work_goal';
export interface WorkRequestScopeReview {
  readonly version: 1;
  readonly allowed: boolean;
  readonly scope: WorkRequestScope;
  readonly reason: WorkRequestScopeReason;
}

const CAPABILITIES = ['workspace_read', 'code_prepare', 'studio_prepare', 'skill_prepare'] as const;
const COURTESY = /^(?:(?:please|kindly|can you|could you|would you|i want you to|من فضلك|لو سمحت|رجاء|هل يمكنك|هل تستطيع|يمكنك|اريد منك ان)[,،:\s]+)+/u;
const TRANSFORM = /^(?:rewrite|translate|summari[sz]e|paraphrase|proofread|shorten|reword|edit|polish|describe|اعد صياغه|ترجم|لخص|اختصر|صحح|صف)(?!\p{L})/u;
const NARRATIVE = /^(?:write|draft|compose|tell|rewrite|اكتب|الف|احك|اعد صياغه)\s+[\s\S]{0,140}?(?:story|fiction|scene|dialogue|play|poem|قصه|حكايه|حوار|مشهد|مسرحيه|قصيده)\s+(?:where|in which|whose|about|عن|حيث|فيها)(?!\p{L})/u;
// A descriptor/report relation is data, not a new owner instruction. Closed
// primary grammar below also prevents nominal reports granting via a later verb.
const REPORTED = /\b(?:says|reads|contains|states|includes|containing|whose|which)\b|\b(?:the|this|my|our)\s+(?:note|text|page|message)\s+(?:says|reads)|(?:^|\s)(?:الذي|التي|تقول|يقول|قال|قالت|يحتوي|تحتوي|تتحدث|مكتوب)(?=\s|[\p{P}]|$)/u;
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const INVENTORY = /^(?:(?:list|show|display|provide|give me|what are)\s+(?:(?:the|my|our|registered|current)\s+){0,3}(?:(?:coding|software|programming|code)\s+)?(?:projects|workspaces|studio sessions)(?:\s+(?:names|ids|identifiers))?(?:\s+only)?|(?:اعرض|استعرض|اسرد|اذكر|اعطني|ارني)\s+(?:مشاريعي|مشاريعنا|المشاريع|المشروعات|مساحات العمل|جلسات الاستوديو)(?:\s+(?:البرمجيه|المسجله|الحاليه))?(?:\s+(?:الاسماء|فقط))?)[.!?؟,،]*$/u;
const CODE = new RegExp(`^(?:(?:prepare|draft|propose|create)\\s+(?:(?:a|the)\\s+)?(?:code|coding)\\s+(?:change|patch|update|proposal)\\s+(?:in|for)\\s+(?:project|workspace)\\s+${UUID}\\s+(?:to|for)\\s+[^;.!?؟]{5,500}|(?:جهز|حضر|اقترح|اعد)\\s+(?:تعديل|تغييرا?|مقترح تعديل)\\s+(?:برمجيا?|للكود)\\s+(?:في|لـ?)\\s+(?:المشروع|مشروع)\\s+${UUID}\\s+[^;.!?؟]{5,500})[.!?؟]*$`, 'u');
const STUDIO = new RegExp(`^(?:prepare|draft|propose|create)\\s+(?:(?:a|the)\\s+)?studio\\s+(?:change|update|proposal)\\s+(?:in|for)\\s+(?:session|project)\\s+${UUID}\\s+(?:to|for)\\s+[^;.!?؟]{5,500}[.!?؟]*$`, 'u');
const SKILL = new RegExp(`^(?:(?:prepare|create)\\s+(?:(?:a|the)\\s+)?skill\\s+(?:run|task|workflow)\\s+(?:for\\s+)?${UUID}|(?:run|execute|launch)\\s+(?:skill|workflow)\\s+${UUID}|(?:جهز|حضر|اعد)\\s+(?:مهمه|تشغيل)\\s+(?:للمهاره|المهاره)\\s+${UUID}|(?:شغل|نفذ)\\s+(?:المهاره|مهاره)\\s+${UUID})[.!?؟]*$`, 'u');
const PRIVATE_PRIMARY = /^(?:(?:read|recall|retrieve|search|look up|rewrite|summari[sz]e|translate|paraphrase|proofread|shorten|edit)\s+(?:my|our|the)\s+(?:(?:saved|stored|private|personal|recorded|previous)\s+)?(?:[\p{L}\p{N}_-]+\s+){0,4}(?:notes?|records?|memory|memories|preferences?|reference|message|text|document)(?:\s+(?:concisely|briefly))?|(?:اقرا|استرجع|لخص|ترجم|اختصر|صحح|اعد صياغه)\s+(?:ملاحظاتي|ملاحظاتنا|سجلاتي|ذاكرتي|رسائلي|النص المحفوظ)(?:\s+(?:المحفوظه|المخزنه|الخاصه|القديمه))?(?:\s+(?:باختصار|بوضوح))?)[.!?؟,،]*$/u;
const SUPPLIED_PRIMARY = /^(?:rewrite|translate|summari[sz]e|paraphrase|proofread|shorten|reword|edit|polish|describe|اعد صياغه|ترجم|لخص|اختصر|صحح|صف)(?:\s+(?:(?:this|the|provided|supplied|following)\s+)?(?:text|note|sentence|paragraph|message|النص|الجمله|الملاحظه))?(?:\s+(?:(?:into|to|in)\s+[\p{L} -]{1,40}|concisely|briefly|politely|باختصار|بوضوح|بادب))?[.!?؟,،]*$/u;
// One direct coding imperative from the owner: its object is a project, not text supplied in the message.
const CODING_IMPERATIVE = /^(?:fix|repair|format|lint|refactor|debug|اصلح|صلح|عدل|نسق|حسن|رتب)(?!\p{L})[^;.!?؟\n]{3,300}[.!?؟]*$/iu;
const BOUNDARY = /\b(?:and\s+then|then|afterwards|also|and)\b[\s,:،]*|(?<!\p{L})(?:ثم|وبعدها|وبعدين|بعدها|كذلك)(?!\p{L})[\s,:،]*|و(?=(?:جهز|حضر|اعد|شغل|نفذ|اعرض|استعرض|اسرد)(?!\p{L}))|[.!?؟;؛]\s+(?=\p{L})/gu;

const head = (text: string) => requestOperationText(text).replace(COURTESY, '').trim();
function privateScope(source: RequestScopeAssessment | null): Exclude<WorkRequestScope, 'unscoped' | 'explicit_work_goal'> | null {
  if (source?.source === 'local_state') {
    if (source.operation === 'lookup') return 'local_content_lookup';
    if (source.operation === 'transform') return 'local_content_transform';
  }
  if (source?.source === 'supplied_content') return source.operation === 'transform' ? 'supplied_transform' : 'supplied_content';
  if (source?.source === 'prior_conversation' && source.scope === 'private') {
    if (source.operation === 'lookup') return 'private_memory_lookup';
    if (source.operation === 'transform') return 'private_memory_transform';
  }
  return null;
}
function workClause(clause: string, capability: WorkRequestCapability): boolean {
  if (REPORTED.test(clause) || NARRATIVE.test(clause)) return false;
  if (capability === 'workspace_read') return INVENTORY.test(clause) || CODE.test(clause) || STUDIO.test(clause);
  return (capability === 'code_prepare' ? CODE : capability === 'studio_prepare' ? STUDIO : SKILL).test(clause);
}
function explicitOuterGoal(request: string, capability: WorkRequestCapability, localOperation?: 'lookup' | 'transform'): boolean {
  const actionText = requestScopeActionText(request), analysis = analyzeCompoundRequest(actionText);
  if (analysis.kind === 'invalid') return false;
  // Reuse the existing standalone output-format contract against the CURRENT
  // original, retaining quoted JSON field names without mining supplied data.
  if (capability === 'workspace_read' && projectInventoryFormat(actionText)) return true;
  const outer = head(maskRequestLiteralData(analysis.outerText));
  if (NARRATIVE.test(outer)) return false;
  if (workClause(outer, capability)) return true;
  if (localOperation === 'transform') return false;
  const boundaries = [...outer.matchAll(BOUNDARY)];
  if (!boundaries.length || boundaries.length > 16) return false;
  const first = boundaries[0]!, primary = head(outer.slice(0, first.index)).replace(/[\s,،]+$/u, '');
  if (REPORTED.test(primary) || NARRATIVE.test(primary) || /[:：]/u.test(primary)) return false;
  const balancedLiteral = analysis.literalRanges.some(range => /^["'«“‘`]/u.test(actionText.slice(range.start, range.end)));
  if (localOperation === 'lookup') {
    // Inspect the complete ORIGINAL primary; blanked quoted/screen instructions
    // cannot become a current user read. Only the outer separator comma is syntax.
    if (!isCurrentComputerReadRequest(analysis.primary.text.replace(/[,،]\s*$/u, ''))) return false;
  } else if (!(PRIVATE_PRIMARY.test(primary) || balancedLiteral && SUPPLIED_PRIMARY.test(primary))) return false;
  // Every preceding clause must itself be a recognized current work goal; an
  // intervening free-form reported sentence cannot forward authority to a tail.
  for (let index = 0; index < boundaries.length; index++) {
    const boundary = boundaries[index]!, end = boundaries[index + 1]?.index ?? outer.length;
    const clause = head(outer.slice(boundary.index + boundary[0].length, end));
    if (workClause(clause, capability)) return true;
    if (!CAPABILITIES.some(kind => workClause(clause, kind))) return false;
  }
  return false;
}

/**
 * HOST-ONLY current-source veto. No proposed project ID, tool payload, provider
 * output, history or UI text is accepted as authority. This does not dispatch,
 * execute, approve or replay work; generic work requests retain existing policy.
 * A positive result still requires owner access, exact target validation, quotas,
 * cancellation fences, review and Runtime approval. Scoped compound exceptions
 * intentionally recognize only closed current clauses, not general planning.
 * Computation-to-work compounds are conservatively unsupported here: this helper
 * does not certify a numeric primary or silently reuse its answer as authority.
 * Local lookup compounds require the separate complete-current-PC-read matcher;
 * a computer/window read cannot reuse the broader private-note primary grammar.
 * Local transform and unrecognized local-read compounds remain unsupported.
 * Standalone closed work goals and local ACT requests retain their prior policy.
 */
export function reviewWorkRequestScope(request: unknown, capability: WorkRequestCapability,
    understanding?: WorkRequestUnderstanding): WorkRequestScopeReview {
  const result = (allowed: boolean, scope: WorkRequestScope, reason: WorkRequestScopeReason): WorkRequestScopeReview =>
    Object.freeze({ version: 1, allowed, scope, reason });
  try {
    if (typeof request !== 'string' || !request.trim() || request.length > 4000 || /[\u0000\ud800-\udfff]/u.test(request)) return result(false, 'unscoped', 'invalid_request');
    if (!CAPABILITIES.includes(capability)) return result(false, 'unscoped', 'invalid_capability');
    const actionText = requestScopeActionText(request), source = assessRequestScope(actionText), masked = maskRequestLiteralData(actionText);
    const outer = head(masked);
    let scope = TRANSFORM.test(outer) && masked !== actionText || NARRATIVE.test(outer) ? 'supplied_transform' as const : privateScope(source);
    if (understanding?.original === request) {
      scope ??= privateScope(parseRequestScopeAssessment(understanding.sourceAssessment));
      if (!scope && understanding.intent === 'memory' && understanding.scope === 'private'
        && (source.operation === 'lookup' || source.operation === 'unknown')) scope = 'private_memory_lookup';
      // «اصلح الكود في مشروع …»: the context step lifts the project name into a slot and reads the bare «اصلح الكود» as
      // supplied text. A single direct coding imperative, with no quoted data, reported speech, narrative or second
      // clause, and no scoped source in its own text, is the owner's current work goal, as «اصلح مشروعي» already is.
      if (scope === 'supplied_content' && capability === 'code_prepare' && understanding.intent === 'coding' && !privateScope(source)
        && masked === actionText && CODING_IMPERATIVE.test(outer) && !REPORTED.test(outer) && !NARRATIVE.test(outer)
        && ![...outer.matchAll(BOUNDARY)].length) scope = null;
    }
    if (!scope) return result(true, 'unscoped', 'outside_scoped_sources');
    const localOperation = scope === 'local_content_lookup' ? 'lookup' : scope === 'local_content_transform' ? 'transform' : undefined;
    if (explicitOuterGoal(request, capability, localOperation)) return result(true, 'explicit_work_goal', 'explicit_outer_work_goal');
    return result(false, scope, scope);
  } catch { return result(false, 'unscoped', 'invalid_request'); }
}
