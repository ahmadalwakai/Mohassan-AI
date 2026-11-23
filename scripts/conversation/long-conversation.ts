/**
 * One long conversation, measured turn by turn (conversation quality, length and speed, 2026-11-23).
 *
 * Usage: npx tsx scripts/conversation/long-conversation.ts [--out artifacts/conversation-quality-2026-11-23/long] [--port 4241] [--volume 60]
 *
 * Part 1 sends a fixed script of topics, follow-ups and back-references in ONE conversation and records, per turn:
 * settle and server time, the steps with their times, the reply, and a mechanical check (`expect`: words the reply
 * should contain if the topic was kept). The check is a fact about the text, not a judgement of correctness.
 * Part 2 keeps the same conversation going with fast local turns (arithmetic) and measures what fetching the
 * conversation costs as it grows: wall time and bytes of GET /api/chat/conversations/:id, median of three.
 *
 * The server is the disposable measurement fixture (scripts/perf/fixture.ts): no model, empty database, Windows off.
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FixtureClient, observeRun, startMeasureFixture, stats, type MeasureFixture, type RunObservation } from '../perf/fixture.js';

const argument = (name: string, fallback: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback; };
const out = path.resolve(argument('out', path.join('artifacts', 'conversation-quality-2026-11-23', 'long')));
const port = Number(argument('port', '4241'));
const volume = Number(argument('volume', '60'));
await mkdir(out, { recursive: true });

interface Turn { text: string; expect: RegExp[]; note: string }
/** Every `expect` must match for the mechanical check to pass. */
const SCRIPT: Turn[] = [
  { text: 'ما عاصمة مصر؟', expect: [/القاهرة/u], note: 'fact' },
  { text: 'وكم عدد سكانها؟', expect: [/مليون|ملايين/u, /مصر|القاهرة/u], note: 'follow-up: her = Egypt/Cairo' },
  { text: 'من هو ألبرت أينشتاين؟', expect: [/فيزياء|فيزيائي/u], note: 'fact' },
  { text: 'متى توفي؟', expect: [/1955/u], note: 'follow-up: he = Einstein' },
  { text: 'احسب 37 * 24', expect: [/888/u], note: 'local computation' },
  { text: 'أضف 12 إلى النتيجة السابقة', expect: [/900/u], note: 'reference to the previous result' },
  { text: 'ما هو أطول نهر في العالم؟', expect: [/النيل/u], note: 'fact' },
  { text: 'وكم طوله؟', expect: [/6[,.٬]?[0-9]{3}|٦[٬,.]?[٠-٩]{3}/u], note: 'follow-up: it = the Nile' },
  { text: 'ما عاصمة اليابان؟', expect: [/طوكيو/u], note: 'fact' },
  { text: 'وما عملتها؟', expect: [/ين/u], note: 'follow-up: her = Japan' },
  { text: 'ارجع إلى أينشتاين: أين ولد؟', expect: [/أولم|ألمانيا/u], note: 'back-reference eight turns back' },
  { text: 'What is the capital of France?', expect: [/Paris/u], note: 'English fact' },
  { text: 'How many people live there?', expect: [/million/iu], note: 'English follow-up: there = Paris/France' },
  { text: 'من كتب رواية البؤساء؟', expect: [/هوغو|هوجو|هيغو|هيجو/u], note: 'fact (who wrote)' },
  { text: 'ومتى نشرت؟', expect: [/1862/u], note: 'follow-up: it = Les Misérables' },
  { text: 'ما هو الذكاء الاصطناعي؟', expect: [/حاسوب|الحاسوب|الآلات|آلة/u], note: 'definition' },
  { text: 'اختصر جوابك السابق في جملة واحدة', expect: [/ذكاء/u], note: 'reshape the previous answer: shorter' },
  { text: 'اشرح أكثر', expect: [/ذكاء/u], note: 'reshape the previous answer: longer' },
  { text: 'شكرًا', expect: [], note: 'courtesy, no search expected' },
];

const fixture: MeasureFixture = await startMeasureFixture({ withWeb: false, apiPort: port, webPort: port - 1000 });
const client = new FixtureClient(fixture);
const secretCookie = () => (client as unknown as { cookie: string }).cookie;

/** GET the conversation three times; wall ms and bytes of each, with the median. */
async function fetchCost(conversationId: string) {
  const samples: { ms: number; bytes: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    const response = await fetch(`${fixture.apiBase}/api/chat/conversations/${conversationId}`, {
      headers: { origin: fixture.origin, 'x-mohassan-internal': fixture.secret, cookie: secretCookie() }, signal: AbortSignal.timeout(30_000),
    });
    const body = await response.arrayBuffer();
    samples.push({ ms: Math.round(performance.now() - started), bytes: body.byteLength });
  }
  const sorted = [...samples].sort((a, b) => a.ms - b.ms);
  return { medianMs: sorted[1]!.ms, bytes: samples[2]!.bytes, samples };
}

