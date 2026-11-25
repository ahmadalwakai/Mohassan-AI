/** Offline development benchmark: npx tsx scripts/conversation-review/publication-latency.ts */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { redactCredentialText } from '@mohassan/cognitive';
import { createDatabase, migrate } from '@mohassan/database';
import { redactSecrets } from '@mohassan/providers';
import { sql, type Kysely } from 'kysely';
import { judge } from '../../apps/server/src/assistant/judge.js';
import { createJudgeShadow, type JudgeShadow, type JudgeShadowLine } from '../../apps/server/src/assistant/judge-shadow.js';
import { buildConversationLedger, buildConversationSummary, type ReviewMessage } from '../../apps/server/src/assistant/review/ledger.js';
import { reviewJudgedReply } from '../../apps/server/src/assistant/review/publication.js';
import { commandChatMigration } from '../../apps/server/src/command-chat.js';

const owner = 'offline-publication-benchmark';
const worker = 'offline-publication-worker';
const warmupPairs = 10;
const measuredPairs = 80;
const clean = (text: string) => redactCredentialText(redactSecrets(text));

const examples = [
  {
    preference: 'Always answer in English.',
    acknowledgment: 'Understood.',
    question: 'What is the archive schedule and where is the docket?',
    reply: 'The archive schedule is Friday. The docket is in the records office.',
    earlierQuestion: (entry: number) => `What is the page count for archive entry ${entry}?`,
    earlierReply: (entry: number) => `Archive entry ${entry} page count: ${100 + entry} pages.`,
  },
  {
    preference: 'استخدم العربية دائما في الردود.',
    acknowledgment: 'حسنًا.',
    question: 'متى موعد الأرشيف وأين السجل؟',
    reply: 'موعد الأرشيف الجمعة. السجل في مكتب المحفوظات.',
    earlierQuestion: (entry: number) => `كم عدد صفحات قيد الأرشيف ${entry}؟`,
    earlierReply: (entry: number) => `عدد صفحات قيد الأرشيف ${entry}: ${100 + entry} صفحة.`,
  },
].map(example => ({ ...example, verdict: judge({ question: example.question, reply: example.reply, status: 'completed' }) }));

type Example = typeof examples[number];
interface Seed {
  id: string;
  runId: string;
  throughMessageId: string;
}

// Fixed development-only input built by iteration, with no model or remote API.
function transcript(messages: number, example: Example): ReviewMessage[] {
  const exchanges: ReviewMessage[] = [
    { id: randomUUID(), role: 'user', content: example.preference },
    { id: randomUUID(), role: 'assistant', content: example.acknowledgment },
  ];
  for (let entry = 1; exchanges.length + 1 < messages; entry++) {
    exchanges.push(
      { id: randomUUID(), role: 'user', content: example.earlierQuestion(entry) },
      { id: randomUUID(), role: 'assistant', content: example.earlierReply(entry) },
    );
  }
  return [...exchanges, { id: randomUUID(), role: 'user', content: example.question }];
}

async function seed(tx: Kysely<any>, messages: number, keepSummary: boolean, example: Example): Promise<Seed> {
  const id = randomUUID();
  const runId = randomUUID();
  const history = transcript(messages, example);
  const summary = keepSummary ? buildConversationSummary(buildConversationLedger(history.slice(0, -1))) : null;
  await tx.insertInto('chat_conversations').values({ id, owner_id: owner, title: 'Benchmark', status: 'running', active_run_id: runId,
    review_summary: summary ? JSON.stringify(summary) : null }).execute();
  await tx.insertInto('chat_runs').values({ id: runId, conversation_id: id, owner_id: owner, goal: example.question, status: 'running',
    worker_id: worker, lease_token: runId, lease_expires_at: new Date(Date.now() + 600_000) }).execute();
  await tx.insertInto('chat_messages').values(history.map((message, index) => ({
    id: message.id, role: message.role, text: message.content, conversation_id: id, created_at: new Date(index * 1000),
  }))).execute();
  return { id, runId, throughMessageId: history.at(-1)!.id! };
}

