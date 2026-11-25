import { monitorV2Targets, type MonitorSpec, type MonitorTrend, type MonitorV2Target } from '@mohassan/contracts';
import { evaluateMonitor, type MonitorEvaluationState, type MonitorObservation, type WatchedBlock } from './evaluation.js';
import { matchMonitorText, phraseIndex } from './page.js';
import { MONITOR_LIMITS, nextMonitorBudgetDay } from './schedule.js';

const maximumSamples = Math.ceil(MONITOR_LIMITS.maxLifetimeMs / MONITOR_LIMITS.maxIntervalMs) + 24 + 1;
// Page-wide candidates need samples from three different hours before an unlabelled variant can confirm.
const independentTextReadMs = 60 * 60_000;
const independentTextSamples = 3;

export interface MonitorV2Evidence {
  index: number;
  before: MonitorObservation;
  after: MonitorObservation;
  absolute: number | null;
  percent: number | null;
}

export interface MonitorV2Notice {
  evidence: MonitorV2Evidence[];
  digest: boolean;
  events: number;
}

interface TrendState {
  history: MonitorObservation[];
  streak: number;
  inside: boolean;
}

interface SourceState {
  evaluation: MonitorEvaluationState;
  confirmed: MonitorObservation | null;
  pending?: MonitorObservation;
  evidence?: MonitorV2Evidence;
  event?: MonitorV2Evidence;
  trend?: TrendState;
  textConfirmation?: TextConfirmation[];
}

interface TextConfirmation {
  key: string;
  normalized: string | null;
  time: number;
  samples: number;
}

interface QueuedNotice extends Omit<MonitorV2Notice, 'digest'> { dueAt: number }

export interface MonitorV2EvaluationState {
  sources: (SourceState | null)[];
  sequenceStart?: MonitorV2Evidence;
  matched: boolean;
  queue: QueuedNotice[];
}

export function monitorV2SourceSpec(spec: MonitorSpec, target: MonitorV2Target): MonitorSpec {
  const { source, read, condition, freshnessMs, target: valueTarget, trend } = target;
  return { ...spec, source, read, condition, v2: { freshnessMs, ...(valueTarget && { target: valueTarget }), ...(trend && { trend }) } };
}

const timestamp = (observation: MonitorObservation) => Date.parse(observation.observedAt);

function evidence(index: number, before: MonitorObservation, after: MonitorObservation): MonitorV2Evidence {
  const delta = typeof before.value === 'number' && typeof after.value === 'number' ? after.value - before.value : NaN;
  const percent = typeof before.value === 'number' && before.value !== 0 ? 100 * (delta / Math.abs(before.value)) : NaN;
  return { index, before, after, absolute: Number.isFinite(delta) ? delta : null, percent: Number.isFinite(percent) ? percent : null };
}

function evaluateTrend(trend: MonitorTrend, prior: TrendState | undefined, after: MonitorObservation, freshnessMs: number) {
  let history = prior?.history ?? [];
  let streak = prior?.streak ?? 0;
  let before: MonitorObservation | undefined;
  if (trend.kind === 'percent-window') {
    const cutoff = timestamp(after) - trend.windowMs;
    history = history.filter(sample => timestamp(sample) >= cutoff);
    before = history.find(sample => {
      if (typeof sample.value !== 'number' || !sample.value || typeof after.value !== 'number') return false;
      const delta = 100 * ((after.value - sample.value) / Math.abs(sample.value));
      return (trend.direction === 'rise' ? delta : -delta) >= trend.percent;
    });
  } else {
    const previous = history.at(-1);
    const relative = previous && typeof previous.value === 'number' && typeof after.value === 'number'
      && timestamp(after) - timestamp(previous) <= freshnessMs
      && (trend.direction === 'rise' ? after.value > previous.value : after.value < previous.value);
    streak = relative ? streak + 1 : 0;
    before = streak >= trend.checks ? history.at(-trend.checks) : undefined;
    history = history.slice(-trend.checks);
  }
  const inside = before !== undefined;
  return { state: { history: [...history, after].slice(-maximumSamples), streak, inside }, before: prior?.inside ? undefined : before };
}

