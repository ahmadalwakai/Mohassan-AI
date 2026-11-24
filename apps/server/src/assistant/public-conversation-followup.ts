import { emptyConversationState, understandTurn } from './conversation-state.js';
import { analyzeCompoundRequest } from './compound-request.js';
import { fold } from './hands.js';
import { MAX_CONTEXT_REQUEST, type RequestResolution } from './request-context.js';
import { splitReplyDirective } from './reply-directive.js';
import { superlativeEvidence } from './source-superlative.js';
import {
  parseRequestScopeAssessment, parseUserRequestConstraints, requestCapabilityAllowed, reviewPublicProjection,
  type RequestScopeAssessment,
} from './request-scope.js';

export interface PublicConversationFollowupInput {
  request: string;
  /** The current host resolution, not a resolution reconstructed from a reply. */
  resolution: RequestResolution;
  previousSource: RequestScopeAssessment | null | undefined;
  /** Host-selected user messages, oldest first. Never include assistant replies or tool/page text. */
  earlierUserTurns: readonly string[];
  /** A question, approval or sign-in awaiting an answer keeps its existing handler. */
  pending?: boolean;
}

const MAX_REPLAY_TURNS = 8;
const MAX_QUERY_LENGTH = 500;
const acceptedTypes = new Set(['follow_up_property', 'follow_up_entity', 'correction']);
// This narrow lookup helper must leave outer actions with their existing handlers.
// A public v1 source may be inherited before generic action classification runs;
// matching outside literal ranges also catches polite/modal heads and action tails.
const OUTER_ACTION = /(?:^|[^\p{L}\p{N}])(?:send|email|mail|deliver|publish|post|save|store|record|remember|delete|remove|erase|open|visit|navigate|run|execute|launch|schedule|remind|book|reserve|buy|purchase|pay|transfer|write|draft|compose|create|generate|update|edit|change|replace|download|upload|copy|move|click|press|type|tell)(?!\p{L})|(?:^|[^\p{L}\p{N}])(?:و|ف)?(?:ارسل|ابعث|ابعت|ترسل|تبعث|تبعت|انشر|تنشر|احفظ|خزن|سجل|تذكر|احذف|ازل|امسح|تحذف|افتح|ادخل|اذهب|تفتح|شغل|نفذ|تشغل|تنفذ|ذكرني|نبهني|جدول|احجز|اشتر|اشتري|ادفع|حول|اكتب|صغ|انشئ|اصنع|ولد|غير|عدل|حدث|بدل|ارفع|انسخ|انقل|اضغط|انقر)(?:ها|ه|هم)?(?!\p{L})/iu;
const actionMatchingText = (text: string) => text.normalize('NFKC')
  .replace(/[\u0640\u064b-\u065f\u0670]|\p{Cf}/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه');
const clean = (text: string) => text.normalize('NFC')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').replace(/\s+/gu, ' ').trim();

/**
 * Restricted production use of v2: refine an already-authorized public follow-up's search query only.
 * It grants no action, tool or route permission and never reads the asynchronous shadow log/state.
 * Bounded replay uses existing user history, so restarts need no new persistence or background work.
 * Missing context, guesses, host-result operands and rejected v1 queries retain the existing path.
 */
export function publicConversationFollowup(input: PublicConversationFollowupInput): string | null {
  const { request, resolution } = input;
  if (input.pending || resolution.pendingQuestionId || typeof request !== 'string'
    || !request.trim() || request.length > MAX_CONTEXT_REQUEST
    || clean(request) !== resolution.original || resolution.kind !== 'follow_up'
    || resolution.scope !== 'public' || !resolution.query || resolution.ambiguities.length
    || !['web_search', 'news'].includes(resolution.intent)
    || !requestCapabilityAllowed(resolution.constraints ?? null, 'public_search')
    || !requestCapabilityAllowed(parseUserRequestConstraints(request), 'public_search')) return null;

  // Returning just a query would discard response language/length/field instructions.
  if (splitReplyDirective(request).directive) return null;

  const compound = analyzeCompoundRequest(request);
  // v2 scans request words; literal operands must not select a conversational property.
  // Quoted public names also retain the existing handler in this restricted tranche.
  if (compound.kind !== 'single' || compound.literalRanges.length > 0
    || OUTER_ACTION.test(actionMatchingText(compound.outerText))) return null;

  const previous = parseRequestScopeAssessment(input.previousSource);
  const current = parseRequestScopeAssessment(resolution.sourceAssessment);
  if (previous?.source !== 'public_lookup' || previous.scope !== 'public' || previous.operation !== 'lookup'
    || !previous.publicQueryEligible || current?.source !== 'public_lookup' || current.scope !== 'public'
    || current.operation !== 'lookup' || !current.publicQueryEligible) return null;

  const turns = input.earlierUserTurns.slice(-MAX_REPLAY_TURNS);
  if (!turns.length || turns.some(text => typeof text !== 'string' || !text.trim() || text.length > MAX_CONTEXT_REQUEST)) return null;
  let state = emptyConversationState();
  for (const [index, text] of turns.entries()) state = understandTurn(state, text, `public-context-${index}`).next;
  const understanding = understandTurn(state, request, 'public-followup');
  // The class in a superlative question cannot identify its result. Let the sourced answer supply the name.
  if (understanding.type === 'follow_up_property' && superlativeEvidence(fold(turns.at(-1)!))) return null;
  const topic = understanding.next.topics.at(-1);
  if (!acceptedTypes.has(understanding.type) || !understanding.property || !understanding.entity
    || !understanding.query || understanding.query.length > MAX_QUERY_LENGTH
    || understanding.needs || understanding.against || understanding.assumption || understanding.reference
    || topic?.entityOrigin !== 'user' || !topic.lookup || topic.sourceTurnId !== 'public-followup'
    || understanding.v1.kind !== 'follow_up' || understanding.v1.scope !== 'public'
    || !understanding.v1.query || understanding.v1.ambiguities.length) return null;

  return reviewPublicProjection(request, understanding.query, { contextKind: resolution.kind, previous }).eligible
    ? understanding.query : null;
}
