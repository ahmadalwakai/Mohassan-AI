import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { MONITOR_V2_DEFAULT_FRESHNESS_MS, MonitorSpecSchema } from '@mohassan/contracts';
import type { MonitorSpec } from '@mohassan/contracts';
import type { MonitorObservation } from '../../apps/server/src/monitors/evaluation.js';
import type { MonitorSourceCache } from '../../apps/server/src/monitors/sources.js';
import { classes, createScenario, matchesEvent, minute, parameters, seedCounts, type Scenario, type SeedBank } from './fixtures.js';

const baselineCommit = 'a453dc17a78f55c0cd3e5bf23f347843893bc3d2';
const ownerId = 'simulation-account';
const baselinePath = 'apps/server/src/monitors';
const { values } = parseArgs({ options: { baseline: { type: 'string' }, bank: { type: 'string' }, 'v1-only': { type: 'boolean' }, replication: { type: 'string' } } });
if (!values.baseline || (values.bank !== 'tuning' && values.bank !== 'held-out') || (values['v1-only'] && values.bank !== 'tuning')) {
  throw new Error('Use --baseline <pinned-worktree> --bank tuning|held-out. --v1-only is available for the tuning bank.');
}
const bank: SeedBank = values.bank;
const replication = values.replication;
if (replication !== undefined && (bank !== 'held-out' || !/^[a-f\d]{64}$/u.test(replication))) {
  throw new Error('A held-out replication requires a 256-bit hex salt generated after freezing the candidate.');
}
// Double the initial held-out bank to reduce sampling error in the independent replication.
const trialsPerClass = replication ? 2 * seedCounts['held-out'] : seedCounts[bank];
const baseline = resolve(values.baseline);
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
if (git(baseline, 'rev-parse', 'HEAD') !== baselineCommit || git(baseline, 'status', '--porcelain', '--untracked-files=no')) {
  throw new Error(`The baseline must be a clean checkout at ${baselineCommit}.`);
}
const loadBaseline = (module: string) => import(pathToFileURL(resolve(baseline, baselinePath, `${module}.ts`)).href);
const [baselineSchedule, baselineEvaluation, baselineSources] = await Promise.all([
  loadBaseline('schedule') as Promise<typeof import('../../apps/server/src/monitors/schedule.js')>,
  loadBaseline('evaluation') as Promise<typeof import('../../apps/server/src/monitors/evaluation.js')>,
  loadBaseline('sources') as Promise<typeof import('../../apps/server/src/monitors/sources.js')>,
]);
const v2 = values['v1-only'] ? undefined : await Promise.all([
  import('../../apps/server/src/monitors/schedule-v2.js'), import('../../apps/server/src/monitors/evaluation-v2.js'),
  import('../../apps/server/src/monitors/sources.js'),
]).then(([schedule, evaluation, sources]) => ({ schedule, evaluation, sources }));

interface Delivery { at: number; observation: MonitorObservation }
interface Outcome {
  checks: number;
  deliveries: Delivery[];
  relocated: boolean;
  relocationRecorded: boolean;
  clarifications: number;
  healthPauses: number;
  previewFailures: number;
}

function createSpec(fixture: Scenario, advanced: boolean): MonitorSpec {
  const { source, read, condition, language, deadline } = fixture;
  const timing = baselineSchedule.monitorTiming(source.kind, 'normal', { now: new Date(fixture.start), deadline });
  const v2Spec: MonitorSpec['v2'] = {
    freshnessMs: MONITOR_V2_DEFAULT_FRESHNESS_MS,
    ...(fixture.sourceClass === 'structured-offer' && { target: { property: 'price', currency: 'USD' } }),
    ...(fixture.sourceClass === 'arabic-page' && { target: { currency: 'SAR' } }),
    ...(fixture.sourceClass === 'recurring-feed' && { delivery: 'each' }),
  };
  return MonitorSpecSchema.parse({ source, read, condition, timing, language, title: 'Synthetic monitor',
    message: 'A synthetic source reached its condition.', ...(advanced && { v2: v2Spec }) });
}

