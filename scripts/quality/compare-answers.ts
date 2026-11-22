/**
 * Two runs of the frozen real-question set side by side (scripts/quality/real-questions.ts outputs).
 * Usage: npx tsx scripts/quality/compare-answers.ts <before.jsonl> <after.jsonl>
 *
 * Mechanical facts only, no judgement of correctness: status changes, first-line changes, first lines that
 * are page metadata (answer-check.isMetaLine), replies in the wrong language, browser use, server time.
 * Writes <after>.compare.json next to the after file.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { checkAnswerLine, isMetaLine, questionLanguage, textLanguage } from '../../apps/server/src/assistant/answer-check.js';
import { stats } from '../perf/fixture.js';

const [before, after] = process.argv.slice(2);
if (!before || !after) throw new Error('usage: compare-answers.ts <before.jsonl> <after.jsonl>');
type Row = { id: string; text: string; reply: string | null; question: string | null; error: string | null; failure: string | null;
  auto: { status: string; asked: boolean; usedBrowser: boolean; sameLanguage: boolean | null } | null; timing: { serverMs: number | null; settleMs: number | null } | null; steps: string[] };
const load = async (file: string) => new Map((await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Row).map(row => [row.id, row]));
const a = await load(before), b = await load(after);
const ids = [...a.keys()].filter(id => b.has(id));
const firstLine = (row: Row) => (row.reply ?? '').split('\n').find(line => line.trim())?.trim() ?? '';
/** An honest refusal or «not found» is not an answer line; it is counted apart from answers. */
const ABSTAIN = /لم أجد|لم أتمكن|تعذر|لا أستطيع|لا يمكنني|لا مصدر|لم أنفّذ|لم أجرِ|لا أرسم|لا أشغّل|غير متاح|خارج القدرات|couldn['’]t|could not|can['’]t|cannot|unable|no (?:live )?source|not able|i found no|i do not|i don['’]t|outside/iu;
const ERROR_REPLY = /ENOENT|spawn |Error:|TypeError|exception/iu;
const facts = (rows: Row[]) => {
  const replied = rows.filter(row => row.reply);
  const answers = replied.filter(row => !row.auto?.asked && !ABSTAIN.test(firstLine(row)) && !ERROR_REPLY.test(firstLine(row)));
  const abstentions = replied.filter(row => !row.auto?.asked && ABSTAIN.test(firstLine(row)) && !ERROR_REPLY.test(firstLine(row)));
  const errors = replied.filter(row => ERROR_REPLY.test(firstLine(row)));
  const wrongLanguage = (list: Row[]) => list.filter(row => { const lang = textLanguage(firstLine(row)); return (lang === 'ar' || lang === 'en') && lang !== questionLanguage(row.text); }).length;
  return {
    n: rows.length,
    statuses: rows.reduce<Record<string, number>>((all, row) => ({ ...all, [row.auto?.status ?? 'unsettled']: (all[row.auto?.status ?? 'unsettled'] ?? 0) + 1 }), {}),
    failed: rows.filter(row => row.auto?.status === 'failed').length,
    usedBrowser: rows.filter(row => row.auto?.usedBrowser).length,
    answers: answers.length, abstentions: abstentions.length, asked: replied.filter(row => row.auto?.asked).length, errorReplies: errors.length,
    answersMetaFirstLine: answers.filter(row => isMetaLine(firstLine(row))).length,
    answersWrongLanguage: wrongLanguage(answers), abstentionsWrongLanguage: wrongLanguage(abstentions),
    answersFirstLineFailsCheck: answers.filter(row => !checkAnswerLine(row.text, firstLine(row)).ok).length,
    answersFailReasons: answers.flatMap(row => checkAnswerLine(row.text, firstLine(row)).reasons).reduce<Record<string, number>>((all, reason) => ({ ...all, [reason]: (all[reason] ?? 0) + 1 }), {}),
    errorIds: errors.map(row => row.id),
    serverMs: stats(rows.map(row => row.timing?.serverMs ?? null)),
  };
};
const beforeRows = ids.map(id => a.get(id)!), afterRows = ids.map(id => b.get(id)!);
const changed = ids.filter(id => firstLine(a.get(id)!) !== firstLine(b.get(id)!));
const statusChanges = ids.filter(id => a.get(id)!.auto?.status !== b.get(id)!.auto?.status).map(id => ({ id, text: a.get(id)!.text.slice(0, 60), before: a.get(id)!.auto?.status ?? 'unsettled', after: b.get(id)!.auto?.status ?? 'unsettled' }));
const result = {
  before: { file: before, ...facts(beforeRows) }, after: { file: after, ...facts(afterRows) },
  sharedIds: ids.length, firstLineChanged: changed.length, statusChanges,
  examples: changed.slice(0, 40).map(id => ({ id, text: a.get(id)!.text.slice(0, 70), before: firstLine(a.get(id)!).slice(0, 140), after: firstLine(b.get(id)!).slice(0, 140) })),
};
await writeFile(after.replace(/\.jsonl$/u, '.compare.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ before: result.before, after: result.after, firstLineChanged: result.firstLineChanged, statusChanges: result.statusChanges.length }, null, 1));