function independentTextChange(prior: SourceState, sample: MonitorObservation, index: number) {
  const current = new Map(sample.blocks?.map(block => [block.key, block.text]));
  const stable = new Map(prior.confirmed?.blocks?.map(block => [block.key, block.text]));
  const pending = new Map(prior.textConfirmation?.map(item => [item.key, item]));
  const textConfirmation: TextConfirmation[] = [];
  const blocks: WatchedBlock[] = [];
  let edit: { before?: string; after?: string } | undefined;
  const time = timestamp(sample);
  for (const key of new Set([...current.keys(), ...stable.keys()])) {
    const before = stable.get(key);
    const after = current.get(key);
    const normalized = after === undefined ? null : matchMonitorText(after);
    if (normalized === (before === undefined ? null : matchMonitorText(before))) {
      if (after !== undefined) blocks.push({ key, text: after });
      continue;
    }
    const earlier = pending.get(key);
    const next = earlier?.normalized !== normalized ? { key, normalized, time, samples: 1 }
      : time >= earlier.time + independentTextReadMs ? { ...earlier, time, samples: earlier.samples + 1 } : earlier;
    if (next.samples < independentTextSamples) {
      textConfirmation.push(next);
      if (before !== undefined) blocks.push({ key, text: before });
    } else {
      edit ??= { before, after };
      if (after !== undefined) blocks.push({ key, text: after });
    }
  }
  const confirmed = { ...sample, blocks,
    value: blocks.map(block => block.text).join(' ').slice(0, 320), excerpt: edit?.after?.slice(0, 320) ?? prior.confirmed!.excerpt };
  const hit = edit && evidence(index,
    { ...prior.confirmed!, value: edit.before ?? '', excerpt: edit.before?.slice(0, 320) ?? '' },
    { ...confirmed, value: edit.after ?? '', excerpt: edit.after?.slice(0, 320) ?? sample.excerpt });
  return { source: { evaluation: { ...prior.evaluation, blocks: undefined, firstCheck: false, observation: sample },
    confirmed, textConfirmation, event: hit ?? prior.event, evidence: hit ?? prior.evidence }, changed: Boolean(hit), hit };
}

function addSample(target: MonitorV2Target, index: number, prior: SourceState | null, sample: MonitorObservation) {
  const priorObservation = prior?.pending ?? prior?.evaluation.observation;
  if (priorObservation && timestamp(sample) <= timestamp(priorObservation)) return { source: prior!, changed: false };
  if (prior?.confirmed?.blocks && sample.blocks && target.condition.kind === 'change' && target.read.kind === 'main'
    && target.source.kind === 'page' && !target.source.anchor) return independentTextChange(prior, sample, index);
  // For full page text predicates, wait for the independently observed text to repeat.
  if (prior?.confirmed && sample.blocks && (target.condition.kind === 'equals' || target.condition.kind === 'contains')) {
    const sameText = (other: MonitorObservation) => matchMonitorText(String(sample.value)) === matchMonitorText(String(other.value));
    if (!sameText(prior.confirmed) && (!prior.pending || !sameText(prior.pending))) {
      return { source: { ...prior, pending: sample }, changed: false };
    }
  }
  const result = evaluateMonitor(target, prior?.evaluation, sample);
  const trend = target.trend && evaluateTrend(target.trend, prior?.trend, sample, target.freshnessMs);
  const hit = trend ? trend.before && evidence(index, trend.before, sample)
    : prior && result.trigger ? evidence(index, prior.confirmed ?? prior.evaluation.observation, result.trigger) : undefined;
  const awaitingStableBlocks = Boolean(prior?.confirmed && sample.blocks && target.condition.kind === 'change' && !hit);
  const confirmed = awaitingStableBlocks ? { ...prior!.confirmed!, observedAt: sample.observedAt } : sample;
  const readingChanged = Boolean(prior?.confirmed && result.changed && !awaitingStableBlocks);
  const latest = readingChanged || !prior?.evidence
    ? evidence(index, prior?.confirmed ?? prior?.evaluation.observation ?? sample, confirmed)
    : { ...prior.evidence, after: confirmed };
  return {
    source: { evaluation: result.state, confirmed, evidence: latest,
      ...(trend && { trend: trend.state }), ...(hit ?? prior?.event ? { event: hit ?? prior?.event } : {}) },
    changed: readingChanged, hit,
  };
}

function ageIsFresh(observation: MonitorObservation, now: number, freshnessMs: number) {
  const age = now - timestamp(observation);
  return age >= 0 && age <= freshnessMs;
}

function matchedEvidence(target: MonitorV2Target, source: SourceState | null, now: number): MonitorV2Evidence | undefined {
  const sample = source?.confirmed;
  if (!sample || !ageIsFresh(sample, now, target.freshnessMs)) return;
  const condition = target.condition;
  if (!target.trend) {
    if (condition.kind === 'threshold') {
      return typeof sample.value === 'number' && (condition.direction === 'above' ? sample.value > condition.value : sample.value < condition.value)
        ? source.evidence : undefined;
    }
    if (condition.kind === 'contains' || condition.kind === 'equals') {
      const value = matchMonitorText(String(sample.value));
      const expected = matchMonitorText(condition.value);
      return (condition.kind === 'equals' ? value === expected : phraseIndex(value, expected) >= 0) ? source.evidence : undefined;
    }
  }
  return source.event && ageIsFresh(source.event.after, now, target.freshnessMs) ? source.event : undefined;
}

