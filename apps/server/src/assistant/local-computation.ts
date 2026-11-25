import { buildFrame } from './mind/frame.js';
import { compute, type ComputationConsumption } from './mind/compute.js';
import type { Claim, Evidence } from './mind/contract.js';
import { evaluateLocalReasoning, type ReasoningContext } from './reasoning/index.js';
import { analyzeCompoundRequest, type CompoundRequestAnalysis, type PendingActionKind } from './compound-request.js';
import { splitReplyDirective, type ReplyDirective, type ReplyLanguage } from './reply-directive.js';

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
}

/**
 * Only explicit computation frames reach the calculator. In particular, a price,
 * exchange rate, personal memory, or instruction quoted in a document is not a
 * local calculation. Unsupported expressions remain available to the ordinary
 * routing path; an understood but invalid calculation returns its exact boundary.
 */
export function evaluateLocalComputation(request: string, now = new Date(), reasoning?: ReasoningContext): LocalComputation | null {
  if (!request.trim() || request.length > 4000 || !Number.isFinite(now.getTime())) return null;
  const whole = evaluateLocalReasoning(request, now, reasoning) ?? evaluateComputationText(request, now);
  if (whole) return whole;
  // «QA test 2026-11-23: Calculate 37 × 24 and reply with the result in one short Arabic sentence.» (live test, 2026-11-23):
  // the label in front and the closing instruction about the reply are not part of the calculation. Only the request
  // between them is calculated, and only when it is a complete calculation on its own; the reply then follows the
  // instruction. A label or an instruction alone never turns other words into a calculation.
  const framing = splitReplyDirective(request);
  if ((!framing.label && !framing.directive) || framing.body === request.trim()) return null;
  const inner = evaluateComputationText(framing.body, now);
  if (!inner) return null;
  return framing.directive ? shapedReply(inner, framing.directive) : inner;
}

/** «37 * 24 = 888» as the reply the owner asked for: one sentence in the requested language. Code writes it, not a model. */
function shapedReply(result: LocalComputation, directive: ReplyDirective): LocalComputation {
  const lang: ReplyLanguage = directive.lang ?? result.lang;
  if (result.status !== 'completed' || result.compound?.pendingActions.length || (lang === result.lang && !directive.sentences)) return result;
  const evidence = result.evidence.find(item => item.id === 'calculation' && item.value !== undefined);
  if (!evidence?.value) return result;
  const equation = /^(.+?)\s=\s(.+)$/u.exec(evidence.quote);
  const shown = equation && equation[2] === evidence.value
    ? equation[1]!.replace(/\((-?\d+(?:\.\d+)?)\)/gu, '$1').replace(/\s*\*\s*/gu, ' × ').replace(/\s*\/\s*/gu, ' ÷ ').trim() : null;
  const sentence = lang === 'ar'
    ? shown ? `ناتج ${shown} هو ${evidence.value}.` : `النتيجة: ${evidence.quote}.`
    : shown ? `${shown} equals ${evidence.value}.` : `The result is ${evidence.quote}.`;
  const reply: Evidence = { id: 'calculation-reply', source: 'computed', quote: sentence, value: evidence.value };
  return { ...result, lang, text: sentence, claims: [{ text: sentence, support: [reply.id], status: 'confirmed' }], evidence: [...result.evidence, reply] };
}

function evaluateComputationText(request: string, now: Date): LocalComputation | null {
  const compound = analyzeCompoundRequest(request);
  if (compound.kind === 'invalid' || compound.kind === 'unsupported_tail') return null;
  const frame = buildFrame(compound.kind === 'compound' ? compound.primary.text : request);
  if (frame.intent !== 'compute' || frame.missing.length) return null;
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
