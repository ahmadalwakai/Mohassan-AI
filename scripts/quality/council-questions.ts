/**
 * The owner's model council measured on the frozen date and population questions of date-questions.ts (fixed 2026-11-22
 * 13:45 UTC), asked live through an isolated server with the council on and the owner's trained models.
 *
 * Usage: npx tsx scripts/quality/council-questions.ts --models-root "C:\Mohassan AI" [--python <python>] [--port 4170] [--out <dir>]
 *
 * The expected answers below were written into this file on 2026-11-26 before its first run; they are the well-known
 * facts, checked mechanically on the reply's first answer line (a year, or a population in the stated range). Per
 * question the run records: the pipeline's own answer (the council's `pipeline` member), the reply that was sent, the
 * reading model's answer, whether the council changed the reply, and timings. Questions are spaced 8 s apart, as in
 * date-questions.ts (Wikipedia answered HTTP 429 to quick successions from this machine).
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChatConversation, ModelCouncil } from '@mohassan/contracts';
import { FixtureClient, observeRun, startMeasureFixture } from '../perf/fixture.js';

/** The date-questions.ts set, unchanged, with its expected answer per question (pre-registered). */
const QUESTIONS: { id: string; text: string; expected: RegExp; fact: string }[] = [
  { id: 'd1', text: 'متى سقط جدار برلين؟', expected: /1989|١٩٨٩/u, fact: '1989' },
  { id: 'd2', text: 'متى تأسست جامعة الدول العربية؟', expected: /1945|١٩٤٥/u, fact: '1945' },
  { id: 'd3', text: 'متى بدأت الحرب العالمية الثانية؟', expected: /1939|١٩٣٩/u, fact: '1939' },
  { id: 'd4', text: 'متى انتهت الحرب العالمية الأولى؟', expected: /1918|١٩١٨/u, fact: '1918' },
  { id: 'd5', text: 'متى استقلت الجزائر؟', expected: /1962|١٩٦٢/u, fact: '1962' },
  { id: 'd6', text: 'متى ولد نجيب محفوظ؟', expected: /1911|١٩١١/u, fact: '1911' },
  { id: 'e1', text: 'When did the Berlin Wall fall?', expected: /1989/u, fact: '1989' },
  { id: 'e2', text: 'When was the United Nations founded?', expected: /1945/u, fact: '1945' },
  { id: 'e3', text: 'When did World War II end?', expected: /1945/u, fact: '1945' },
  { id: 'p1', text: 'How many people live in Japan?', expected: /\b12[2-6](?:[.,]\d+)?\s*million|\b12[2-6],\d{3},\d{3}\b/iu, fact: '122–126 million' },
  { id: 'p2', text: 'How many people live in Egypt?', expected: /\b(?:10[4-9]|11\d)(?:[.,]\d+)?\s*million|\b(?:10[4-9]|11\d),\d{3},\d{3}\b/iu, fact: '104–119 million' },
  { id: 'p3', text: 'What is the population of France?', expected: /\b6[6-9](?:[.,]\d+)?\s*million|\b6[6-9],\d{3},\d{3}\b/iu, fact: '66–69 million' },
];

const argument = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
};
const modelsRoot = argument('models-root', '');
if (!modelsRoot) throw new Error('usage: council-questions.ts --models-root <folder with artifacts/>');
const python = argument('python', path.join(modelsRoot, '.venv-execution', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
const port = Number(argument('port', '4170'));
const out = argument('out', path.join('artifacts', 'council-2026-11-26'));
const setSha256 = createHash('sha256').update(JSON.stringify(QUESTIONS.map(({ id, text }) => ({ id, text })))).digest('hex');
const firstLine = (text: string) => text.split('\n').map(line => line.trim()).find(Boolean) ?? '';

await mkdir(out, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const fixture = await startMeasureFixture({ withWeb: false, apiPort: port, webPort: port - 1000,
  environment: { MOHASSAN_MODEL_COUNCIL: 'owner', MOHASSAN_MODELS_ROOT: modelsRoot, EXECUTOR_PYTHON: python } });
const client = new FixtureClient(fixture);
const rows: Record<string, unknown>[] = [];
const file = path.join(out, `council-questions-${stamp}.json`);
try {
  await client.signIn();
  for (const [at, question] of QUESTIONS.entries()) {
    if (at) await new Promise(resolve => setTimeout(resolve, 8_000));
    const seen = await observeRun(client, { text: question.text }, { pollMs: 300, timeoutMs: 180_000 });
    const detail = await client.call<ChatConversation>('GET', `/api/chat/conversations/${seen.conversationId}`);
    const reply = detail.messages.at(-1);
    const council: ModelCouncil | undefined = reply?.role === 'assistant' ? reply.council : undefined;
    const member = (id: string) => council?.members.find(item => item.round === 'answer' && item.model === id);
    const pipeline = member('pipeline')?.output ?? '';
    const reader = member('reading-v3-last');
    const sent = reply?.role === 'assistant' ? reply.text : '';
    const row = {
      id: question.id, text: question.text, fact: question.fact, status: seen.status, serverMs: seen.serverMs,
      councilMs: council?.elapsedMs ?? null, chosen: council?.chosen ?? null, changed: council?.changed ?? null,
      pipelineFirst: firstLine(pipeline), pipelineCorrect: question.expected.test(firstLine(pipeline)),
      sentFirst: firstLine(sent), sentCorrect: question.expected.test(firstLine(sent)),
      reader: reader ? { outcome: reader.outcome, output: reader.output ?? null, inEvidence: reader.inEvidence ?? null,
        correct: question.expected.test(reader.output ?? ''), elapsedMs: reader.elapsedMs } : null,
      searched: council?.members.some(item => item.round === 'search') ?? false,
      understanding: council?.members.filter(item => item.round === 'understanding').map(item => `${item.model}=${item.output ?? item.outcome}`) ?? [],
      reason: council?.reason ?? null,
    };
    rows.push(row);
    console.log(`${question.id} ${seen.status} ${seen.serverMs}ms council=${row.councilMs}ms chosen=${row.chosen} pipeline=${row.pipelineCorrect ? 'ok' : 'x'} sent=${row.sentCorrect ? 'ok' : 'x'} reader=${row.reader ? `${row.reader.outcome}:${row.reader.output}` : '—'} | ${row.sentFirst.slice(0, 90)}`);
  }
} finally {
  await fixture.stop().catch(() => {});
  const count = (key: 'pipelineCorrect' | 'sentCorrect') => rows.filter(row => row[key] === true).length;
  const summary = {
    questions: rows.length, pipelineCorrect: count('pipelineCorrect'), sentCorrect: count('sentCorrect'),
    changed: rows.filter(row => row.changed === true).length,
    readerAnswered: rows.filter(row => (row.reader as { outcome?: string } | null)?.outcome === 'ok').length,
    readerCorrect: rows.filter(row => (row.reader as { correct?: boolean } | null)?.correct === true).length,
    searched: rows.filter(row => row.searched === true).length,
  };
  await writeFile(file, JSON.stringify({ at: new Date().toISOString(), setSha256, modelsRoot, summary, rows }, null, 1));
  console.log(JSON.stringify({ file, summary }));
}
