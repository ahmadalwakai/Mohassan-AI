/**
 * Phase 3 §7.4: how often a figure answer carries a second source, measured on the frozen real set.
 *
 * Usage: npx tsx scripts/quality/two-sources.ts [--port 4140] [--out artifacts/plan-2026-11-22] [--ids rq020,rq021]
 *
 * Takes the figure questions of real-questions-v1.jsonl (a count, a duration, a price, a version: the
 * same WANTS_NUMBER/LIVE test the hands use) that go to the web, not to arithmetic, memory or a named site,
 * and sends each as a new conversation to the disposable measurement server (scripts/perf/fixture.ts:
 * no model, empty database, Windows control off). For every reply it records whether a second source was
 * shown, whether it agreed or differed, and both quoted lines. Nothing here judges correctness: that is
 * the owner's label.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LIVE } from '../../apps/server/src/assistant/hands.js';
import { FixtureClient, observeRun, startMeasureFixture, type RunObservation } from '../perf/fixture.js';

const argument = (name: string, fallback: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback; };
const out = path.resolve(argument('out', path.join('artifacts', 'plan-2026-11-22')));
await mkdir(out, { recursive: true });
const WANTS_NUMBER = /(?:^|\s)(?:كم|قديش|اديش|متى|متي)(?=\s|$)|\bhow (?:many|much|long|old|far|tall|big)\b|\bwhen\b/iu;
// Arithmetic, memory, sending, opening a named page and pasted error text are not web figure questions.
const NOT_WEB_FIGURE = /احسب|حاصل|ضرب|يساوي|[×x*+]\s*\d|افتح|أرسل|احفظ|cook|لم أتمكن|لخّص|لخص/iu;

interface SetItem { id: string; kind: 'single' | 'pair'; text: string; previous: string | null }
const set = (await readFile(path.join(out, 'real-questions-v1.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as SetItem);
// `--ids rq020,rq021,rq041` measures those questions only, whatever the filters say.
const ids = argument('ids', '').split(',').map(id => id.trim()).filter(Boolean);
const items = ids.length ? set.filter(item => ids.includes(item.id))
  : set.filter(item => item.kind === 'single' && (WANTS_NUMBER.test(item.text) || LIVE.test(item.text)) && !NOT_WEB_FIGURE.test(item.text));
console.log(`${items.length} figure questions of ${set.length}: ${items.map(item => item.id).join(', ')}`);

const SECOND = /\*\*(?:مصدر ثانٍ (يؤكد|يختلف)|A second source (agrees|differs)):\*\*\s*(.*)/u;
function secondSource(answer: string) {
  const match = SECOND.exec(answer);
  if (!match) return null;
  const agrees = match[1] === 'يؤكد' || match[2] === 'agrees';
  return { agrees, text: match[3]?.trim() ?? '' };
}

const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19);
const port = Number(argument('port', '4140'));
const fixture = await startMeasureFixture({ withWeb: false, apiPort: port, webPort: port - 1000 });
const client = new FixtureClient(fixture);
const UNVERIFIED = /لم أتحقق من هذا الرقم في مصدر ثانٍ|did not check this figure against a second source/u;
const rows: { id: string; text: string; status: string; firstLine: string | null; second: { agrees: boolean; text: string } | null; unverified: boolean; sources: string[]; steps: string[]; error: string | null; serverMs: number | null; failure?: string }[] = [];
try {
  await client.signIn();
  let lastCreate = 0;
  for (const item of items) {
    // Wikipedia's API answered 429 to quick successions from this machine on 2026-11-22; questions are spaced out.
    const wait = lastCreate + 8000 - Date.now();
    if (wait > 0) await delay(wait);
    lastCreate = Date.now();
    let observation: RunObservation | null = null, failure: string | undefined;
    try { observation = await observeRun(client, { text: item.text }, { pollMs: 400, timeoutMs: 150_000 }); }
    catch (error) { failure = error instanceof Error ? error.message : String(error); }
    const answer = observation?.answer ?? '';
    rows.push({
      id: item.id, text: item.text, status: observation?.status ?? 'FAILED', firstLine: answer ? answer.split('\n')[0]!.slice(0, 200) : null,
      second: secondSource(answer), unverified: UNVERIFIED.test(answer), sources: [...answer.matchAll(/\]\((https?:\/\/[^)\s]+)\)/gu)].map(match => match[1]!),
      steps: observation?.steps.map(step => step.text) ?? [], error: observation?.error ?? null,
      serverMs: observation?.serverMs ?? null, ...(failure ? { failure } : {}),
    });
    const last = rows.at(-1)!;
    console.log(`${item.id} ${last.status.padEnd(13)} ${String(last.serverMs ?? '-').padStart(6)}ms  second=${last.second ? (last.second.agrees ? 'agrees' : 'differs') : 'none'}  ${item.text.slice(0, 60)}`);
  }
} finally {
  await fixture.stop().catch(() => {});
}
// A settled conversation reads `idle`; a reply that abstained or listed pages has no second source to count.
const answered = rows.filter(row => (row.status === 'idle' || row.status === 'completed') && row.firstLine && row.sources.length > 0 && !/^(?:لم أجد|لم أتمكن|I found no|I could not)/u.test(row.firstLine));
const summary = {
  at: new Date().toISOString(), items: rows.length, completed: answered.length,
  withSecondSource: answered.filter(row => row.second).length,
  agreeing: answered.filter(row => row.second?.agrees).length, differing: answered.filter(row => row.second && !row.second.agrees).length,
  // Plan §7.1: a figure from one page says so («لم أتحقق من هذا الرقم في مصدر ثانٍ»).
  saidUnverified: answered.filter(row => row.unverified).length,
  rows,
};
const file = path.join(out, `two-sources-${stamp}.json`);
await writeFile(file, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, rows: undefined, file: path.relative(process.cwd(), file) }, null, 1));
process.exit(0);
