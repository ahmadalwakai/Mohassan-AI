/**
 * Phase 0: the frozen set of real requests and today's replies to them, for the owner to label
 * (docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md §1.6, §7.5, §8.3, §9).
 *
 * Usage: npx tsx scripts/quality/real-questions.ts [--freeze-only] [--limit N] [--out artifacts/plan-2026-11-22] [--judge off]
 *
 * `--judge off` measures the hands alone: the pre-send judge (apps/server/src/assistant/judge.ts, wired 2026-11-22 07:56)
 * otherwise fixes and withholds replies on the owner account, which is the account this tool signs in with. The 02:17
 * baseline of 2026-11-22 predates the judge, so a hands-only comparison with it needs this switch.
 *
 * Set: every distinct first-turn request in .data/router/shadow.jsonl, real-labeled.jsonl and
 * lab-messages.jsonl, plus follow-up pairs (the previous request, then the follow-up) where the
 * follow-up was not an answer to an open question card. The first run writes
 * real-questions-v1.jsonl with its sha256; later runs reuse that file unchanged (frozen).
 *
 * Replies come from the disposable measurement server (scripts/perf/fixture.ts): no model, empty
 * database, Windows control off. Each item is a new conversation; a pair sends both turns in one.
 * Labels are left empty for the owner: label = correct | partial | wrong_shown | abstain_right | abstain_wrong,
 * plus expected answer and, when the reply was a question, whether that question was needed.
 * The auto fields are mechanical facts about the reply text, not judgements of correctness.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FixtureClient, observeRun, startMeasureFixture, stats, type RunObservation } from '../perf/fixture.js';

const argument = (name: string, fallback: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback; };
const out = path.resolve(argument('out', path.join('artifacts', 'plan-2026-11-22')));
const limit = Number(argument('limit', '0'));
await mkdir(out, { recursive: true });
const setFile = path.join(out, 'real-questions-v1.jsonl');

interface SetItem { id: string; kind: 'single' | 'pair'; text: string; previous: string | null; sources: string[]; firstSeen: string | null }
const normal = (text: string) => text.normalize('NFC').replace(/\s+/gu, ' ').trim();
const key = (text: string) => normal(text).toLowerCase();

async function buildSet(): Promise<SetItem[]> {
  const files: [string, string][] = [['.data/router/shadow.jsonl', 'shadow'], ['.data/router/real-labeled.jsonl', 'production'], ['.data/router/lab-messages.jsonl', 'lab']];
  const singles = new Map<string, SetItem>(), pairs = new Map<string, SetItem>();
  for (const [file, source] of files) {
    for (const line of (await readFile(file, 'utf8')).split('\n').filter(Boolean)) {
      const row = JSON.parse(line) as { text: string; previous: string | null; route?: string; pendingQuestion?: boolean; at?: string };
      if (!row.text?.trim() || row.route === 'reply' || row.pendingQuestion) continue;
      const target = row.previous ? pairs : singles;
      const id = row.previous ? `${key(row.previous)}\u0000${key(row.text)}` : key(row.text);
      const item = target.get(id) ?? { id: '', kind: row.previous ? 'pair' : 'single', text: normal(row.text), previous: row.previous ? normal(row.previous) : null, sources: [], firstSeen: row.at ?? null };
      if (!item.sources.includes(source)) item.sources.push(source);
      if (row.at && (!item.firstSeen || row.at < item.firstSeen)) item.firstSeen = row.at;
      target.set(id, item);
    }
  }
  // A pair whose previous turn was itself a card answer or a repeat of the follow-up carries no context to test.
  const list = [...singles.values(), ...[...pairs.values()].filter(item => item.previous && key(item.previous) !== key(item.text))];
  return list.map((item, index) => ({ ...item, id: `rq${String(index + 1).padStart(3, '0')}` }));
}

let set: SetItem[];
if (existsSync(setFile)) set = (await readFile(setFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
else { set = await buildSet(); await writeFile(setFile, set.map(item => JSON.stringify(item)).join('\n') + '\n'); }
const setSha256 = createHash('sha256').update(await readFile(setFile)).digest('hex');
await writeFile(path.join(out, 'real-questions-v1.sha256'), `${setSha256}  real-questions-v1.jsonl\n`);
console.log(`set: ${set.length} items (${set.filter(item => item.kind === 'single').length} single, ${set.filter(item => item.kind === 'pair').length} pairs), sha256 ${setSha256}`);
if (process.argv.includes('--freeze-only')) process.exit(0);

const ARABIC = /\p{Script=Arabic}/u;
const ABSTAIN = /لم أجد|لم أتمكن|تعذر|لا أستطيع|لا يمكنني|لا مصدر|couldn['’]t|could not|can['’]t|cannot|unable|no (?:live )?source|not able/iu;
function auto(question: string, observation: RunObservation) {
  const answer = observation.answer ?? '';
  const asked = observation.status === 'waiting_user' || observation.status === 'waiting_input';
  return {
    status: observation.status, asked, cardFields: observation.question?.fields ?? 0, cardOptions: observation.question?.options ?? 0,
    secure: observation.secure, usedBrowser: observation.browserVisibleMs !== null, hasLink: /https?:\/\//u.test(answer),
    abstainPhrase: ABSTAIN.test(answer), sameLanguage: answer ? ARABIC.test(question) === ARABIC.test(answer.replace(/https?:\/\/\S+/gu, '')) : null,
    answerChars: answer.length,
  };
}

const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19);
const answersFile = path.join(out, `real-answers-${stamp}.jsonl`);
const judgeOff = argument('judge', 'on') === 'off';
const fixture = await startMeasureFixture({ withWeb: false, apiPort: Number(argument('port', '4110')), webPort: Number(argument('port', '4110')) - 1000,
  ...(judgeOff ? { environment: { MOHASSAN_JUDGE_FIX: '0', MOHASSAN_JUDGE_WITHHOLD: '0' } } : {}) });
const client = new FixtureClient(fixture);
let lastCreate = 0;
const results: { item: SetItem; observation: RunObservation | null; auto: ReturnType<typeof auto> | null; failure?: string }[] = [];
try {
  await client.signIn();
  const items = limit > 0 ? set.slice(0, limit) : set;
  for (const item of items) {
    const wait = lastCreate + 3200 - Date.now();
    if (wait > 0) await delay(wait);
    lastCreate = Date.now();
    let observation: RunObservation | null = null, previous: RunObservation | null = null, failure: string | undefined;
    try {
      if (item.previous) {
        previous = await observeRun(client, { text: item.previous }, { pollMs: 400, timeoutMs: 150_000 });
        observation = previous.status === 'running' ? null : await observeRun(client, { text: item.text, conversationId: previous.conversationId }, { pollMs: 400, timeoutMs: 150_000 });
        if (!observation) failure = 'previous turn did not settle';
      } else observation = await observeRun(client, { text: item.text }, { pollMs: 400, timeoutMs: 150_000 });
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    const facts = observation ? auto(item.text, observation) : null;
    results.push({ item, observation, auto: facts, ...(failure ? { failure } : {}) });
    await appendFile(answersFile, `${JSON.stringify({
      id: item.id, kind: item.kind, previous: item.previous, previousReply: previous?.answer ?? previous?.question?.prompt ?? null, text: item.text,
      reply: observation?.answer ?? null, question: observation?.question?.prompt ?? null, auto: facts,
      timing: observation ? { acceptMs: observation.acceptMs, settleMs: observation.settleMs, serverMs: observation.serverMs, browserVisibleMs: observation.browserVisibleMs } : null,
      steps: observation?.steps.map(step => step.text) ?? [], error: observation?.error ?? null, failure: failure ?? null,
      label: null, expected: null, questionNeeded: null, note: null,
    })}\n`, 'utf8');
    console.log(`${item.id} ${(observation?.status ?? 'FAILED').padEnd(13)} ${String(observation?.settleMs ?? '-').padStart(6)}ms  ${item.previous ? `${item.previous.slice(0, 30)} → ` : ''}${item.text.slice(0, 70)}`);
  }
} finally {
  await fixture.stop().catch(() => {});
}
const done = results.filter(result => result.auto);
const share = (pick: (facts: NonNullable<typeof results[number]['auto']>) => boolean) => done.length ? Number((done.filter(result => pick(result.auto!)).length / done.length).toFixed(3)) : null;
const summary = {
  at: new Date().toISOString(), setSha256, judge: judgeOff ? 'off' : 'on', items: results.length, settled: done.length, failures: results.filter(result => result.failure).length,
  status: done.reduce<Record<string, number>>((all, result) => ({ ...all, [result.auto!.status]: (all[result.auto!.status] ?? 0) + 1 }), {}),
  askedShare: share(facts => facts.asked), usedBrowserShare: share(facts => facts.usedBrowser), linkShare: share(facts => facts.hasLink),
  abstainPhraseShare: share(facts => facts.abstainPhrase), sameLanguageShare: share(facts => facts.sameLanguage === true),
  cardFields: stats(done.filter(result => result.auto!.asked).map(result => result.auto!.cardFields)),
  settleMs: stats(done.map(result => result.observation!.settleMs)), serverMs: stats(done.map(result => result.observation!.serverMs)),
  answersFile: path.relative(process.cwd(), answersFile),
  labelsNeeded: 'label, expected, questionNeeded: filled by the owner. Accuracy and «wrong answer shown» are computed only from those labels.',
};
await writeFile(path.join(out, `real-answers-${stamp}.summary.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 1));
process.exit(0);
