import { buildFrame } from './mind/frame.js';
import { compute, type ComputationConsumption } from './mind/compute.js';
import { calculationBodyBeforeWork } from './mind/computation-consumption.js';
import type { Claim, Evidence } from './mind/contract.js';
import { evaluateLocalReasoning, type ReasoningContext } from './reasoning/index.js';
import { analyzeCompoundRequest, type CompoundRequestAnalysis, type PendingActionKind } from './compound-request.js';
import { splitReplyDirective, type ReplyConstraints, type ReplyLanguage } from './reply-directive.js';
import { replyBodyFor } from './reply-turn.js';
import { evaluateWordProblem } from './word-problem.js';
import { arbiterEnabled, arbitrateComponent, discoverArbiterClaims, hasArbiterExecution } from './model-relations-arbiter.js';

/** A local calculation is a reusable capability, independent of the experimental Mind route. */
export interface LocalComputation {
  status: 'completed' | 'partial' | 'blocked';
  text: string;
  lang: 'ar' | 'en';
  claims: Claim[];
  evidence: Evidence[];
  /** Coverage refers to this calculation's original primary argument. */
  consumption?: ComputationConsumption;
  /** Step-only evidence: no pending action has been dispatched or verified. */
  compound?: CompoundRequestAnalysis;
  /** Host may use the verified step separately while continuing the full request. */
  primaryText?: string;
  pendingNote?: string;
  /** A word problem was understood as arithmetic but had no reliable expression. */
  abstained?: true;
}

/**
 * Only explicit computation frames reach the calculator. In particular, a price,
 * exchange rate, personal memory, or instruction quoted in a document is not a
 * local calculation. Unsupported expressions remain available to the ordinary
 * routing path; an understood but invalid calculation returns its exact boundary.
 */
export function evaluateLocalComputation(request: string, now = new Date(), reasoning?: ReasoningContext, reply?: ReplyConstraints): LocalComputation | null {
  if (!request.trim() || request.length > 4000 || !Number.isFinite(now.getTime())) return null;
  if (reply) request = replyBodyFor(request);
  const beforeWork = calculationBodyBeforeWork(request);
  const contestedReasoning = reasoning && Object.hasOwn(reasoning, 'previousUserTurn') && hasArbiterExecution() && arbiterEnabled();
  const choose = (ranked: LocalComputation, native: () => LocalComputation | null): LocalComputation => {
    if (!contestedReasoning) return ranked;
    return discoverArbiterClaims('local-computation', ranked, undefined, shadowLog => {
      const started = performance.now();
      try {
        const computation = native();
        if (!computation) return ranked;
        return arbitrateComponent<LocalComputation>('local-computation', { text: request, started, shadowLog,
          conversationState: reasoning?.previousUserTurn ? 'with-history' : 'new' },
        { component: 'reasoning-engine', label: ranked.status, result: ranked },
        [{ component: 'local-calculator', label: computation.status, result: computation }]);
      } catch {
        return ranked;
      }
    });
  };
  if (beforeWork) {
    const ranked = evaluateLocalReasoning(beforeWork, now, reasoning, reply);
    const native = () => evaluateComputationText(request, now, beforeWork, reply?.lang);
    return ranked ? choose(ranked, native) : native();
  }
  const ranked = evaluateLocalReasoning(request, now, reasoning, reply);
  const native = () => evaluateComputationText(request, now, request, reply?.lang) ?? evaluateWordProblem(request);
  const whole = ranked ? choose(ranked, native) : native();
  if (whole) return reply ? shapedReply(whole, reply) : whole;
  // «QA test 2026-11-23: Calculate 37 × 24 and reply with the result in one short Arabic sentence.» (live test, 2026-11-23):
  // the label in front and the closing instruction about the reply are not part of the calculation. Only the request
  // between them is calculated, and only when it is a complete calculation on its own; the reply then follows the
  // instruction. A label or an instruction alone never turns other words into a calculation.
  const framing = splitReplyDirective(request);
  if ((!framing.label && !framing.directive) || framing.body === request.trim()) return null;
  const inner = evaluateComputationText(framing.body, now);
  if (!inner) return null;
  const constraints = reply ?? framing.directive;
  return constraints ? shapedReply(inner, constraints) : inner;
}