function fencedTransaction<T>(db: Kysely<any>, { id, runId }: Seed, work: (tx: Kysely<any>) => Promise<T>) {
  return db.transaction().execute(async tx => {
    const conversation = await tx.selectFrom('chat_conversations').selectAll().where('id', '=', id)
      .where('owner_id', '=', owner).forUpdate().executeTakeFirstOrThrow();
    const run = await tx.selectFrom('chat_runs').selectAll().where('id', '=', runId).where('owner_id', '=', owner)
      .where('conversation_id', '=', id).where('lease_token', '=', runId).where('worker_id', '=', worker)
      .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`).forUpdate().executeTakeFirstOrThrow();
    if (conversation.active_run_id !== runId || conversation.status !== 'running' || run.status !== 'running') {
      throw new Error('The benchmark run lost its publication fence.');
    }
    return work(tx);
  });
}

async function publish(db: Kysely<any>, shadow: JudgeShadow, fixture: Seed, review: boolean, example: Example) {
  const { id, runId } = fixture;
  const judgeReply = () => {
    const verdict = shadow.observe({ conversationId: id, runId, question: example.question, reply: example.reply,
      status: 'completed', keepText: false });
    if (!verdict) throw new Error('The pre-send judge did not issue a verdict.');
    return { text: example.reply, withheld: false };
  };
  const start = performance.now();
  const judged = review
    ? await reviewJudgedReply(work => fencedTransaction(db, fixture, work), { id, runId, allowApply: true, clean }, judgeReply)
    : judgeReply();
  await fencedTransaction(db, fixture, async tx => {
    await tx.insertInto('chat_messages').values({ id: randomUUID(), conversation_id: id, role: 'assistant', text: clean(judged.text) }).execute();
  });
  return performance.now() - start;
}

function summarize(values: number[]) {
  values.sort((left, right) => left - right);
  const percentile = (fraction: number) => values[Math.ceil(fraction * values.length) - 1]!;
  return {
    meanMs: values.reduce((sum, ms) => sum + ms, 0) / values.length,
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
  };
}

async function benchmark(db: Kysely<any>, judgeShadow: JudgeShadow, messages: number, keepSummary: boolean) {
  const pairs = await db.transaction().execute(async tx => {
    const seeded = [];
    for (let pair = 0; pair < warmupPairs + measuredPairs; pair++) {
      // Keep both publication orders equally represented in each language.
      const example = examples[Math.floor(pair / 2) % examples.length]!;
      seeded.push({ baseline: await seed(tx, messages, keepSummary, example),
        shadow: await seed(tx, messages, keepSummary, example), example });
    }
    return seeded;
  });
  const baseline: number[] = [], shadow: number[] = [], added: number[] = [];
  for (const [index, pair] of pairs.entries()) {
    let withoutReviewer: number, withReviewer: number;
    if (index % 2 === 0) {
      withoutReviewer = await publish(db, judgeShadow, pair.baseline, false, pair.example);
      withReviewer = await publish(db, judgeShadow, pair.shadow, true, pair.example);
    } else {
      withReviewer = await publish(db, judgeShadow, pair.shadow, true, pair.example);
      withoutReviewer = await publish(db, judgeShadow, pair.baseline, false, pair.example);
    }
    if (index < warmupPairs) continue;
    baseline.push(withoutReviewer);
    shadow.push(withReviewer);
    added.push(withReviewer - withoutReviewer);
  }
  await judgeShadow.flush();
  const logs = (await readFile(judgeShadow.logFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as JudgeShadowLine);
  const expected = new Map(pairs.map(pair => [pair.shadow.id, pair]));
  const baselineIds = new Set(pairs.map(pair => pair.baseline.id));
  const shadowLogs = logs.filter(line => expected.has(line.conversationId));
  const baselineLogs = logs.filter(line => baselineIds.has(line.conversationId));
  if (shadowLogs.length !== pairs.length || baselineLogs.length !== pairs.length
    || baselineLogs.some(line => line.conversationReview != null) || shadowLogs.some(line => {
      const item = expected.get(line.conversationId)!;
      return line.runId !== item.shadow.runId || line.decision !== item.example.verdict.decision
        || line.conversationReview?.applied !== false || !Array.isArray(line.conversationReview.findings);
    })) throw new Error('The judge log does not match timed baseline and shadow runs.');
  const rows = await db.selectFrom('chat_messages as m').innerJoin('chat_conversations as c', 'c.id', 'm.conversation_id')
    .select(['m.conversation_id', 'm.text', 'c.review_summary'])
    .where('m.conversation_id', 'in', [...expected.keys()]).where('m.created_at', '>', new Date(messages * 1000)).execute();
  if (rows.length !== pairs.length || rows.some(row => {
    const item = expected.get(row.conversation_id);
    return !item || row.text !== clean(item.example.reply)
      || (keepSummary ? row.review_summary?.throughMessageId !== item.shadow.throughMessageId
        || row.review_summary.messageCount !== messages : row.review_summary != null);
  })) {
    throw new Error('A timed shadow publication did not store the expected reply and prior transcript summary.');
  }
  return { messages, priorSummary: keepSummary, pairs: measuredPairs,
    baseline: summarize(baseline), shadow: summarize(shadow), added: summarize(added) };
}

process.env.MOHASSAN_CONVERSATION_REVIEW_APPLY = '0';
const logDirectory = await mkdtemp(join(tmpdir(), 'mohassan-review-benchmark-'));
const judgeShadow = createJudgeShadow({ logFile: join(logDirectory, 'shadow.jsonl') });
const database = await createDatabase();
try {
  await migrate(database.db);
  await commandChatMigration(database.db);
  const runs = [];
  runs.push(await benchmark(database.db, judgeShadow, 7, false));
  runs.push(await benchmark(database.db, judgeShadow, 131, true));
  console.log(JSON.stringify({
    recordedAt: new Date().toISOString(),
    runtime: `${process.version} ${process.platform} ${process.arch}`,
    provenance: 'Offline deterministic development inputs. Never used for training.',
    timingScope: 'Elapsed time through assistant-message commit with embedded PGlite. Both modes run the real judge and take the conversation and run locks for assistant publication. Shadow also obtains those locks for the pre-send transcript, summary and review. File-log flush is outside timing.',
    pairing: `Each sample uses identical transcript text in two separate conversations. Order alternates, with equal measured pairs in Arabic and English. ${warmupPairs} warmup pairs per scenario are excluded. Added timings are paired shadow minus baseline. Percentiles use nearest rank.`,
    runs,
  }, null, 2));
} finally {
  await judgeShadow.flush();
  await database.close();
  await rm(logDirectory, { recursive: true, force: true });
}
