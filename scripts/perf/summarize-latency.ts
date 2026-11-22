/**
 * Summary of one route-latency run folder (scripts/perf/route-latency.ts output).
 * Usage: npx tsx scripts/perf/summarize-latency.ts <run folder>
 * Writes summary.json next to the raw files. Every number is computed from runs.jsonl, routing.json and resources.jsonl.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import path from 'node:path';
import { stats } from './fixture.js';

const folder = path.resolve(process.argv[2] ?? '');
const lines = async (file: string) => (await readFile(path.join(folder, file), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const rows = await lines('runs.jsonl');
const routing = JSON.parse(await readFile(path.join(folder, 'routing.json'), 'utf8')) as { key: string; rules: string; rulesMs: { p50: number }; b0?: { route: string; p50: number } }[];
const meta = JSON.parse(await readFile(path.join(folder, 'meta.json'), 'utf8'));
const marks = JSON.parse(await readFile(path.join(folder, 'marks.json'), 'utf8')) as { at: string; mark: string }[];
const resources = await lines('resources.jsonl');

const measured = rows.filter(row => row.phase === 'measure' && !row.skipped && !row.failure);
const firstInformative = (row: { progress: { text: string; firstSeenMs: number }[] }) => row.progress.find(entry => entry.text !== 'يفهم طلبك…')?.firstSeenMs ?? null;
/**
 * What the web page would show: it renders the POST reply at once, then polls every POLL_MS = 900
 * (apps/web/components/assistant-app.tsx) while the run is `running`, so a finished run appears on the
 * first poll tick after it finished. Proxy time per poll (measured in meta.proxy) is not added.
 */
const UI_POLL_MS = 900;
type UiRow = { sentAt: number; acceptMs: number; assistantAt: number | null; settleMs: number | null; acceptedStatus: string };
const doneAfterSend = (row: UiRow) => {
  const doneAt = row.assistantAt ?? (row.settleMs === null ? null : row.sentAt + row.settleMs);
  return doneAt === null ? null : doneAt - row.sentAt;
};
/** The page as it was until 2026-11-22: one poll every 900 ms. */
const uiEstimate = (row: UiRow) => {
  if (row.acceptedStatus !== 'running') return row.acceptMs;
  const done = doneAfterSend(row);
  if (done === null) return null;
  return row.acceptMs + UI_POLL_MS * Math.max(1, Math.ceil((done - row.acceptMs) / UI_POLL_MS));
};
/**
 * The page after 2026-11-22 (assistant-app.tsx): polls every FAST_POLL_MS for the first FAST_WINDOW_MS after a
 * send, then every POLL_MS. Both estimates are reported so a run can be compared under either page.
 */
const UI_FAST_POLL_MS = 200, UI_FAST_WINDOW_MS = 3000;
const uiEstimateAdaptive = (row: UiRow) => {
  if (row.acceptedStatus !== 'running') return row.acceptMs;
  const done = doneAfterSend(row);
  if (done === null) return null;
  let at = row.acceptMs;
  for (let guard = 0; at < done && guard < 100_000; guard++) at += at < UI_FAST_WINDOW_MS ? UI_FAST_POLL_MS : UI_POLL_MS;
  return at;
};
const categories = [...new Set(measured.map(row => row.category as string))];
const byCategory = Object.fromEntries(categories.map(category => {
  const mine = measured.filter(row => row.category === category);
  const statuses = mine.reduce<Record<string, number>>((all, row) => ({ ...all, [row.status]: (all[row.status] ?? 0) + 1 }), {});
  return [category, {
    runs: mine.length, statuses,
    acceptMs: stats(mine.map(row => row.acceptMs)), serverMs: stats(mine.map(row => row.serverMs)), settleMs: stats(mine.map(row => row.settleMs)),
    uiEstimateMs: stats(mine.map(uiEstimate)), uiEstimateAdaptiveMs: stats(mine.map(uiEstimateAdaptive)),
    firstInformativeProgressMs: stats(mine.map(firstInformative)),
    browserUsed: mine.filter(row => row.browserVisibleMs !== null).length, browserVisibleMs: stats(mine.map(row => row.browserVisibleMs)),
    // The server's visibility decision: how many runs had a page at level 3 (the panel would open) versus level 2 (background).
    panelWouldOpen: mine.filter(row => typeof row.browserLevel === 'number' && row.browserLevel >= 3).length,
    browserBackground: mine.filter(row => row.browserLevel === 2).length,
    timedOut: mine.filter(row => row.timedOut).length,
  }];
}));

