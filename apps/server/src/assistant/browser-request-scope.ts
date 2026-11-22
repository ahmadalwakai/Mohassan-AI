import type { RequestResolution } from './request-context.js';
import { analyzeCompoundRequest } from './compound-request.js';
import { isCurrentComputerReadRequest } from './computer-request-language.js';
import { assessRequestScope, parseRequestScopeAssessment, parseUserRequestConstraints, requestCapabilityAllowed,
  maskRequestLiteralData, requestOperationText, requestScopeActionText, type RequestScopeAssessment } from './request-scope.js';

export type BrowserRequestCapability = 'browser_navigation' | 'browser_action';
export type BrowserRequestUnderstanding = Pick<RequestResolution, 'original' | 'intent' | 'scope' | 'sourceAssessment'>;
export type BrowserRequestScope = 'unscoped' | 'private_memory_lookup' | 'private_memory_transform' | 'supplied_transform' | 'supplied_content' | 'local_content' | 'explicit_browser_goal';
export type BrowserRequestScopeReason = 'invalid_request' | 'invalid_capability' | 'request_constraint'
  | 'private_memory_lookup' | 'private_memory_transform' | 'supplied_transform' | 'supplied_content' | 'local_content' | 'explicit_outer_browser_goal' | 'outside_scoped_sources';
export interface BrowserRequestScopeReview {
  readonly version: 1;
  readonly allowed: boolean;
  readonly scope: BrowserRequestScope;
  readonly reason: BrowserRequestScopeReason;
}