async function simulate(fixture: Scenario, advanced: typeof v2): Promise<Outcome> {
  const spec = createSpec(fixture, Boolean(advanced));
  const expiry = new Date(fixture.end);
  let clock = fixture.start;
  const { read } = (advanced?.sources ?? baselineSources).createMonitorReader(fixture.ports(() => clock));
  const slots = new Map<string, number>();
  let hostAdmitted = false;
  const reserveHost = async (host: string, minimum = 0) => {
    const eligibleAt = slots.get(host) ?? -Infinity;
    if (eligibleAt > clock) return eligibleAt;
    slots.set(host, clock + Math.max(minimum, baselineSchedule.MONITOR_LIMITS.hostIntervalMs));
    hostAdmitted = true;
    return null;
  };
  const extendHost = async (host: string, minimum: number) => {
    slots.set(host, Math.max(slots.get(host) ?? 0, clock + minimum));
  };
  let cache: MonitorSourceCache | undefined;
  const readAt = (preview = false) => read(spec, {
    ownerId, reserveHost, extendHost, preview, cache, ...(advanced && { v2: true }),
  });
  const preview = await readAt(true);
  const outcome: Outcome = { checks: 0, deliveries: [], relocated: false, relocationRecorded: false, clarifications: 0, healthPauses: 0, previewFailures: 0 };
  if (preview.kind !== 'value') {
    if (preview.kind === 'clarify') outcome.clarifications++;
    else outcome.previewFailures++;
    return outcome;
  }
  let observation = preview.observation;
  cache = preview.cache;
  let v1Evaluation = baselineEvaluation.evaluateMonitor(spec, undefined, observation).state;
  let v2Evaluation = advanced?.evaluation.evaluateMonitorV2(spec, undefined, [{ index: 0, observation }], new Date(clock), { canDeliver: false }).state;
  let learned = advanced?.schedule.learnMonitorSchedule(undefined, new Date(clock), {
    changed: false, publicationTimes: preview.publicationTimes,
  });
  let next = advanced?.schedule.nextPredictiveMonitorCheck(spec, new Date(clock), { state: learned, expiry, checksUsed: 0 })
    ?? baselineSchedule.initialMonitorCheck(spec, new Date(clock), expiry);
  let failures = 0;
  let active = true;
  const recurring = advanced && fixture.sourceClass === 'recurring-feed';
  while (active && next.dueAt < expiry && outcome.checks < spec.timing.maxChecks) {
    if (next.dueAt.getTime() <= clock) throw new Error('A scheduled check must advance the simulation clock.');
    clock = next.dueAt.getTime();
    outcome.checks++;
    hostAdmitted = false;
    const result = await readAt();
    if (result.kind === 'deferred') {
      outcome.checks -= Number(!hostAdmitted);
      next = { ...next, dueAt: new Date(Math.max(clock + baselineSchedule.MONITOR_LIMITS.pollMs, result.at)) };
      continue;
    }
    if (result.kind === 'clarify' || result.kind === 'unsafe-target') {
      if (result.kind === 'clarify') outcome.clarifications++;
      else outcome.healthPauses++;
      break;
    }
    const at = new Date(clock);
    const failed = result.kind === 'missing' || result.kind === 'unreachable';
    if (failed) {
      failures++;
      if (failures >= baselineSchedule.MONITOR_LIMITS.consecutiveFailures || outcome.checks >= spec.timing.maxChecks) {
        outcome.healthPauses++;
        break;
      }
      next = advanced?.schedule.nextPredictiveMonitorCheck(spec, at, { state: learned, expiry, checksUsed: outcome.checks, failed,
        priorIntervalMs: next.intervalMs })
        ?? baselineSchedule.nextMonitorCheck(spec, at, next.intervalMs, { changed: true, expiry });
      continue;
    }
    failures = 0;
    if (result.kind === 'value') {
      observation = result.observation;
      cache = result.cache;
      if (fixture.layoutChangeAt !== undefined && clock >= fixture.layoutChangeAt && observation.value === fixture.relocationValue(clock)) {
        outcome.relocated = true;
        outcome.relocationRecorded ||= Boolean(result.relocation);
      }
    } else {
      cache = result.cache ?? cache;
    }
    const revalidated = result.kind === 'unchanged';
    let alert: MonitorObservation | undefined;
    if (advanced) {
      const evaluated = advanced.evaluation.evaluateMonitorV2(spec, v2Evaluation, [{ index: 0, observation, revalidated }], at, {
        canDeliver: outcome.deliveries.length < spec.timing.maxNotifications,
      });
      v2Evaluation = evaluated.state;
      alert = evaluated.notice?.evidence[0]?.after;
      if (evaluated.state.sources[0]?.confirmed?.observedAt === (revalidated ? at.toISOString() : observation.observedAt)) {
        learned = advanced.schedule.learnMonitorSchedule(learned, at, { changed: evaluated.changed, publicationTimes: result.publicationTimes });
      }
      next = advanced.schedule.nextPredictiveMonitorCheck(spec, at, { state: learned, expiry, checksUsed: outcome.checks,
        priorIntervalMs: next.intervalMs, changed: evaluated.changed, needsConfirmation: evaluated.needsConfirmation,
        confirmNoEarlierThan: evaluated.confirmNoEarlierThan });
    } else {
      const evaluated = baselineEvaluation.evaluateMonitor(spec, v1Evaluation, observation, { revalidated });
      v1Evaluation = evaluated.state;
      alert = evaluated.trigger;
      next = baselineSchedule.nextMonitorCheck(spec, at, next.intervalMs, { changed: evaluated.changed, expiry });
    }
    if (alert) {
      outcome.deliveries.push({ at: clock, observation: alert });
      active = Boolean(recurring && outcome.deliveries.length < spec.timing.maxNotifications);
    }
  }
  return outcome;
}

