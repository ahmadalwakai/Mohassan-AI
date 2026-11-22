/**
 * Live line phases (owner request 2026-11-22): which progress texts a request shows while it runs, and when.
 *
 * Usage: npx tsx scripts/perf/progress-phases.ts [--label before|after] [--poll 200] [--items c1,k1,k4,k5,k2,b3,n1] [--mind] [--web] [--hold]
 *
 * One run per item against the disposable isolated server of scripts/perf/fixture.ts (empty embedded
 * database, no chat model, Windows control off; web items use the real public web as in the lab). Per run:
 *   progress   every distinct progress text with the ms a poll first saw it (poll interval = granularity)
 *   steps      server step events (chat_events kind=step) relative to the user message
 *   silence    the longest stretch with one unchanged text (between changes, or from the last change to settle)
 * --mind runs the same items with MOHASSAN_MIND=1: the mind answers first and the browser is its fallback.
 * --web also starts the Next dev server of the fixture; --hold then keeps the fixture up after the runs, for a
 * look at the live line in a browser, until the file `stop` appears in the output folder.
 */
import { existsSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FixtureClient, observeRun, startMeasureFixture, type RunObservation } from './fixture.js';

const ITEMS: Record<string, string> = {
  c1: 'كم 15 ضرب 23؟',
  k1: 'ما عاصمة اليابان؟',
  k2: 'who wrote the novel One Hundred Years of Solitude',
  k4: 'What is the speed of light?',
  k5: 'من هو الخوارزمي؟',
  b3: 'search for python dataclasses on docs.python.org then open the first result',
  n1: 'لخّص لي أهم أخبار اليوم',
};
function argument(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
}
const label = argument('label', 'run');
const pollMs = Number(argument('poll', '200'));
const keys = argument('items', 'c1,k1,k4,k5,k2,b3,n1').split(',').map(key => key.trim()).filter(key => ITEMS[key]);
const mind = process.argv.includes('--mind');
const web = process.argv.includes('--web');
const hold = process.argv.includes('--hold');
const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19);
const out = path.resolve(argument('out', path.join('artifacts', 'perf', '2026-11-22', `progress-phases-${label}${mind ? '-mind' : ''}-${stamp}`)));
await mkdir(out, { recursive: true });

type Row = RunObservation & { key: string; text: string; silence: { ms: number; text: string | null } };
/** The longest time the owner looked at one unchanged text. */
function silence(run: RunObservation): Row['silence'] {
  const marks = run.progress.map(entry => entry.firstSeenMs);
  const end = run.settleMs ?? marks.at(-1) ?? 0;
  let best: Row['silence'] = { ms: 0, text: null };
  for (const [index, entry] of run.progress.entries()) {
    const ms = (index + 1 < marks.length ? marks[index + 1]! : end) - marks[index]!;
    if (ms > best.ms) best = { ms, text: entry.text };
  }
  return best;
}
const cell = (text: string) => text.replaceAll('|', '∣').replaceAll('\n', ' ');

const fixture = await startMeasureFixture({ withWeb: web, environment: mind ? { MOHASSAN_LOCAL_LAB: '1', MOHASSAN_MIND: '1' } : undefined });
const client = new FixtureClient(fixture);
const rows: Row[] = [];
try {
  await client.signIn();
  // Warm the API and its first database pages; this run is not measured.
  await observeRun(client, { text: 'احسب 2 + 2' }, { pollMs, timeoutMs: 60_000 });
  let lastCreate = 0;
  for (const key of keys) {
    // POST /api/chat/conversations allows 20 a minute; spacing creates keeps every request inside it.
    const wait = lastCreate + 3200 - Date.now();
    if (wait > 0) await delay(wait);
    lastCreate = Date.now();
    const run = await observeRun(client, { text: ITEMS[key]! }, { pollMs, timeoutMs: 150_000 });
    const row: Row = { key, text: ITEMS[key]!, ...run, silence: silence(run) };
    rows.push(row);
    await appendFile(path.join(out, 'runs.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
    console.log(`${key} - ${run.status} - settle ${run.settleMs} ms - ${run.progress.length} texts - longest silence ${row.silence.ms} ms on: ${row.silence.text}`);
  }
  const lines = [
    `# Live line phases - ${label}${mind ? ' - mind' : ''} - ${stamp}`, '',
    `poll ${pollMs} ms - chat model none - database embedded, disposable - Windows control off - ${rows.length} runs`, '',
    '| item | status | settle ms | texts | longest silence ms | the silent text | texts in order (first seen ms) |', '|---|---|---|---|---|---|---|',
    ...rows.map(row => `| ${row.key} | ${row.status} | ${row.settleMs ?? '-'} | ${row.progress.length} | ${row.silence.ms} | ${cell(row.silence.text ?? '-')} | ${cell(row.progress.map(entry => `${entry.text} @${entry.firstSeenMs}`).join(' -> '))} |`),
    '', '## Server steps', ...rows.map(row => `- ${row.key}: ${cell(row.steps.map(step => `${step.text} @${Math.round(step.atMs)}`).join(' -> ')) || '-'}`),
  ];
  await writeFile(path.join(out, 'summary.md'), `${lines.join('\n')}\n`, 'utf8');
  console.log(`written ${out}`);
  if (hold) {
    const stopFile = path.join(out, 'stop');
    console.log(`HOLD web=${fixture.webBase} api=${fixture.apiBase} stop=${stopFile}`);
    while (!existsSync(stopFile)) await delay(1000);
  }
} finally { await fixture.stop(); }