const MAX_REQUEST = 4000;
const URL = /^https?:\/\/[^\s<>"'«»`]+[.!?؟]*$/iu;
const BROWSER_TARGET = /^(?:(?:the|my|a|an|current|existing|shared)\s+){0,3}(?:browser|web browser|website|webpage|web page)(?:\s+(?:window|tab))?[.!?؟]*$|^(?:المتصفح|متصفحي|متصفح الويب|الموقع|موقع الويب|صفحه الويب)(?:\s+(?:الحالي|الحاليه|المشاركه))?[.!?؟]*$/u;
const BROWSER_LOCATION_TARGET = /^[\p{L}\p{N} _/-]{1,160}\s+(?:in|inside|using)\s+(?:(?:the|my|current|shared|existing)\s+){0,3}(?:web\s+)?browser[.!?؟]*$|^[\p{L}\p{N} _/-]{1,160}\s+(?:في|داخل|باستخدام)\s+(?:المتصفح|متصفحي)(?:\s+الحالي)?[.!?؟]*$/u;
const OPEN = /^(?:(?:open|visit|navigate(?:\s+to)?|go\s+to)\s+|(?:افتح|زر|اذهب\s+(?:الي|الى)|انتقل\s+(?:الي|الى))\s+)/iu;
const BROWSER_INTERACTION = /^(?:click|press|type|select|scroll|انقر|اضغط|اكتب|اختر|حدد|مرر)(?!\p{L})/u;
const BROWSER_LOCATION = /\b(?:in|inside|within|on)\s+(?:(?:the|my|current|shared|existing)\s+){0,3}(?:web browser|browser|website|webpage|web page)\b|(?:^|\s)(?:في|داخل|علي)\s+(?:المتصفح|متصفحي|الموقع|موقع الويب|صفحه الويب)(?=\s|[\p{P}]|$)/u;
const EN_BROWSER_SURFACE = '(?:(?:the|my|current|shared|existing|open|active)\\s+){0,3}(?:web browser|browser|website|webpage|web page|browser tab|browser window|tab|page)(?:\\s+(?:tab|page|window))?';
const AR_BROWSER_SURFACE = '(?:المتصفح|متصفحي|صفحه المتصفح|صفحه الويب|الموقع|موقع الويب|التبويب)(?:\\s+(?:الحالي|الحاليه|المفتوح|المفتوحه|المشارك|المشاركه))?';
const BROWSER_READ = new RegExp(`^(?:(?:read|view|inspect|look at|show|describe)\\s+(?:(?:(?:the|current)\\s+)?(?:title|text|contents?|button labels?)\\s+(?:of|on|in)\\s+)?${EN_BROWSER_SURFACE}|(?:اقرا|اعرض|افحص|شاهد|صف|انظر(?:\\s+الي)?)\\s+(?:(?:عنوان|النص|محتوي|ازرار)\\s+(?:في\\s+)?)?${AR_BROWSER_SURFACE})[.!?؟]*$`, 'u');
const COURTESY = /^(?:(?:please|kindly|can you|could you|would you|i want you to|من فضلك|لو سمحت|رجاء|هل يمكنك|هل تستطيع|هل تقدر|يمكنك|اريد منك ان)[,،:\s]+)+/u;
const REPORT = /^(?:(?:the|this|a|my|our|saved|stored)\s+){0,3}(?:note|document|file|page|email|message|quote|text)\s+(?:says|reads|contains|states|includes)\b|^(?:النص|الرساله|الصفحه|الملف|المستند|الملاحظه)\s+(?:يقول|تقول|يحتوي|تحتوي|مكتوب)/iu;
const NARRATIVE = /^(?:write|draft|compose|tell|rewrite|اكتب|الف|احك|اعد صياغه)\s+[\s\S]{0,140}?(?:story|fiction|scene|dialogue|play|poem|قصه|حكايه|حوار|مشهد|مسرحيه|قصيده)\s+(?:where|in which|whose|about|عن|حيث|فيها)(?!\p{L})/iu;
const REPORTED_BODY = /\b(?:which|that)\s+(?:says|reads|contains|states|includes)|\b(?:the|my|our|saved)\s+(?:note|text|page|message)\s+(?:says|reads|contains|states|includes)|(?:الذي|التي)\s+(?:يقول|تقول|يحتوي|تحتوي|مكتوب)/iu;
const REPORT_RELATION = /\b(?:says|reads|contains|states|includes)\b|(?:^|\s)(?:يقول|تقول|قال|قالت|يحتوي|تحتوي|مكتوب)(?=\s|[\p{P}]|$)/iu;
const LOOKUP_HEAD = /^(?:read|recall|retrieve|search|look up|find|what|who|when|where|why|how|which|اقرا|استرجع|استعد|ابحث|تذكر|ما|ماذا|من|كم|كيف|اين|وين|متي)(?!\p{L})/u;
const TRANSFORM = /^(?:rewrite|translate|summari[sz]e|paraphrase|proofread|shorten|reword|edit|polish|describe|اعد صياغه|ترجم|لخص|اختصر|صحح|صف)(?!\p{L})/iu;
// Match only an actual outer computation imperative. A numeric operand or an
// inferred compute operation inside supplied text does not supply this head.
const COMPUTE_HEAD = /^(?:calculate|compute|convert|multiply|divide|add|subtract|احسب|حول|اضرب|اقسم|اجمع|اطرح)(?![\p{L}_])/iu;

function scoped(source: RequestScopeAssessment | null): Exclude<BrowserRequestScope, 'unscoped' | 'explicit_browser_goal'> | null {
  if (source?.source === 'supplied_content') return source.operation === 'transform' ? 'supplied_transform' : 'supplied_content';
  if (source?.source === 'local_state' && (source.operation === 'lookup' || source.operation === 'transform')) return 'local_content';
  if (source?.source === 'prior_conversation' && source.scope === 'private' && source.operation === 'lookup') return 'private_memory_lookup';
  if (source?.source === 'prior_conversation' && source.scope === 'private' && source.operation === 'transform') return 'private_memory_transform';
  return null;
}

function directBrowserClause(text: string): boolean {
  const matching = requestOperationText(text).replace(COURTESY, '').trim();
  const masked = requestOperationText(maskRequestLiteralData(text)).replace(COURTESY, '').trim();
  // A browser location in a description of a private note is not the requested
  // read object. Only a closed browser/page/tab read can supply that exception;
  // broader owned-content reads stay scoped even if they mention a browser.
  if ((BROWSER_READ.test(masked) || BROWSER_INTERACTION.test(masked) && BROWSER_LOCATION.test(masked))
      && !REPORT_RELATION.test(masked)) return true;
  const opening = OPEN.exec(matching);
  if (!opening) return false;
  const target = matching.slice(opening[0].length).trim();
  // This recognizes an explicitly requested browser objective, never the URL
  // chosen by a model. URL safety, exact permits and approvals remain separate.
  return URL.test(target) || BROWSER_TARGET.test(target) || BROWSER_LOCATION_TARGET.test(target);
}

/** A narrow current OUTER instruction, independent of retrieved/model/page data. */
function hasOuterBrowserGoal(request: string): boolean {
  const actionText = requestScopeActionText(request), analysis = analyzeCompoundRequest(actionText);
  if (analysis.kind === 'invalid') return false;
  const outer = requestOperationText(analysis.outerText).replace(COURTESY, '');
  if (REPORT.test(outer) || NARRATIVE.test(outer)) return false;
  // The complete primary clause must itself be a browser request. A quoted URL
  // or reported sentence is not promoted into an outer command.
  if (directBrowserClause(analysis.primary.text)) return true;
  if (analysis.kind !== 'compound') return false;
  const primaryOuter = requestOperationText(analysis.outerText.slice(analysis.primary.start, analysis.primary.end)).replace(COURTESY, '');
  if (REPORT.test(primaryOuter) || NARRATIVE.test(primaryOuter) || REPORTED_BODY.test(primaryOuter)
      || REPORT_RELATION.test(primaryOuter) || /[:：]/u.test(primaryOuter)) return false;
  const primarySource = assessRequestScope(analysis.primary.text);
  if (primarySource.source === 'supplied_content' && primarySource.operation === 'transform') {
    // A complete balanced literal is the only supplied-transform envelope for
    // which this helper recognizes a later outer action. An unquoted/colon body
    // remains data, including every apparent "then open" instruction inside it.
    if (!TRANSFORM.test(primaryOuter) || /[:：]/u.test(primaryOuter)
      || !analysis.literalRanges.some(range => range.start >= analysis.primary.start && range.end <= analysis.primary.end
        && /^["'«“‘`]/u.test(actionText.slice(range.start, range.end)))) return false;
  } else if (primarySource.source === 'supplied_content' && primarySource.operation === 'compute') {
    // This preserves the separately requested browser clause only. It is not
    // computation validation or evidence that the primary calculation succeeded.
    if (!COMPUTE_HEAD.test(primaryOuter)) return false;
  } else if (scoped(primarySource) === 'local_content') {
    // A comma immediately before the recognized sequence boundary is a clause
    // separator; it is not part of the closed read object's name.
    const readPrimary = analysis.primary.text.replace(/[,،]\s*$/u, '');
    if (primarySource.operation === 'lookup' ? !isCurrentComputerReadRequest(readPrimary)
      : !TRANSFORM.test(primaryOuter)) return false;
  } else if (scoped(primarySource) === 'private_memory_lookup') {
    // A reported note is data even when it contains an apparent outer sequence.
    // Require a current user lookup head, rather than an owned-noun prefix.
    if (!LOOKUP_HEAD.test(primaryOuter)) return false;
  } else if (scoped(primarySource) === 'private_memory_transform') {
    if (!TRANSFORM.test(primaryOuter)) return false;
  } else return false;
  return analysis.pendingActions.some(action => action.kind === 'open' && directBrowserClause(action.text));
}

/**
 * HOST-ONLY source veto, not a tool grant or universal URL data-loss policy.
 * Pass the CURRENT original request and its trusted host understanding. Supplied
 * text, memory results, page content and model proposals must never be passed as
 * the request/understanding. Only an exact current-original match can add scope;
 * metadata can never override an independently detected private source.
 * Generic browser/public tasks retain existing policies. A true result still
 * requires the existing account, request constraints, network, page, approval,
 * cancellation and effect checks. No action or URL is dispatched here.
 */
export function reviewBrowserRequestScope(request: unknown, capability: BrowserRequestCapability,
    understanding?: BrowserRequestUnderstanding): BrowserRequestScopeReview {
  const result = (allowed: boolean, scope: BrowserRequestScope, reason: BrowserRequestScopeReason): BrowserRequestScopeReview =>
    Object.freeze({ version: 1, allowed, scope, reason });
  try {
    if (typeof request !== 'string' || !request.trim() || request.length > MAX_REQUEST || /[\u0000\ud800-\udfff]/u.test(request))
      return result(false, 'unscoped', 'invalid_request');
    if (capability !== 'browser_navigation' && capability !== 'browser_action') return result(false, 'unscoped', 'invalid_capability');
    if (!requestCapabilityAllowed(parseUserRequestConstraints(request), capability)) return result(false, 'unscoped', 'request_constraint');
    const actionText = requestScopeActionText(request), source = assessRequestScope(actionText);
    const literalMasked = maskRequestLiteralData(actionText), outerHead = requestOperationText(literalMasked).replace(COURTESY, '');
    // URL-looking words inside a literal must not turn a supplied transform
    // into a public-document lookup. Independently inspect its outer envelope.
    let scope = (TRANSFORM.test(outerHead) && literalMasked !== actionText || NARRATIVE.test(outerHead))
      ? 'supplied_transform' as const : scoped(source);
    if (understanding?.original === request) {
      const trustedSource = parseRequestScopeAssessment(understanding.sourceAssessment);
      scope ??= scoped(trustedSource);
      if (!scope && understanding.intent === 'memory' && understanding.scope === 'private'
          && (source.operation === 'unknown' || source.operation === 'lookup')) scope = 'private_memory_lookup';
    }
    if (!scope) return result(true, 'unscoped', 'outside_scoped_sources');
    if (hasOuterBrowserGoal(request)) return result(true, 'explicit_browser_goal', 'explicit_outer_browser_goal');
    return result(false, scope, scope);
  } catch { return result(false, 'unscoped', 'invalid_request'); }
}
