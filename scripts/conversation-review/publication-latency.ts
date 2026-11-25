/** Offline development benchmark: npx tsx scripts/conversation-review/publication-latency.ts */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { redactCredentialText } from '@mohassan/cognitive';
import { createDatabase, migrate } from '@mohassan/database';
import { redactSecrets } from '@mohassan/providers';
import type { Kysely } from 'kysely';
import { judge } from '../../apps/server/src/assistant/judge.js';
import { buildConversationLedger, buildConversationSummary, type ReviewMessage } from '../../apps/server/src/assistant/review/ledger.js';
import { createConversationPublicationReviewer } from '../../apps/server/src/assistant/review/publication.js';
import { commandChatMigration } from '../../apps/server/src/command-chat.js';

const owner = 'offline-publication-benchmark';
const warmupPairs = 10;
const measuredPairs = 80;
const clean = (text: string) => redactCredentialText(redactSecrets(text));
const reviewer = createConversationPublicationReviewer({ apply: false, judgeEnabled: true, clean, evidenceFor: () => [] });

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

async function seed(tx: Kysely<any>, messages: number, keepSummary: boolean, example: Example) {
  const id = randomUUID();
  const history = transcript(messages, example);
  const summary = keepSummary ? buildConversationSummary(buildConversationLedger(history.slice(0, -1))) : null;
  await tx.insertInto('chat_conversations').values({ id, owner_id: owner, title: 'Benchmark',
    review_summary: summary ? JSON.stringify(summary) : null }).execute();
  await tx.insertInto('chat_messages').values(history.map((message, index) => ({
    id: message.id, role: message.role, text: message.content, conversation_id: id, created_at: new Date(index * 1000),
  }))).execute();
  return id;
}

async function publish(db: Kysely<any>, id: string, shadow: boolean, example: Example) {
  const context = {};
  const start = performance.now();
  if (shadow) reviewer.recordJudge(context, example.verdict, false, false);
  await db.transaction().execute(async tx => {
    await tx.selectFrom('chat_conversations').select('id').where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
    const text = clean(example.reply);
    if (shadow) {
      await reviewer.publish(tx, { id, text, status: 'completed', context });
    } else {
      await tx.insertInto('chat_messages').values({ id: randomUUID(), conversation_id: id, role: 'assistant', text }).execute();
    }
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

async function benchmark(db: Kysely<any>, messages: number, keepSummary: boolean) {
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
      withoutReviewer = await publish(db, pair.baseline, false, pair.example);
      withReviewer = await publish(db, pair.shadow, true, pair.example);
    } else {
      withReviewer = await publish(db, pair.shadow, true, pair.example);
      withoutReviewer = await publish(db, pair.baseline, false, pair.example);
    }
    if (index < warmupPairs) continue;
    baseline.push(withoutReviewer);
    shadow.push(withReviewer);
    added.push(withReviewer - withoutReviewer);
  }
  const expected = new Map(pairs.map(pair => [pair.shadow, pair.example]));
  const rows = await db.selectFrom('chat_messages as m').innerJoin('chat_conversations as c', 'c.id', 'm.conversation_id')
    .select(['m.id', 'm.conversation_id', 'm.text', 'm.conversation_review', 'c.review_summary'])
    .where('m.conversation_id', 'in', [...expected.keys()]).where('m.conversation_review', 'is not', null).execute();
  if (rows.length !== pairs.length || rows.some(row => {
    const example = expected.get(row.conversation_id);
    return !example || row.text !== clean(example.reply) || row.conversation_review?.applied !== false
      || row.conversation_review?.judge?.[0]?.decision !== example.verdict.decision
      || (keepSummary ? row.review_summary?.throughMessageId !== row.id : row.review_summary != null);
  })) {
    throw new Error('A timed shadow publication did not store the expected reply, metadata, and summary.');
  }
  return { messages, priorSummary: keepSummary, pairs: measuredPairs,
    baseline: summarize(baseline), shadow: summarize(shadow), added: summarize(added) };
}

const database = await createDatabase();
try {
  await migrate(database.db);
  await commandChatMigration(database.db);
  const runs = [];
  runs.push(await benchmark(database.db, 7, false));
  runs.push(await benchmark(database.db, 131, true));
  console.log(JSON.stringify({
    recordedAt: new Date().toISOString(),
    runtime: `${process.version} ${process.platform} ${process.arch}`,
    provenance: 'Offline deterministic development inputs. Never used for training.',
    timingScope: 'Elapsed time for row lock and assistant publication through transaction commit in embedded PGlite. Shadow includes history, checks, metadata and applicable summary reads and writes. Both modes exclude the existing judge computation.',
    pairing: `Each sample uses identical transcript text in two separate conversations. Order alternates, with equal measured pairs in Arabic and English. ${warmupPairs} warmup pairs per scenario are excluded. Added timings are paired shadow minus baseline. Percentiles use nearest rank.`,
    runs,
  }, null, 2));
} finally {
  await database.close();
}
