/**
 * Mechanical facts about one real-answers file (scripts/quality/real-questions.ts output). No correctness judgement:
 * accuracy and «wrong answer shown» come only from the owner's labels.
 * Usage: npx tsx scripts/quality/real-answers-facts.ts artifacts/plan-2026-11-22/real-answers-<stamp>.jsonl
 *
 * Language: a text's language is the majority of its Arabic vs Latin letters, URLs and markdown removed;
 * replies with fewer than 15 letters (numbers, «345») are not judged. «Arabic header in an English reply»
 * counts English questions whose reply contains the fixed Arabic heading «تفاصيل أخرى من نفس المصدر».
 */
import { readFile, writeFile } from 'node:fs/promises';
import { stats } from '../perf/fixture.js';

const file = process.argv[2];
if (!file) throw new Error('usage: real-answers-facts.ts <real-answers-*.jsonl>');
type Row = { id: string; kind: 'single' | 'pair'; text: string; previous: string | null; reply: string | null; question: string | null; error: string | null; failure: string | null;
  auto: { status: string; asked: boolean; cardFields: number; usedBrowser: boolean; hasLink: boolean; abstainPhrase: boolean } | null;
  timing: { settleMs: number | null; serverMs: number | null; browserVisibleMs: number | null } | null; steps: string[] };
const rows = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Row);
const letters = (text: string) => {
  const plain = text.replace(/https?:\/\/\S+/gu, ' ').replace(/[*_#>`[\]()]/gu, ' ');
  return { ar: (plain.match(/\p{Script=Arabic}/gu) ?? []).length, la: (plain.match(/[A-Za-z]/gu) ?? []).length };
};
const language = (text: string): 'ar' | 'en' | null => { const count = letters(text); return count.ar + count.la < 15 ? null : count.ar >= count.la ? 'ar' : 'en'; };
const settled = rows.filter(row => row.auto);
const count = (pick: (row: Row) => boolean) => settled.filter(pick).length;
const share = (value: number, total = settled.length) => total ? Number((value / total).toFixed(3)) : null;
const judged = settled.filter(row => row.reply && language(row.reply) && language(row.text));
const mismatch = judged.filter(row => language(row.reply!) !== language(row.text));
const englishQuestions = settled.filter(row => language(row.text) === 'en' && row.reply);
const mixedHeader = englishQuestions.filter(row => row.reply!.includes('تفاصيل أخرى من نفس المصدر'));
const failures = settled.filter(row => row.auto!.status === 'failed');
const failureMessages = Object.entries(failures.reduce<Record<string, number>>((all, row) => { const key = (row.error ?? '').slice(0, 90); return { ...all, [key]: (all[key] ?? 0) + 1 }; }, {})).sort((a, b) => b[1] - a[1]);
const statuses = settled.reduce<Record<string, number>>((all, row) => ({ ...all, [row.auto!.status]: (all[row.auto!.status] ?? 0) + 1 }), {});
const kinds = (kind: Row['kind']) => settled.filter(row => row.kind === kind);
const facts = {
  file, items: rows.length, settled: settled.length, notSettled: rows.length - settled.length,
  statuses,
  failed: { count: failures.length, share: share(failures.length), messages: failureMessages, ids: failures.map(row => row.id) },
  asked: { count: count(row => row.auto!.asked), share: share(count(row => row.auto!.asked)), cardFields: stats(settled.filter(row => row.auto!.asked).map(row => row.auto!.cardFields)),
    ids: settled.filter(row => row.auto!.asked).map(row => row.id) },
  usedBrowser: { count: count(row => row.auto!.usedBrowser), share: share(count(row => row.auto!.usedBrowser)) },
  replyWithLink: { count: count(row => row.auto!.hasLink), share: share(count(row => row.auto!.hasLink)) },
  abstainPhrase: { count: count(row => row.auto!.abstainPhrase), share: share(count(row => row.auto!.abstainPhrase)) },
  language: { judged: judged.length, replyInOtherLanguage: mismatch.length, ids: mismatch.map(row => row.id),
    englishQuestions: englishQuestions.length, arabicHeaderInEnglishReply: mixedHeader.length, mixedIds: mixedHeader.map(row => row.id) },
  timing: {
    single: { settleMs: stats(kinds('single').map(row => row.timing?.settleMs ?? null)), serverMs: stats(kinds('single').map(row => row.timing?.serverMs ?? null)) },
    pairSecondTurn: { settleMs: stats(kinds('pair').map(row => row.timing?.settleMs ?? null)), serverMs: stats(kinds('pair').map(row => row.timing?.serverMs ?? null)) },
    browserVisibleMs: stats(settled.map(row => row.timing?.browserVisibleMs ?? null)),
  },
};
await writeFile(file.replace(/\.jsonl$/u, '.facts.json'), JSON.stringify(facts, null, 2));
console.log(JSON.stringify(facts, null, 1));
