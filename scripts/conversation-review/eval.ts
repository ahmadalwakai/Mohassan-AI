/** Offline usage: npx tsx scripts/conversation-review/eval.ts [--json] */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { reviewReply } from '../../apps/server/src/assistant/review/checks.js';
import {
  buildConversationLedger, buildConversationSummary, SUMMARY_MIN_MESSAGES, type ConversationSummary,
} from '../../apps/server/src/assistant/review/ledger.js';
import { corpusProvenance, developmentConversations, type DevelopmentConversation } from './dev-conversations.js';
import { scoreCorpus } from './score.js';

function review(conversation: DevelopmentConversation, summary?: ConversationSummary) {
  const ledger = buildConversationLedger(conversation.messages, summary);
  const result = reviewReply(ledger, conversation.draft);
  if (conversation.messages.length + 1 >= SUMMARY_MIN_MESSAGES) {
    // Shadow publishes the original draft, so that text is also the next summary's source.
    buildConversationSummary(ledger, { id: `${conversation.id}-draft`, role: 'assistant', content: conversation.draft });
  }
  return result;
}

function withLongHistory(conversation: DevelopmentConversation) {
  const messages = conversation.messages.slice(0, -1);
  for (let entry = 1; entry <= 64; entry++) {
    const english = conversation.language === 'en';
    messages.push({ id: `${conversation.id}-log-user-${entry}`, role: 'user',
      content: english ? `What is the record page for entry ${entry}?` : `ما صفحة السجل للقيد ${entry}؟` },
    { id: `${conversation.id}-log-reply-${entry}`, role: 'assistant',
      content: english ? `Entry ${entry} page: ${100 + entry}.` : `صفحة القيد ${entry}: ${100 + entry}.` });
  }
  const summary = buildConversationSummary(buildConversationLedger(messages));
  return { conversation: { ...conversation, messages: [...messages, conversation.messages.at(-1)!] }, summary };
}

interface BenchmarkCase {
  conversation: DevelopmentConversation;
  summary?: ConversationSummary;
}

function benchmark(cases: readonly BenchmarkCase[], repetitions: number) {
  for (const { conversation, summary } of cases) review(conversation, summary);
  const timings: number[] = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    for (const { conversation, summary } of cases) {
      const start = performance.now();
      review(conversation, summary);
      timings.push(performance.now() - start);
    }
  }
  timings.sort((left, right) => left - right);
  const percentile = (fraction: number) => timings[Math.ceil(timings.length * fraction) - 1];
  return {
    replies: timings.length,
    minMessages: Math.min(...cases.map(item => item.conversation.messages.length)),
    maxMessages: Math.max(...cases.map(item => item.conversation.messages.length)),
    meanMs: timings.reduce((sum, ms) => sum + ms, 0) / timings.length,
    p50Ms: percentile(0.50), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
  };
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length && args[0] !== '--json')) throw new Error('Usage: npx tsx scripts/conversation-review/eval.ts [--json]');
const command = ['npx tsx scripts/conversation-review/eval.ts', ...args].join(' ');
const corpus = developmentConversations();
const results = corpus.map(conversation => {
  const result = review(conversation);
  return {
    id: conversation.id, language: conversation.language, expected: conversation.expected,
    found: result.findings.map(finding => finding.check), action: result.action,
  };
});
const scores = scoreCorpus(results);
const recordedAt = new Date().toISOString();
const counts = { all: corpus.length, ar: corpus.filter(item => item.language === 'ar').length,
  en: corpus.filter(item => item.language === 'en').length, clean: corpus.filter(item => !item.expected.length).length };
const corpusSha256 = createHash('sha256').update(JSON.stringify(corpus)).digest('hex');
const timings = {
  fixture: benchmark(corpus.map(conversation => ({ conversation })), 6),
  longWithSummary: benchmark(corpus.filter(item => item.id.startsWith(`${item.language}-library-`)).map(withLongHistory), 12),
};
const runtime = `${process.version} ${process.platform} ${process.arch}`;
const timingScope = 'Local elapsed time per reply for in-memory ledger assembly, checks, and next-summary creation once the history reaches the production threshold. The long benchmark extends one clean and one seeded conversation per check and language by 64 exchanges. Database I/O, logging, and the judge are outside this timing.';

if (args.includes('--json')) {
  console.log(JSON.stringify({ recordedAt, command, runtime, corpusProvenance, corpusSha256, counts, scores, timingScope, timings, results }, null, 2));
} else {
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const formatRate = ({ count, total, wilson95 }: typeof scores.all[number]['caught']) =>
    wilson95 ? `${count}/${total} (${percent(count / total)}, ${wilson95.map(percent).join('–')})` : `${count}/${total} (n/a)`;
  console.log('# Conversation reviewer development evaluation\n');
  console.log(`Run ${recordedAt} on Node ${runtime} with \`${command}\`.\n`);
  console.log(`${counts.all} multi-turn conversations (${counts.ar} Arabic, ${counts.en} English, ${counts.clean} clean). The corpus uses deterministic templates with zero model or API calls and is for development evaluation only. Training use is excluded. SHA-256 \`${corpusSha256}\`.\n`);
  console.log('The denominators are the number of scored drafts with and without each seeded check. The 95% Wilson intervals describe this paired, template-based development corpus. They cannot estimate performance on independent or production conversations.\n');
  console.log('| Language | Check | Issues caught (95% Wilson interval) | False alarms (95% Wilson interval) |');
  console.log('| --- | --- | ---: | ---: |');
  for (const [language, rows] of Object.entries(scores)) {
    for (const row of rows) console.log(`| ${language} | ${row.check} | ${formatRate(row.caught)} | ${formatRate(row.falseAlarms)} |`);
  }
  console.log(`\n${timingScope}\n`);
  console.log('| Stored messages | Measured replies | Mean (ms) | p50 (ms) | p95 (ms) | p99 (ms) |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const [scenario, time] of Object.entries(timings)) {
    const length = time.minMessages === time.maxMessages ? time.minMessages : `${time.minMessages}–${time.maxMessages}`;
    const label = scenario === 'longWithSummary' ? `${length}, with prior summary` : `${length}, development corpus`;
    console.log(`| ${label} | ${time.replies} | ${time.meanMs.toFixed(3)} | ${time.p50Ms.toFixed(3)} | ${time.p95Ms.toFixed(3)} | ${time.p99Ms.toFixed(3)} |`);
  }
}