function delaySummary(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    meanDelayMinutes: sorted.length ? sorted.reduce((sum, time) => sum + time, 0) / sorted.length : null,
    p95DelayMinutes: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
  };
}

class Scores {
  monitors = 0;
  opportunities = 0;
  trueEvents = 0;
  missedEvents = 0;
  trueAlerts = 0;
  falseAlerts = 0;
  checks = 0;
  moves = 0;
  restored = 0;
  relocationsRecorded = 0;
  clarifications = 0;
  healthPauses = 0;
  previewFailures = 0;
  delays: number[] = [];
  restrictedDelays: number[] = [];

  record(fixture: Scenario, outcome: Outcome) {
    this.monitors++;
    const recurring = fixture.sourceClass === 'recurring-feed';
    const matched = new Map<number, number>();
    for (const alert of outcome.deliveries) {
      const matches = fixture.truth.flatMap((event, index) => !matched.has(index) && matchesEvent(event, alert.at, alert.observation) ? [index] : []);
      if (!matches.length) {
        this.falseAlerts++;
        continue;
      }
      this.trueAlerts++;
      for (const index of matches) {
        const delay = (alert.at - fixture.truth[index].at) / minute;
        matched.set(index, delay);
        this.delays.push(delay);
      }
    }
    // For one-shot watches any genuine occurrence can satisfy the watch. Multiple threshold excursions are not separate alert obligations.
    const opportunities = recurring ? fixture.truth.length : Math.min(1, fixture.truth.length);
    const trueEvents = recurring ? matched.size : Math.min(1, matched.size);
    if (recurring) {
      fixture.truth.forEach((event, index) => this.restrictedDelays.push(matched.get(index) ?? (fixture.end - event.at) / minute));
    } else if (fixture.truth[0]) {
      // For a one-shot monitor, cap time after the first qualifying opportunity at trial end.
      // The cap keeps false or missing alerts from making an arm look faster.
      const first = fixture.truth[0].at;
      const detection = Math.min(fixture.end, ...[...matched].map(([index, delay]) => fixture.truth[index].at + delay * minute));
      this.restrictedDelays.push((detection - first) / minute);
    }
    this.opportunities += opportunities;
    this.trueEvents += trueEvents;
    this.missedEvents += opportunities - trueEvents;
    this.checks += outcome.checks;
    this.moves += Number(fixture.layoutChangeAt !== undefined);
    this.restored += Number(outcome.relocated);
    this.relocationsRecorded += Number(outcome.relocationRecorded);
    this.clarifications += outcome.clarifications;
    this.healthPauses += outcome.healthPauses;
    this.previewFailures += outcome.previewFailures;
    return matched;
  }

