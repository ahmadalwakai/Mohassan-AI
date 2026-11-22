/**
 * Phase 2 P4: the same knowledge question asked again, in new conversations, within the page cache's lifetime.
 *
 * Usage: npx tsx scripts/perf/repeat-question.ts [--repeats 4] [--out artifacts/perf/2026-11-22/repeat-question]
 *
 * Against the disposable isolated server (scripts/perf/fixture.ts, API only). For each question the first run
 * fetches its evidence over HTTP; later runs may read the same pages from the in-process page cache. Reported per
 * question: server time of the first run and of each repeat, and the steps the server logged.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FixtureClient, observeRun, startMeasureFixture, stats } from './fixture.js';

const argument = (name: string, fallback: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback; };
const repeats = Number(argument('repeats', '4'));
const out = path.resolve(argument('out', path.join('artifacts', 'perf', '2026-11-22', 'repeat-question')));
await mkdir(out, { recursive: true });
const QUESTIONS = ['ما هو الذكاء الاصطناعي؟', 'ما عاصمة اليابان؟', 'What is the speed of light?', 'كم سعر الذهب اليوم؟'];

const fixture = await startMeasureFixture({ withWeb: false, apiPort: 4120, webPort: 3120 });
const client = new FixtureClient(fixture);
const rows: Record<string, unknown>[] = [];
try {
  await client.signIn();
  await observeRun(client, { text: 'احسب 2 + 2' }, { pollMs: 300, timeoutMs: 60_000 });
  for (const text of QUESTIONS) {
    for (let round = 0; round < repeats; round++) {
      await delay(3300);
      const run = await observeRun(client, { text }, { pollMs: 200, timeoutMs: 120_000 });
      rows.push({ text, round, status: run.status, serverMs: run.serverMs, settleMs: run.settleMs, browser: run.browserVisibleMs !== null,
        steps: run.steps.map(step => ({ atMs: step.atMs, text: step.text.slice(0, 90) })), answer: (run.answer ?? run.error ?? '').slice(0, 160) });
      console.log(`${text.slice(0, 34).padEnd(36)} #${round} ${String(run.serverMs ?? '-').padStart(6)} ms  ${run.steps.map(step => step.text.slice(0, 40)).join(' | ')}`);
    }
  }
} finally {
  await fixture.stop().catch(() => {});
}
const summary = QUESTIONS.map(text => {
  const mine = rows.filter(row => row.text === text);
  return { text, firstMs: mine[0]?.serverMs ?? null, repeatsMs: stats(mine.slice(1).map(row => row.serverMs as number | null)), browserAny: mine.some(row => row.browser),
    sameAnswer: new Set(mine.map(row => row.answer)).size === 1 };
});
await writeFile(path.join(out, 'repeat-question.json'), JSON.stringify({ at: new Date().toISOString(), repeats, summary, rows }, null, 2));
console.log(JSON.stringify(summary, null, 1));
process.exit(0);