function appendEvidence(prior: readonly MonitorV2Evidence[], current: readonly MonitorV2Evidence[]) {
  const samples = new Map(prior.map(item => [item.index, item]));
  for (const item of current) {
    const earlier = samples.get(item.index);
    if (earlier) {
      const excerpt = [...new Set([earlier.after.excerpt, item.after.excerpt])].join(' · ').slice(-320);
      samples.set(item.index, evidence(item.index, earlier.before, { ...item.after, excerpt }));
    } else samples.set(item.index, item);
  }
  return [...samples.values()];
}

export function evaluateMonitorV2(
  spec: MonitorSpec,
  previous: MonitorV2EvaluationState | undefined,
  samples: readonly { index: number; observation: MonitorObservation; revalidated?: boolean }[],
  at: Date,
  { canDeliver = true, invalidated = [] }: { canDeliver?: boolean; invalidated?: readonly number[] } = {},
) {
  const now = at.getTime();
  const targets = monitorV2Targets(spec);
  const sources = targets.map((_target, index) => {
    const prior = previous?.sources[index];
    return prior && invalidated.includes(index) ? { ...prior, confirmed: null, event: undefined, pending: undefined, textConfirmation: undefined } : prior ?? null;
  });
  const changedTargets: number[] = [];
  const hits = new Map<number, MonitorV2Evidence>();
  let checked = false;
  for (const { index, observation: read, revalidated } of samples) {
    const observation = revalidated ? { ...read, observedAt: at.toISOString() } : read;
    const target = targets[index];
    if (!target || invalidated.includes(index) || !ageIsFresh(observation, now, target.freshnessMs)) continue;
    const result = addSample(target, index, sources[index], observation);
    sources[index] = result.source;
    checked = true;
    if (result.changed) changedTargets.push(index);
    if (result.hit) hits.set(index, result.hit);
  }

  const combine = spec.v2?.combine;
  let sequenceStart = previous?.sequenceStart;
  let matched = false;
  let triggered: MonitorV2Evidence[] = [];
  if (combine?.kind === 'sequence') {
    if (sequenceStart && (invalidated.includes(0) || !ageIsFresh(sequenceStart.after, now, Math.min(combine.windowMs, targets[0].freshnessMs)))) {
      sequenceStart = undefined;
    }
    const finish = hits.get(1);
    // Require A to have been observed in an earlier evaluation. A shared scrape cannot establish order.
    if (sequenceStart && finish && timestamp(finish.after) > timestamp(sequenceStart.after)) {
      triggered = [sequenceStart, finish];
      sequenceStart = undefined;
    }
    sequenceStart = hits.get(0) ?? sequenceStart;
  } else if (combine) {
    const available = targets.flatMap((target, index) => matchedEvidence(target, sources[index], now) ?? []);
    matched = combine.kind === 'and' ? available.length === targets.length : available.length > 0;
    if (matched && checked && previous && (!previous.matched || available.some(item => hits.has(item.index)))) {
      triggered = available.map(item => hits.get(item.index) ?? item);
    }
  } else {
    const hit = hits.get(0);
    if (hit) triggered = [hit];
  }

  const delivery = spec.v2?.delivery ?? 'once';
  let queue = previous?.queue ?? [];
  if (triggered.length && !(delivery === 'once' && queue.length)) {
    const dueAt = delivery === 'daily' ? nextMonitorBudgetDay(at).getTime() : now;
    const pending = queue.at(-1);
    queue = pending?.dueAt === dueAt
      ? [...queue.slice(0, -1), { dueAt, events: pending.events + 1, evidence: appendEvidence(pending.evidence, triggered) }]
      : [...queue, { dueAt, events: 1, evidence: triggered }];
  }
  const due = canDeliver ? queue.filter(item => item.dueAt <= now) : [];
  const notice: MonitorV2Notice | undefined = due.length ? {
    digest: delivery === 'daily', events: due.reduce((count, item) => count + item.events, 0),
    evidence: due.reduce<MonitorV2Evidence[]>((all, item) => appendEvidence(all, item.evidence), []),
  } : undefined;
  const state: MonitorV2EvaluationState = { sources, sequenceStart, matched,
    queue: notice ? queue.filter(item => item.dueAt > now) : queue };
  const independentTimes = sources.flatMap(source => source?.textConfirmation?.map(item => item.time + independentTextReadMs) ?? []);
  const confirmNoEarlierThan = independentTimes.length ? Math.min(...independentTimes) : undefined;
  const needsConfirmation = Boolean(confirmNoEarlierThan) || sources.some(source =>
    source?.pending || source?.evaluation.blocks?.some(block => !block.volatile && block.pending !== undefined));
  return { state, changed: changedTargets.length > 0, changedTargets, needsConfirmation, confirmNoEarlierThan, ...(notice && { notice }) };
}

export function monitorV2DigestDueAt(spec: MonitorSpec, state: MonitorV2EvaluationState | undefined): Date | undefined {
  const dueAt = state?.queue[0]?.dueAt;
  return spec.v2?.delivery === 'daily' && dueAt !== undefined ? new Date(dueAt) : undefined;
}
