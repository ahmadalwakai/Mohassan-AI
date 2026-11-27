/** Offline development benchmark: npx tsx scripts/conversation-review/publication-latency.ts */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { availableParallelism, cpus, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { redactCredentialText } from '@mohassan/cognitive';
import { createDatabase, migrate } from '@mohassan/database';
import { redactSecrets } from '@mohassan/providers';
import { AliasNode, SelectQueryNode, TableNode, sql, type Kysely } from 'kysely';
import { judge } from '../../apps/server/src/assistant/judge.js';
import { createJudgeShadow, type JudgeShadow, type JudgeShadowLine } from '../../apps/server/src/assistant/judge-shadow.js';
import type { ReviewMessage } from '../../apps/server/src/assistant/review/ledger.js';
import * as publication from '../../apps/server/src/assistant/review/publication.js';
import { commandChatMigration } from '../../apps/server/src/command-chat.js';

const owner = 'offline-publication-benchmark';
const worker = 'offline-publication-worker';
const warmupPairs = 10;
const measuredPairs = 80;
const clean = (text: string) => redactCredentialText(redactSecrets(text));
const { reviewJudgedReply } = publication;
const incremental = 'REVIEW_MESSAGE_WINDOW' in publication;

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

interface PublicationPair {
  baseline: Seed;
  shadow: Seed;
  example: Example;
}

interface Scenario {
  messages: number;
  keepSummary: boolean;
  pairs: PublicationPair[];
  baseline: number[];
  shadow: number[];
  added: number[];
  rowsRead: number[];
}

// Fixed development-only input built by iteration, with no model or remote API.
function transcript(messages: number, example: Example): ReviewMessage[] {
  const exchanges: ReviewMessage[] = [
    { id: randomUUID(), role: 'user', content: example.preference },
  ];
  if (messages % 2 !== 0) exchanges.push({ id: randomUUID(), role: 'assistant', content: example.acknowledgment });
  for (let entry = 1; exchanges.length + 1 < messages; entry++) {
    exchanges.push(
      { id: randomUUID(), role: 'user', content: example.earlierQuestion(entry) },
      { id: randomUUID(), role: 'assistant', content: example.earlierReply(entry) },
    );
  }
  return [...exchanges, { id: randomUUID(), role: 'user', content: example.question }];
}

async function seed(db: Kysely<any>, messages: number, keepSummary: boolean, example: Example): Promise<Seed> {
  const id = randomUUID();
  const runId = randomUUID();
  const history = transcript(messages, example);
  const rows = history.map((message, index) => ({
    id: message.id, role: message.role, text: message.content, conversation_id: id, created_at: new Date(index * 1000),
  }));
  // A prior pre-send review reaches the previous user message. The prior
  // assistant reply and the next user message are committed after that review.
  const checkpointAt = rows.length - 2;
  const fixture = { id, runId, throughMessageId: history.at(-1)!.id! };
  await db.transaction().execute(async tx => {
    await tx.insertInto('chat_conversations').values({ id, owner_id: owner, title: 'Benchmark', status: 'running', active_run_id: runId }).execute();
    await tx.insertInto('chat_runs').values({ id: runId, conversation_id: id, owner_id: owner, goal: example.question, status: 'running',
      worker_id: worker, lease_token: runId, lease_expires_at: new Date(Date.now() + 600_000) }).execute();
    await tx.insertInto('chat_messages').values(keepSummary ? rows.slice(0, checkpointAt) : rows).execute();
  });
  if (keepSummary) {
    const context = { id, runId, db, allowApply: false, clean };
    await reviewJudgedReply(work => fencedTransaction(db, fixture, work), context,
      () => ({ text: history[checkpointAt]!.content, withheld: false }));
    const { review_summary } = await db.selectFrom('chat_conversations').select('review_summary').where('id', '=', id).executeTakeFirstOrThrow();
    if (review_summary?.throughMessageId !== rows[checkpointAt - 1]!.id || review_summary.messageCount !== checkpointAt) {
      throw new Error('The prior publication did not build the expected checkpoint.');
    }
    await db.insertInto('chat_messages').values(rows.slice(checkpointAt)).execute();
  }
  return fixture;
}

function fencedTransaction<T>(db: Kysely<any>, { id, runId }: Seed, work: (tx: Kysely<any>) => Promise<T>) {
  return db.transaction().execute(async tx => {
    const row = tx.selectFrom('chat_conversations').where('id', '=', id).where('owner_id', '=', owner).forUpdate();
    // Mirror the conversation lock projection of the implementation under test.
    const conversation = incremental
      ? await row.select(['status', 'active_run_id']).executeTakeFirstOrThrow()
      : await row.selectAll().executeTakeFirstOrThrow();
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
  let rowsRead = 0;
  const messageQueries = new WeakSet<object>();
  const observedDb = db.withPlugin({
    transformQuery({ node, queryId }) {
      if (SelectQueryNode.is(node) && node.from?.froms.some(source => {
        const table = AliasNode.is(source) ? source.node : source;
        return TableNode.is(table) && table.table.identifier.name === 'chat_messages';
      })) messageQueries.add(queryId);
      return node;
    },
    async transformResult({ queryId, result }) {
      if (messageQueries.has(queryId)) rowsRead += result.rows.length;
      return result;
    },
  });
  const judgeReply = () => {
    const verdict = shadow.observe({ conversationId: id, runId, question: example.question, reply: example.reply,
      status: 'completed', keepText: false });
    if (!verdict) throw new Error('The pre-send judge did not issue a verdict.');
    return { text: example.reply, withheld: false };
  };
  const start = performance.now();
  const context = { id, runId, db: observedDb, allowApply: true, clean };
  const judged = review
    ? await reviewJudgedReply(work => fencedTransaction(observedDb, fixture, work), context, judgeReply)
    : judgeReply();
  await fencedTransaction(observedDb, fixture, async tx => {
    await tx.insertInto('chat_messages').values({ id: randomUUID(), conversation_id: id, role: 'assistant', text: clean(judged.text) }).execute();
  });
  return { ms: performance.now() - start, rowsRead };
}

function summarize(values: number[]) {
  values.sort((left, right) => left - right);
  const percentile = (fraction: number) => values[Math.ceil(fraction * values.length) - 1]!;
  return {
    meanMs: values.reduce((sum, ms) => sum + ms, 0) / values.length,
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
  };
}

async function measurePair(db: Kysely<any>, judgeShadow: JudgeShadow, scenario: Scenario, index: number) {
  const pair = scenario.pairs[index]!;
  let withoutReviewer: Awaited<ReturnType<typeof publish>>, withReviewer: Awaited<ReturnType<typeof publish>>;
  if (index % 2 === 0) {
    withoutReviewer = await publish(db, judgeShadow, pair.baseline, false, pair.example);
    withReviewer = await publish(db, judgeShadow, pair.shadow, true, pair.example);
  } else {
    withReviewer = await publish(db, judgeShadow, pair.shadow, true, pair.example);
    withoutReviewer = await publish(db, judgeShadow, pair.baseline, false, pair.example);
  }
  if (index < warmupPairs) return;
  scenario.baseline.push(withoutReviewer.ms);
  scenario.shadow.push(withReviewer.ms);
  scenario.added.push(withReviewer.ms - withoutReviewer.ms);
  scenario.rowsRead.push(withReviewer.rowsRead - withoutReviewer.rowsRead);
}

async function summarizeScenario(db: Kysely<any>, logs: JudgeShadowLine[], scenario: Scenario) {
  const { messages, keepSummary, pairs, baseline, shadow, added, rowsRead } = scenario;
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
    baseline: summarize(baseline), shadow: summarize(shadow), added: summarize(added),
    rowsRead: { min: Math.min(...rowsRead), max: Math.max(...rowsRead), mean: rowsRead.reduce((sum, count) => sum + count, 0) / rowsRead.length } };
}

async function benchmark(db: Kysely<any>, judgeShadow: JudgeShadow) {
  const scenarios: Scenario[] = [7, 131, 500, 2_000].map(messages => ({
    messages, keepSummary: messages !== 7, pairs: [], baseline: [], shadow: [], added: [], rowsRead: [],
  }));
  const totalPairs = warmupPairs + measuredPairs;
  for (let index = 0; index < totalPairs; index++) {
    // Keep both publication orders equally represented in each language.
    const example = examples[Math.floor(index / 2) % examples.length]!;
    for (const scenario of scenarios) {
      const { messages, keepSummary } = scenario;
      scenario.pairs.push({ baseline: await seed(db, messages, keepSummary, example),
        shadow: await seed(db, messages, keepSummary, example), example });
    }
  }
  // Interleave all sizes on the same populated database. Rotate the first
  // scenario on each round so each size occupies every measurement position.
  for (let index = 0; index < totalPairs; index++) {
    const first = index + Math.floor(index / scenarios.length);
    for (let position = 0; position < scenarios.length; position++) {
      await measurePair(db, judgeShadow, scenarios[(first + position) % scenarios.length]!, index);
    }
  }
  await judgeShadow.flush();
  const logs = (await readFile(judgeShadow.logFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as JudgeShadowLine);
  return Promise.all(scenarios.map(scenario => summarizeScenario(db, logs, scenario)));
}

process.env.MOHASSAN_CONVERSATION_REVIEW_APPLY = '0';
const logDirectory = await mkdtemp(join(tmpdir(), 'mohassan-review-benchmark-'));
const judgeShadow = createJudgeShadow({ logFile: join(logDirectory, 'shadow.jsonl') });
const database = await createDatabase();
try {
  await migrate(database.db);
  await commandChatMigration(database.db);
  const runs = await benchmark(database.db, judgeShadow);
  console.log(JSON.stringify({
    recordedAt: new Date().toISOString(),
    runtime: `${process.version} ${process.platform} ${release()} ${process.arch}`,
    machine: { cpu: cpus()[0]?.model, availableParallelism: availableParallelism() },
    provenance: 'Offline deterministic development inputs. Never used for training.',
    timingScope: 'Elapsed time through assistant-message commit with embedded PGlite. Both modes run the real judge and take the conversation and run locks for assistant publication. Shadow also times the pre-send review. Prior checkpoint setup and file-log flush are outside timing.',
    rowScope: 'Added chat_messages SELECT result rows per publication, including checkpoint anchors.',
    pairing: `Each sample uses identical transcript text in two separate conversations. Order alternates, with equal measured pairs in Arabic and English. All transcript sizes are seeded before timing and interleaved in rotating order on the same database. ${warmupPairs} warmup pairs per scenario are excluded. Added timings are paired shadow minus baseline. Percentiles use nearest rank.`,
    runs,
  }, null, 2));
} finally {
  await judgeShadow.flush();
  await database.close();
  await rm(logDirectory, { recursive: true, force: true });
}
