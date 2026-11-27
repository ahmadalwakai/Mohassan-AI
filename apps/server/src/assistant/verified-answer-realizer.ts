import { realize, type AnswerFrame, type LocalizedText, type Noun, type Value } from '../../../../packages/realizer/src/index.js';
import { observeChatLocalAnswer } from './chat-supervision.js';
import type { LocalComputation } from './local-computation.js';
import type { ComputationKind } from './mind/computation-consumption.js';
import { REASONING_VALUE_ID } from './reasoning/result.js';
import type { TaskSupervisorState } from './task-supervisor.js';

type Calculation = Extract<AnswerFrame, { intent: 'calculation' }>;
type Relation = NonNullable<Calculation['relation']>;

const relations: Partial<Record<ComputationKind, Relation>> = {
  arithmetic: 'equals', conversion: 'conversion', date_range: 'interval',
  date_shift: 'equals', weekday: 'weekday', date_distance: 'interval',
};

// Unicode CLDR 48, long duration-day and duration-week unit patterns, retrieved 2026-11-27.
// https://raw.githubusercontent.com/unicode-org/cldr-json/48.0.0/cldr-json/cldr-units-full/main/ar/units.json
// https://raw.githubusercontent.com/unicode-org/cldr-json/48.0.0/cldr-json/cldr-units-full/main/en/units.json
const day = {
  ar: { gender: 'masculine', singular: 'يوم', plural: 'أيام', accusativeSingular: 'يومًا' },
  en: { singular: 'day', plural: 'days' },
} satisfies Noun;
const week = {
  ar: { gender: 'masculine', singular: 'أسبوع', plural: 'أسابيع', accusativeSingular: 'أسبوعًا' },
  en: { singular: 'week', plural: 'weeks' },
} satisfies Noun;
const intervalUnits = new Map<string, Noun>([
  [day.ar.singular, day], [day.en.plural, day], [week.ar.singular, week], [week.en.plural, week],
]);

function localized(text: string): LocalizedText {
  return { ar: text, en: text };
}

/** Render only an admitted calculation's exact display facts. The reply may already have been scrubbed. */
export function realizeVerifiedComputation(computation: LocalComputation, reply: string, conversationSeed: string): string {
  if (process.env.MOHASSAN_ANSWER_REALIZER !== '1' || computation.status !== 'completed'
    || computation.compound || computation.text !== reply) return reply;

  const [claim] = computation.claims;
  if (computation.claims.length !== 1 || claim?.status !== 'confirmed' || claim.text !== reply) return reply;

  const [proof, source] = computation.evidence;
  if (!proof?.value || proof.source !== 'computed' || proof.quote !== reply || claim.support[0] !== proof.id) return reply;

  const consumption = computation.consumption;
  const relation = consumption?.complete && !consumption.consumed.some(span => span.role === 'output_format')
    ? relations[consumption.kind] : undefined;
  // The calculator's canonical single-equation proof has no sources or extra work to move.
  const native = relation && proof.id === 'calculation' && computation.evidence.length === 1 && claim.support.length === 1;
  const newline = reply.indexOf('\n');
  const appendix = newline < 0 ? '' : reply.slice(newline);
  // Currency reasoning publishes an expressly approximate equation plus its dated snapshot attribution.
  const snapshot = proof.id === REASONING_VALUE_ID && computation.evidence.length === 2 && claim.support.length === 2
    && source?.id === 'exchange-rate-snapshot' && source.id === claim.support[1] && source.source === 'computed'
    && source.title && source.pageDate && appendix.includes(source.title) && appendix.includes(source.pageDate);
  if (native ? appendix : !snapshot) return reply;

  const line = appendix ? reply.slice(0, newline) : reply;
  const [expression, value, extra] = line.split(snapshot ? ' ≈ ' : ' = ');
  if (!expression || !value || extra !== undefined || expression !== expression.trim() || value !== value.trim()
    || !(value === proof.value || (snapshot || relation === 'interval' || relation === 'conversion') && value.startsWith(`${proof.value} `))) return reply;

  let renderedValue: Value = { kind: 'literal', text: localized(value) };
  if (relation === 'interval') {
    const unit = intervalUnits.get(value.slice(proof.value.length + 1));
    const amount = Number(proof.value);
    if (!unit || !Number.isFinite(amount)) return reply;
    renderedValue = { kind: 'number', amount, unit, display: localized(proof.value) };
  }

  return realize({
    intent: 'calculation', language: computation.lang, conversationSeed,
    relation: snapshot ? 'equals' : relation,
    expression: localized(relation === 'interval' ? expression.replace(/^From /u, 'from ') : expression),
    value: renderedValue,
    ...(snapshot ? { certainty: 'approximate' } : {}),
  }) + appendix;
}

export function observeVerifiedComputation(state: TaskSupervisorState, computation: LocalComputation, reply: string,
  conversationSeed: string, startedAt: number): string {
  const rendered = realizeVerifiedComputation(computation, reply, conversationSeed);
  observeChatLocalAnswer(state, { source: 'computation', ...computation, startedAt }, rendered === reply ? undefined : rendered);
  return rendered;
}
