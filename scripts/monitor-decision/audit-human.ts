import { createInterface } from 'node:readline';
import { detectMonitorNeed } from '../../apps/server/src/monitors/detection.js';
import { buildMonitorContextFrame } from '../../apps/server/src/monitors/decision/frame.js';
import { reasonMonitorContext } from '../../apps/server/src/monitors/decision/reasoner.js';

type Row = {
  dataset: string;
  family: string;
  intent: string;
  source_id: string;
  text: string;
};

type Counts = {
  cases: number;
  detectorMonitor: number;
  reasonerMonitor: number;
  reasonerReminder: number;
};

const newCounts = (): Counts => ({ cases: 0, detectorMonitor: 0, reasonerMonitor: 0, reasonerReminder: 0 });
const clockFamilies = new Set(['alarm', 'timer', 'calendar']);
const decide = (text: string) => reasonMonitorContext(buildMonitorContextFrame({ text })).decision;
const isMonitor = (decision: ReturnType<typeof decide>) => decision !== 'none' && decision !== 'reminder';
const rows: Row[] = [];
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  rows.push(JSON.parse(line) as Row);
}
if (!rows.length) throw new Error('No guarded human corpus rows received.');

const warmupCount = Math.min(256, rows.length);
for (let index = 0; index < warmupCount; index++) {
  const { text } = rows[Math.floor(index * rows.length / warmupCount)];
  detectMonitorNeed({ text });
  decide(text);
}

const datasets: Record<string, { total: Counts; families: Record<string, Counts> }> = {};
const anomalies = [];
const timings: number[] = [];
let clockCases = 0;
let clockMonitorViolations = 0;
for (const { dataset, family, intent, source_id, text } of rows) {
  const detector = detectMonitorNeed({ text });
  const start = performance.now();
  const reasoner = decide(text);
  timings.push(performance.now() - start);

  const groups = datasets[dataset] ??= { total: newCounts(), families: {} };
  const monitor = isMonitor(reasoner);
  for (const counts of [groups.total, groups.families[family] ??= newCounts()]) {
    counts.cases++;
    if (detector) counts.detectorMonitor++;
    if (monitor) counts.reasonerMonitor++;
    if (reasoner === 'reminder') counts.reasonerReminder++;
  }
  if (clockFamilies.has(family)) {
    clockCases++;
    if (monitor) clockMonitorViolations++;
  }
  if (detector || monitor) anomalies.push({ dataset, family, intent, sourceId: source_id, detector: detector?.kind ?? null, reasoner });
}

timings.sort((left, right) => left - right);
const percentile = (fraction: number) => timings[Math.ceil(timings.length * fraction) - 1];
console.log(JSON.stringify({
  datasets,
  anomalies,
  clockCases,
  clockMonitorViolations,
  reasonerPerTurnMs: { p50: percentile(0.5), p95: percentile(0.95), samples: timings.length, warmupCount },
}));