// Step phases on runs that searched: a step's duration is the time until the next step (or the reply).
const label = (text: string) => text.replace(/«[^»]*»/gu, '«…»').replace(/https?:\/\/\S+/gu, '<url>').replace(/\s+/gu, ' ').trim();
const phases = new Map<string, number[]>();
for (const row of measured.concat(rows.filter(row => row.phase === 'cold-browser'))) {
  const steps = (row.steps as { text: string; atMs: number }[]).filter(step => Number.isFinite(step.atMs));
  steps.forEach((step, index) => {
    const end = index + 1 < steps.length ? steps[index + 1]!.atMs : row.serverMs;
    if (typeof end !== 'number') return;
    const name = label(step.text);
    phases.set(name, [...(phases.get(name) ?? []), end - step.atMs]);
  });
}
const stepPhases = [...phases.entries()].map(([name, values]) => ({ step: name, ...stats(values) })).sort((a, b) => b.n - a.n);

// Resources in the measured window only.
const begin = Date.parse(marks.find(entry => entry.mark === 'rep-1')?.at ?? marks[0]!.at), end = Date.parse(marks.find(entry => entry.mark === 'measure-done')?.at ?? marks.at(-1)!.at);
const window = resources.filter(sample => { const at = Date.parse(sample.at); return at >= begin && at <= end; });
const roleNames = [...new Set(window.flatMap(sample => Object.keys(sample.roles ?? {})))];
const cores = cpus().length;
const roles = Object.fromEntries(roleNames.map(role => {
  const seen = window.filter(sample => sample.roles?.[role]);
  const ws = seen.map(sample => sample.roles[role].workingSetMB as number), priv = seen.map(sample => sample.roles[role].privateMB as number);
  const first = seen[0], last = seen.at(-1);
  const cpuSeconds = first && last ? last.roles[role].cpuSeconds - first.roles[role].cpuSeconds : null;
  const wall = first && last ? (Date.parse(last.at) - Date.parse(first.at)) / 1000 : null;
  return [role, { samples: seen.length, workingSetMB: stats(ws), privateMB: stats(priv), maxCount: Math.max(...seen.map(sample => sample.roles[role].count)),
    meanCpuPercentOfOneCore: cpuSeconds !== null && wall ? Number((100 * cpuSeconds / wall).toFixed(1)) : null,
    meanCpuPercentOfMachine: cpuSeconds !== null && wall ? Number((100 * cpuSeconds / wall / cores).toFixed(2)) : null }];
}));
const system = { freeMB: stats(window.map(sample => sample.system.freeMB)), cpuPercent: stats(window.map(sample => sample.system.cpuPercent)), totalMB: window[0]?.system.totalMB ?? null,
  gpuUsedMiB: stats(window.map(sample => sample.gpu?.usedMiB ?? null)), gpuTemperatureC: stats(window.map(sample => sample.gpu?.temperatureC ?? null)) };

const cold = rows.find(row => row.phase === 'cold-browser');
const warmWeb = measured.filter(row => row.category === 'web_knowledge');
const summary = {
  folder: path.relative(process.cwd(), folder), meta,
  totals: { measuredRuns: measured.length, failures: rows.filter(row => row.failure).length, skipped: rows.filter(row => row.skipped).length,
    firstProgressLineMs: stats(measured.map(row => row.acceptMs)), firstInformativeProgressMs: stats(measured.map(firstInformative)),
    browserUsedShare: Number((measured.filter(row => row.browserVisibleMs !== null).length / Math.max(1, measured.length)).toFixed(3)) },
  coldBrowser: cold ? { text: cold.text, serverMs: cold.serverMs, settleMs: cold.settleMs, browserVisibleMs: cold.browserVisibleMs, steps: cold.steps } : null,
  warmWebKnowledge: { serverMs: stats(warmWeb.map(row => row.serverMs)), browserVisibleMs: stats(warmWeb.map(row => row.browserVisibleMs)) },
  byCategory, stepPhases,
  routing: { rulesP50Ms: stats(routing.map(entry => entry.rulesMs.p50)), b0P50Ms: stats(routing.map(entry => entry.b0?.p50 ?? null)), perRequest: routing },
  resources: { cores, roles, system, samples: window.length },
};
await writeFile(path.join(folder, 'summary.json'), JSON.stringify(summary, null, 2));
const ms = (value: number | null) => value === null ? '—' : value >= 1000 ? `${(value / 1000).toFixed(1)} ث` : `${Math.round(value)} ms`;
console.log('| المسار | التشغيلات | الخادم p50 | الخادم p95 | الواجهة p50 | الواجهة p95 | المتصفح | الحالات |');
console.log('|---|---|---|---|---|---|---|---|');
for (const [category, value] of Object.entries(byCategory)) console.log(`| ${category} | ${value.runs} | ${ms(value.serverMs.p50)} | ${ms(value.serverMs.p95)} | ${ms(value.uiEstimateMs.p50)} | ${ms(value.uiEstimateMs.p95)} | ${value.browserUsed}/${value.runs} | ${Object.entries(value.statuses).map(([key, count]) => `${key} ${count}`).join('، ')} |`);
console.log(JSON.stringify({ totals: summary.totals, coldBrowser: summary.coldBrowser && { serverMs: summary.coldBrowser.serverMs }, resources: summary.resources.roles }, null, 1));
