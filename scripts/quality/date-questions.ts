/**
 * Date questions («متى سقط جدار برلين؟») and English population questions, asked live through an isolated server.
 *
 * Usage: npx tsx scripts/quality/date-questions.ts [--port 4150] [--judge off] [--ids d1,e2] [--out artifacts/plan-2026-11-22]
 *
 * The frozen 107-question set (real-questions.ts) holds no «متى» or "when" question and no English population question, so a
 * change to how those are answered is measured here. The set below was fixed on 2026-11-22 at 13:45 UTC, before any change it
 * measures; later runs use it unchanged. Questions are spaced 8 s apart: Wikipedia answered HTTP 429 to quick successions from
 * this machine on 2026-11-22. One JSON per run: date-questions-<stamp>.json with the first line, source, steps and timing.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FixtureClient, observeRun, startMeasureFixture } from '../perf/fixture.js';

const QUESTIONS: { id: string; text: string }[] = [
  { id: 'd1', text: 'متى سقط جدار برلين؟' },
  { id: 'd2', text: 'متى تأسست جامعة الدول العربية؟' },
  { id: 'd3', text: 'متى بدأت الحرب العالمية الثانية؟' },
  { id: 'd4', text: 'متى انتهت الحرب العالمية الأولى؟' },
  { id: 'd5', text: 'متى استقلت الجزائر؟' },
  { id: 'd6', text: 'متى ولد نجيب محفوظ؟' },
  { id: 'e1', text: 'When did the Berlin Wall fall?' },
  { id: 'e2', text: 'When was the United Nations founded?' },
  { id: 'e3', text: 'When did World War II end?' },
  { id: 'p1', text: 'How many people live in Japan?' },
  { id: 'p2', text: 'How many people live in Egypt?' },
  { id: 'p3', text: 'What is the population of France?' },
];

const argument = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
};
const port = Number(argument('port', '4150'));
const out = argument('out', 'artifacts/plan-2026-11-22');
const judgeOff = argument('judge', 'on') === 'off';
const ids = argument('ids', '').split(',').filter(Boolean);
const chosen = ids.length ? QUESTIONS.filter(question => ids.includes(question.id)) : QUESTIONS;
const setSha256 = createHash('sha256').update(JSON.stringify(QUESTIONS)).digest('hex');

await mkdir(out, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const fixture = await startMeasureFixture({ withWeb: false, apiPort: port, webPort: port - 1000,
  ...(judgeOff ? { environment: { MOHASSAN_JUDGE_FIX: '0', MOHASSAN_JUDGE_WITHHOLD: '0' } } : {}) });
const client = new FixtureClient(fixture);
const rows: unknown[] = [];
const file = path.join(out, `date-questions-${stamp}.json`);
try {
  await client.signIn();
  for (const [at, question] of chosen.entries()) {
    if (at) await new Promise(resolve => setTimeout(resolve, 8_000));
    const seen = await observeRun(client, { text: question.text }, { pollMs: 300, timeoutMs: 120_000 });
    const answer = (seen as { answer?: string | null }).answer ?? '';
    const source = decodeURIComponent(answer.match(/\*\*(?:المصدر|Source):\*\*\s*\[([^\]]+)\]/u)?.[1] ?? '');
    const first = answer.split('\n').map(line => line.trim()).find(Boolean) ?? (seen as { error?: string }).error ?? '';
    rows.push({ id: question.id, text: question.text, status: seen.status, serverMs: seen.serverMs, first, source, answer, steps: (seen.steps ?? []).map(step => step.text) });
    console.log(`${question.id} ${seen.status} ${seen.serverMs}ms | ${question.text} | ${first.slice(0, 110)} | ${source}`);
  }
} finally {
  await fixture.stop().catch(() => {});
  await writeFile(file, JSON.stringify({ at: new Date().toISOString(), setSha256, judge: judgeOff ? 'off' : 'on', rows }, null, 1));
  console.log(JSON.stringify({ file }));
}