  summary() {
    const ratio = (count: number, total: number) => total ? count / total : null;
    return {
      monitors: this.monitors, opportunities: this.opportunities, trueEvents: this.trueEvents, missedEvents: this.missedEvents,
      trueAlerts: this.trueAlerts, falseAlerts: this.falseAlerts,
      precision: ratio(this.trueAlerts, this.trueAlerts + this.falseAlerts), recall: ratio(this.trueEvents, this.opportunities),
      falseAlarmsPerMonitorWeek: ratio(this.falseAlerts, this.monitors),
      ...delaySummary(this.delays), restrictedDelay: delaySummary(this.restrictedDelays),
      checks: this.checks, checksPerMonitorWeek: ratio(this.checks, this.monitors),
      layoutChanges: this.moves, restored: this.restored, relocationSuccess: ratio(this.restored, this.moves),
      relocationsRecorded: this.relocationsRecorded, clarifications: this.clarifications,
      healthPauses: this.healthPauses, previewFailures: this.previewFailures,
    };
  }
}

type PairedDelays = { v1: number[]; v2: number[] };
const pairedSummary = ({ v1, v2 }: PairedDelays) => ({ matchingEvents: v1.length, v1: delaySummary(v1), v2: delaySummary(v2) });
const totals = { v1: new Scores(), v2: new Scores() };
const sharedPaired: PairedDelays = { v1: [], v2: [] };
const comparison = [];
for (const sourceClass of classes) {
  const first = new Scores();
  const second = new Scores();
  const paired: PairedDelays = { v1: [], v2: [] };
  const recurring = sourceClass === 'recurring-feed';
  for (let trial = 0; trial < trialsPerClass; trial++) {
    const fixture = createScenario(bank, trial, sourceClass, replication);
    const old = await simulate(fixture, undefined);
    const oldDelays = first.record(fixture, old);
    if (!recurring) totals.v1.record(fixture, old);
    if (v2) {
      const current = await simulate(fixture, v2);
      const currentDelays = second.record(fixture, current);
      if (!recurring) totals.v2.record(fixture, current);
      for (const [event, oldDelay] of oldDelays) {
        const currentDelay = currentDelays.get(event);
        if (currentDelay === undefined) continue;
        paired.v1.push(oldDelay);
        paired.v2.push(currentDelay);
        if (!recurring) {
          sharedPaired.v1.push(oldDelay);
          sharedPaired.v2.push(currentDelay);
        }
      }
    }
  }
  comparison.push({ sourceClass, v1: first.summary(), ...(v2 && { v2: second.summary(), paired: pairedSummary(paired) }) });
}
const paired = pairedSummary(sharedPaired);
const shared = { v1: totals.v1.summary(), ...(v2 && { v2: totals.v2.summary(), paired }) };
const gates = v2 && {
  noRecallLossByClass: comparison.every(row => row.v2!.trueEvents >= row.v1.trueEvents),
  lowerPairedMeanDelay: paired.v2.meanDelayMinutes !== null && paired.v1.meanDelayMinutes !== null && paired.v2.meanDelayMinutes < paired.v1.meanDelayMinutes,
  lowerPairedP95Delay: paired.v2.p95DelayMinutes !== null && paired.v1.p95DelayMinutes !== null && paired.v2.p95DelayMinutes < paired.v1.p95DelayMinutes,
  equalOrFewerChecks: shared.v2!.checks <= shared.v1.checks,
};
console.log(JSON.stringify({ baseline: baselineCommit, head: git(process.cwd(), 'rev-parse', 'HEAD'), bank, ...(replication && { replication }), seeds: trialsPerClass, parameters,
  comparison, sharedOneShot: shared, ...(gates && { gates }) }, null, 2));
if (bank === 'held-out' && gates && Object.values(gates).some(passed => !passed)) process.exitCode = 1;
