import { calculatorForm, computationReference, withReferencedValue } from './computation-reference-language.js';
import type { CompoundRequestAnalysis } from './compound-request.js';
import type { LocalComputation } from './local-computation.js';
import { compute, type ComputedReply } from './mind/compute.js';
import type { Claim, Evidence, Lang } from './mind/contract.js';
import { buildFrame } from './mind/frame.js';

/** Evaluate the whole sequence only when every pending clause is a local calculation. */
export function completeCalculationSequence(primary: ComputedReply, compound: CompoundRequestAnalysis,
  now: Date, lang: Lang, valueOnly: boolean): LocalComputation | null {
  if (compound.forbiddenActions.length || compound.pendingActions.some(action => action.kind !== 'compute')) return null;
  const steps = [primary];
  for (const action of compound.pendingActions) {
    const reference = computationReference(action.text, true);
    const previous = steps.at(-1)!.arithmeticValue;
    if (reference && previous === undefined) return null;
    const resolved = reference ? withReferencedValue(action.text, reference, String(previous)) : action.text;
    const text = calculatorForm(resolved) ?? resolved;
    const frame = buildFrame(text);
    const step = frame.intent === 'compute' && !frame.missing.length ? compute(frame, now, { originalText: text }) : null;
    if (!step || (step.status !== 'completed' && step.status !== 'blocked')) return null;
    steps.push(step);
  }

  const last = steps.at(-1)!;
  const completed = steps.filter(step => step.status === 'completed').length;
  const status = completed === steps.length ? 'completed' : completed ? 'partial' : 'blocked';
  const finalValue = status === 'completed' && valueOnly ? last.evidence.find(item => item.id === 'calculation')?.value : undefined;
  const evidence: Evidence[] = [];
  const claims: Claim[] = [];
  for (const [index, step] of steps.entries()) {
    const evidenceId = (id: string) => step === last ? id : `${id}-${index + 1}`;
    evidence.push(...step.evidence.map(item => ({ ...item, id: evidenceId(item.id) })));
    if (finalValue === undefined) claims.push(...step.claims.map(claim => ({ ...claim, support: claim.support.map(evidenceId) })));
  }
  if (finalValue !== undefined) claims.push({ text: finalValue, support: ['calculation'], status: 'confirmed' });
  return { status, lang, claims, evidence, text: claims.map(claim => claim.text).join('\n') };
}