const turnsFile = path.join(out, 'turns.jsonl');
const volumeFile = path.join(out, 'volume.jsonl');
let conversationId: string | undefined;
const results: { index: number; turn: Turn; observation: RunObservation | null; pass: boolean | null; failure?: string }[] = [];
let lastSend = 0;
try {
  await client.signIn();
  // Part 1: the scripted conversation. 3.2 s between sends, as in scripts/quality/real-questions.ts (search provider spacing).
  for (const [index, turn] of SCRIPT.entries()) {
    const wait = lastSend + 3200 - Date.now();
    if (wait > 0) await delay(wait);
    lastSend = Date.now();
    let observation: RunObservation | null = null, failure: string | undefined;
    try {
      observation = await observeRun(client, { text: turn.text, ...(conversationId ? { conversationId } : {}) }, { pollMs: 150, timeoutMs: 150_000 });
      conversationId = observation.conversationId;
      // A waiting card would refuse the next message (CHAT_BUSY): stop the card so the script can go on, and record it.
      if (observation.status !== 'idle') await client.call('POST', `/api/chat/conversations/${conversationId}/cancel`, {}).catch(() => {});
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    const reply = observation?.answer ?? '';
    const pass = observation ? turn.expect.every(pattern => pattern.test(reply)) : null;
    results.push({ index, turn, observation, pass, ...(failure ? { failure } : {}) });
    const cost = conversationId ? await fetchCost(conversationId) : null;
    await appendFile(turnsFile, `${JSON.stringify({
      index: index + 1, text: turn.text, note: turn.note, expect: turn.expect.map(String), pass,
      status: observation?.status ?? null, settleMs: observation?.settleMs ?? null, serverMs: observation?.serverMs ?? null,
      steps: observation?.steps ?? [], reply: observation?.answer ?? null, question: observation?.question?.prompt ?? null,
      replyChars: reply.length, error: observation?.error ?? null, failure: failure ?? null, fetch: cost,
    })}\n`, 'utf8');
    console.log(`${String(index + 1).padStart(2)} ${pass === null ? 'FAILED' : pass ? 'kept  ' : 'missed'} ${String(observation?.settleMs ?? '-').padStart(6)}ms ${String(reply.length).padStart(5)}ch  ${turn.text}`);
  }
  // Part 2: the same conversation grows with fast local turns; the fetch cost is read every ten turns.
  // 2.1 s between sends keeps under the route's 30 messages per minute.
  for (let i = 0; i < volume && conversationId; i++) {
    const wait = lastSend + 2100 - Date.now();
    if (wait > 0) await delay(wait);
    lastSend = Date.now();
    const observation = await observeRun(client, { text: `احسب ${i + 2} * ${i + 3}`, conversationId }, { pollMs: 150, timeoutMs: 60_000 }).catch(() => null);
    if (observation && observation.status !== 'idle') await client.call('POST', `/api/chat/conversations/${conversationId}/cancel`, {}).catch(() => {});
    if ((i + 1) % 10 === 0 || i === volume - 1) {
      const detail = await client.call<{ messages: { role: string; text: string }[]; olderMessages?: number }>('GET', `/api/chat/conversations/${conversationId}`);
      const cost = await fetchCost(conversationId);
      // Whether the reply just written is on screen: the last message shown must be this turn's product.
      const expected = String((i + 2) * (i + 3));
      const lastShown = detail.messages.at(-1)?.text ?? '';
      await appendFile(volumeFile, `${JSON.stringify({ turns: SCRIPT.length + i + 1, messages: detail.messages.length, olderMessages: detail.olderMessages ?? 0,
        newestReplyShown: detail.messages.at(-1)?.role === 'assistant' && lastShown.includes(expected), ...cost, lastSettleMs: observation?.settleMs ?? null, lastServerMs: observation?.serverMs ?? null })}\n`, 'utf8');
      console.log(`volume: ${detail.messages.length} messages (+${detail.olderMessages ?? 0} older), newest reply shown: ${lastShown.includes(expected)}, GET ${cost.medianMs} ms, ${cost.bytes} bytes`);
    }
  }
} finally {
  await fixture.stop().catch(() => {});
}
const done = results.filter(result => result.observation);
const summary = {
  at: new Date().toISOString(), turns: SCRIPT.length, settled: done.length,
  mechanicalPass: done.filter(result => result.pass).length,
  mechanicalMissed: done.filter(result => result.pass === false).map(result => `${result.index + 1}: ${result.turn.text}`),
  settleMs: stats(done.map(result => result.observation!.settleMs)), serverMs: stats(done.map(result => result.observation!.serverMs)),
  replyChars: stats(done.map(result => (result.observation!.answer ?? '').length)),
  files: { turns: path.relative(process.cwd(), turnsFile), volume: path.relative(process.cwd(), volumeFile) },
  note: 'pass = every expected word is in the reply (mechanical). Correctness is read by hand from turns.jsonl.',
};
await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 1));
process.exit(0);
