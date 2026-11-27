import { CodeKnowledge, formatAnswer, readBundledCorpus } from '@mohassan/code-knowledge';
import type { BrainState } from './brain.js';
import { isLiveWebQuestion } from './hands.js';
import { assessRequestScope, requestCapabilityAllowed, type UserRequestConstraints } from './request-scope.js';
import { formatTestDrivenCodingEvidence, type TestDrivenCodingEvidence } from './test-driven-coding/evidence.js';
import { parseTestDrivenCodingRequest } from './test-driven-coding/request.js';

const programmingTopic = /\b(?:python|javascript|typescript|node(?:\.js|js)|programming|code|regex|regular expressions?|syntax|functions?|exceptions?|arrays?|iterators?|async|await)\b|[\w$]+\.[\w$]+\s*\(|[\w$]+\(\)|بايثون|جافا\s*سكر[ي]?بت|تايب\s*سكريبت|البرمجة|الشفرة|الكود|التعبير النمطي|دال[ةه]|مصفوف[ةه]|استثناء/iu;
const dottedApi = /\b[A-Z][\w$]*\.[a-z_$][\w$]*/u;
const explanationLead = /^(?:explain|describe|compare)\s+|^(?:اشرح|صف|وض[ّ]?ح|قارن)(?!\p{L})\s+/iu;
const runnableRequest = /\b(?:runnable|executable|ready[- ]to[- ]run|working (?:code|example|implementation)|standalone (?:code|example|program|script)|(?:code|script|example|program|solution) (?:that|I can|we can) (?:run|execute)|(?:write|implement|create|build|provide|generate|give|show)\b[^\r\n.!?]{0,120}\b(?:code|program|script|function|implementation|example))\b|(?:قابل[ة]? للتنفيذ|قابل[ة]? للتشغيل|مثال عملي|(?:اكتب|نف[ّ]?ذ|برمج|أنشئ|انشئ|اعطني|أعطني|أرني|ارني)[^\r\n.!؟?]{0,120}(?:دال[ةه]|برنامجا?|شفرة|كود|مثال))/iu;
const documentationRoutes = new Set(['web_search', 'chat', 'unsupported', 'clarify', 'coding']);

type Candidate = { kind: 'explanation'; text: string } | { kind: 'runnable'; evidence: TestDrivenCodingEvidence };
type Outcome = Candidate | { kind: 'abstained'; reason: 'no-evidence' | 'requires-verification' | 'publication-withheld' | 'unavailable' };
type TurnState = Pick<BrainState, 'routing' | 'requestResolution' | 'steps' | 'trail' | 'dropHeld' | 'actionCompletion'>;

interface CodeKnowledgeTurn {
  request: string;
  actionRequest: string;
  state: TurnState;
  constraints: UserRequestConstraints | null;
  signal: AbortSignal;
  scrub: (text: string) => string;
}

let bundledIndex: Promise<CodeKnowledge> | undefined;

function loadDocumentation(): Promise<CodeKnowledge> {
  return bundledIndex ??= readBundledCorpus().then(corpus => {
    const sources = corpus.sources.filter(source => source.kind === 'documentation');
    const sourceIds = new Set(sources.map(source => source.id));
    return new CodeKnowledge({ sources, passages: corpus.passages.filter(passage => sourceIds.has(passage.sourceId)) });
  }).catch(error => {
    bundledIndex = undefined;
    throw error;
  });
}

function eligible(turn: CodeKnowledgeTurn): boolean {
  const { state, constraints } = turn;
  if (turn.signal.aborted || !requestCapabilityAllowed(constraints, 'knowledge_read') || state.steps || state.trail.length || state.dropHeld) return false;
  const ledger = state.actionCompletion;
  if (!ledger || ledger.fault || ledger.contract.coverage !== 'bounded' || ledger.contract.requirements.length || ledger.events.length) return false;
  const route = state.routing;
  if (!route || route.availability === 'restricted' || ['request_refused', 'scratch_refuse', 'scratch_out_of_scope'].includes(route.reason)) return false;
  if (state.requestResolution && state.requestResolution.kind !== 'new') return false;
  if (route.handler === 'local_coding') return route.availability === 'ready';
  const action = turn.actionRequest;
  if (!documentationRoutes.has(route.route) || (!programmingTopic.test(action) && !dottedApi.test(action)) || isLiveWebQuestion(action)) return false;
  const scope = assessRequestScope(turn.request);
  if (scope.source === 'unresolved' && scope.reasons.includes('missing_target')) return explanationLead.test(turn.actionRequest);
  return scope.source === 'public_lookup' && ['lookup', 'transform'].includes(scope.operation)
    && !scope.reasons.some(reason => reason === 'explicit_public_lookup' || reason === 'public_document_reference');
}

async function candidate(turn: CodeKnowledgeTurn): Promise<Outcome> {
  const parsed = turn.state.routing?.handler === 'local_coding' ? parseTestDrivenCodingRequest(turn.request) : null;
  if (!parsed && runnableRequest.test(turn.actionRequest)) return { kind: 'abstained', reason: 'requires-verification' };
  const answer = (await loadDocumentation()).answer(parsed?.description ?? turn.actionRequest, { snippets: parsed ? 'require' : 'omit' });
  if (answer.status !== 'answered') return { kind: 'abstained', reason: 'no-evidence' };
  const locale = /\p{Script=Arabic}/u.test(parsed?.description ?? turn.actionRequest) ? 'ar' : 'en';
  if (!parsed) {
    const text = formatAnswer(answer, locale);
    return turn.scrub(text) === text ? { kind: 'explanation', text } : { kind: 'abstained', reason: 'publication-withheld' };
  }
  for (const { citation, code, sentences } of answer.excerpts) {
    const block = code.find(item => /^(?:py|python)$/iu.test(item.language ?? '') && !item.text.includes('```'));
    if (!block) continue;
    const evidence: TestDrivenCodingEvidence = { intent: answer.intent, citation, sentences, locale,
      code: { ...block, language: 'python', text: block.text.endsWith('\n') ? block.text : `${block.text}\n` } };
    const text = formatTestDrivenCodingEvidence(evidence);
    if (turn.scrub(text) === text) return { kind: 'runnable', evidence };
    return { kind: 'abstained', reason: 'publication-withheld' };
  }
  return { kind: 'abstained', reason: 'requires-verification' };
}

function observe(outcome: Outcome): void {
  try {
    const detail = outcome.kind === 'runnable' ? { kind: 'requires-verification', text: formatTestDrivenCodingEvidence(outcome.evidence) } : outcome;
    console.info(JSON.stringify({ event: 'code_knowledge_shadow', ...detail }));
  } catch { /* Observation cannot affect the reply. */ }
}

/** Optional documentation evidence. A runnable candidate can only be published by the existing Python path. */
export async function evaluateCodeKnowledgeTurn(turn: CodeKnowledgeTurn): Promise<Candidate | null> {
  const shadow = process.env.MOHASSAN_CODE_KNOWLEDGE_SHADOW === '1';
  const live = process.env.MOHASSAN_CODE_KNOWLEDGE_LIVE === '1';
  if ((!shadow && !live) || !eligible(turn)) return null;
  const result = candidate(turn).catch((): Outcome => ({ kind: 'abstained', reason: 'unavailable' }));
  if (!live) {
    void result.then(outcome => { if (!turn.signal.aborted) observe(outcome); });
    return null;
  }
  const outcome = await result;
  if (turn.signal.aborted) return null;
  if (shadow) observe(outcome);
  return outcome.kind === 'abstained' ? null : outcome;
}
