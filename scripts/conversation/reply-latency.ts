/**
 * When a reply shows on the chat screen, by the way the screen follows a running request (2026-11-23).
 *
 * Usage: npx tsx scripts/conversation/reply-latency.ts [--out artifacts/conversation-quality-2026-11-23/latency] [--port 4251]
 *
 * Both ways run against the same disposable server (scripts/perf/fixture.ts), question by question:
 * - poll: the screen until 2026-11-23 (assistant-app.tsx): GET the conversation 450 ms after the send, then 450 ms after each answer.
 * - wait: the screen since: GET ?since=<version>&wait=8000 at once, again at once after each change (chat-wait.ts).
 * `shownMs` is the client's wall time from just before the send to the first GET that shows the run settled: what the owner
 * waits for. Each question runs once to warm the page cache (discarded), then poll, wait, wait, poll, so cache and order
 * favour neither way. Requests go straight to the API; through the website each one also pays the proxy (measured apart).
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FixtureClient, startMeasureFixture, stats, type Conversation } from '../perf/fixture.js';

const argument = (name: string, fallback: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback; };
const out = path.resolve(argument('out', path.join('artifacts', 'conversation-quality-2026-11-23', 'latency')));
const port = Number(argument('port', '4251'));
await mkdir(out, { recursive: true });

const QUESTIONS = [
  'احسب 37 * 24', 'كم يساوي 15% من 240؟', 'شكرًا', 'ما هي قدراتك؟', 'What is 12 * 9?',
  'ما عاصمة مصر؟', 'من هو ألبرت أينشتاين؟', 'ما هو أطول نهر في العالم؟', 'What is the capital of France?',
];
const POLL_MS = 450, WAIT_MS = 8000;
type Way = 'poll' | 'wait';
const fixture = await startMeasureFixture({ withWeb: false, apiPort: port, webPort: port - 1000 });
const client = new FixtureClient(fixture);
const rowsFile = path.join(out, 'runs.jsonl');

async function follow(way: Way, text: string) {
  const sent = Date.now();
  const accepted = await client.call<Conversation & { version?: string }>('POST', '/api/chat/conversations', { goal: text });
  const acceptMs = Date.now() - sent;
  let detail = accepted, gets = 0;
  if (way === 'poll') {
    while (detail.status === 'running' && Date.now() - sent < 60_000) {
      await delay(POLL_MS);
      detail = await client.call('GET', `/api/chat/conversations/${accepted.id}`);
      gets++;
    }
  } else {
    let since = accepted.version;
    while (detail.status === 'running' && Date.now() - sent < 60_000) {
      detail = await client.call('GET', `/api/chat/conversations/${accepted.id}${since ? `?since=${since}&wait=${WAIT_MS}` : ''}`);
      since = (detail as { version?: string }).version;
      gets++;
      if (!since) await delay(POLL_MS);
    }
  }
  const shownMs = Date.now() - sent;
  const user = detail.messages.find(message => message.role === 'user'), answer = detail.messages.findLast(message => message.role === 'assistant');
  const serverMs = user && answer ? Date.parse(answer.createdAt) - Date.parse(user.createdAt) : null;
  return { way, text, status: detail.status, acceptMs, shownMs, serverMs, gets, conversationId: accepted.id };
}

const results: Awaited<ReturnType<typeof follow>>[] = [];
let last = 0;
const spaced = async () => { const wait = last + 3200 - Date.now(); if (wait > 0) await delay(wait); last = Date.now(); };
try {
  await client.signIn();
  for (const text of QUESTIONS) {
    await spaced();
    await follow('wait', text).catch(() => null); // warm-up: fills the page cache, not counted
    for (const way of ['poll', 'wait', 'wait', 'poll'] as Way[]) {
      await spaced();
      const row = await follow(way, text);
      results.push(row);
      await appendFile(rowsFile, `${JSON.stringify(row)}\n`, 'utf8');
      console.log(`${way.padEnd(4)} shown ${String(row.shownMs).padStart(5)} ms  server ${String(row.serverMs ?? '-').padStart(5)} ms  gets ${row.gets}  ${text}`);
    }
  }
} finally {
  await fixture.stop().catch(() => {});
}
const of = (way: Way) => results.filter(row => row.way === way);
const summary = {
  at: new Date().toISOString(), questions: QUESTIONS.length, runsPerWay: of('poll').length,
  poll: { shownMs: stats(of('poll').map(row => row.shownMs)), serverMs: stats(of('poll').map(row => row.serverMs)), getsPerReply: stats(of('poll').map(row => row.gets)) },
  wait: { shownMs: stats(of('wait').map(row => row.shownMs)), serverMs: stats(of('wait').map(row => row.serverMs)), getsPerReply: stats(of('wait').map(row => row.gets)) },
  // Paired by question: the mean of each question's two runs per way, then the difference.
  savedMsPerQuestion: QUESTIONS.map(text => {
    const mean = (way: Way) => { const rows = results.filter(row => row.text === text && row.way === way); return rows.reduce((sum, row) => sum + row.shownMs, 0) / rows.length; };
    return { text, poll: Math.round(mean('poll')), wait: Math.round(mean('wait')), saved: Math.round(mean('poll') - mean('wait')) };
  }),
  file: path.relative(process.cwd(), rowsFile),
};
await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 1));
process.exit(0);