/** «37 * 24 = 888» as the reply the owner asked for: one sentence in the requested language. Code writes it, not a model. */
function shapedReply(result: LocalComputation, directive: ReplyConstraints): LocalComputation {
  const lang: ReplyLanguage = directive.lang ?? result.lang;
  if (result.status !== 'completed' || result.compound?.pendingActions.length) return result;
  const replyHasRequestedScript = lang === 'ar' ? /(?=\p{Script=Arabic})\p{L}/u.test(result.text) : /\p{Script=Latin}/u.test(result.text);
  if (lang === result.lang && !directive.sentences && !directive.brief && (!directive.lang || replyHasRequestedScript)) return result;
  const evidence = result.evidence.find(item => item.id === 'calculation' && item.value !== undefined);
  if (!evidence?.value) return result;
  if (result.text === evidence.value && !directive.sentences) return { ...result, lang };
  const literal = directive.lang && !replyHasRequestedScript && /\p{L}/u.test(evidence.quote);
  const equation = literal ? null : /^(.+?)\s=\s(.+)$/u.exec(evidence.quote);
  const shown = equation && equation[2] === evidence.value
    ? equation[1]!.replace(/\((-?\d+(?:\.\d+)?)\)/gu, '$1').replace(/\s*\*\s*/gu, ' × ').replace(/\s*\/\s*/gu, ' ÷ ').trim() : null;
  const quote = literal ? (lang === 'ar' ? `«${evidence.quote}»` : `“${evidence.quote}”`) : evidence.quote;
  const sentence = lang === 'ar'
    ? shown ? `ناتج ${shown} هو ${evidence.value}.` : `النتيجة: ${quote}.`
    : shown ? `${shown} equals ${evidence.value}.` : `The result is ${quote}.`;
  const reply: Evidence = { id: 'calculation-reply', source: 'computed', quote: sentence, value: evidence.value };
  return { ...result, lang, text: sentence, claims: [{ text: sentence, support: [reply.id], status: 'confirmed' }], evidence: [...result.evidence, reply] };
}

function evaluateComputationText(request: string, now: Date, body = request, language?: ReplyLanguage): LocalComputation | null {
  const compound = analyzeCompoundRequest(body);
  if (compound.kind === 'invalid' || compound.kind === 'unsupported_tail' || body !== request && compound.kind !== 'single') return null;
  const frame = buildFrame(compound.kind === 'compound' ? compound.primary.text : body);
  if (frame.intent !== 'compute' || frame.missing.length) return null;
  if (language) frame.lang = language;
  // Formatting is an outer instruction too; quoted/body data cannot invent it.
  if (compound.kind === 'compound') frame.valueOnly ||= buildFrame(compound.outerText).valueOnly;
  const result = compute(frame, now, { originalText: compound.kind === 'compound' ? compound.primary.text : request });
  if (!result || (result.status !== 'completed' && result.status !== 'blocked')) return null;
  if (compound.kind !== 'compound') return { ...result, status: result.status, lang: frame.lang };
  if (!compound.pendingActions.length) return { ...result, status: result.status, lang: frame.lang, compound };
  const labels: Record<PendingActionKind, readonly [string, string]> = {
    compute: ['الحساب التالي', 'the next calculation'], save: ['الحفظ', 'saving'], send: ['الإرسال', 'sending'],
    publish: ['النشر', 'publishing'], schedule: ['التذكير أو الجدولة', 'the reminder or schedule'],
    open: ['فتح الوجهة', 'opening the destination'], delete: ['الحذف', 'deletion'], change: ['التعديل', 'the requested change'], run: ['التشغيل', 'execution'],
  };
  const remaining = [...new Set(compound.pendingActions.map(action => labels[action.kind][frame.lang === 'ar' ? 0 : 1]))];
  const note = frame.lang === 'ar'
    ? `ما زال معلقًا: ${remaining.join('، ')}. لم أنفّذ الإجراءات اللاحقة؛ النتيجة أعلاه تخص الحساب فقط.`
    : `Still pending: ${remaining.join(', ')}. No follow-up action was performed; the result above covers the calculation only.`;
  return { ...result, status: result.status === 'completed' ? 'partial' : 'blocked', lang: frame.lang,
    text: `${result.text}\n${note}`, claims: [...result.claims, { text: note, support: [], status: 'fixed' }], compound,
    primaryText: result.text, pendingNote: note };
}
