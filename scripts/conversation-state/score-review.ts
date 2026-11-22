/**
 * Scores the owner's review sheet (review-sheet.ts): how often each reading was right on the owner's own messages, with Wilson
 * 95% intervals and the exact McNemar test on the messages where only one reading was right.
 *
 * Usage: npx tsx scripts/conversation-state/score-review.ts <…/review-…/REVIEW-AR.md> [--answers "1 v2، 2 كلاهما، 3 v1"]
 * Verdicts come from the sheet's «الحكم:» lines and, when given, from --answers (which win where both exist).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseAnswers, parseSheet, scoreReview, wilson, type ReviewItem, type Verdict } from './review-format.js';

const args = process.argv.slice(2);
const answersAt = args.indexOf('--answers');
const answers = answersAt >= 0 ? args[answersAt + 1] ?? '' : '';
const sheetPath = args.find((arg, index) => !arg.startsWith('--') && index !== answersAt + 1);
if (!sheetPath) { console.log('usage: npx tsx scripts/conversation-state/score-review.ts <REVIEW-AR.md> [--answers "1 v2، 2 كلاهما"]'); process.exit(1); }

const markdown = await readFile(sheetPath, 'utf8');
const { items } = JSON.parse(await readFile(join(dirname(sheetPath), 'items.json'), 'utf8')) as { items: ReviewItem[] };
const verdicts = new Map<number, Verdict>([...parseSheet(markdown), ...parseAnswers(answers)].filter(([number]) => items.some(item => item.number === number)));
const score = scoreReview(items.length, verdicts);
const n = score.answered;
const pct = (k: number) => n ? `${(100 * k / n).toFixed(1)}%` : 'n/a';
const range = (k: number) => { const [low, high] = wilson(k, n); return `${(100 * low).toFixed(1)}–${(100 * high).toFixed(1)}%`; };
const wrongForV2 = items.filter(item => verdicts.get(item.number) === 'v1' || verdicts.get(item.number) === 'neither');

const at = new Date().toISOString();
const report = `# نتيجة مراجعة المالك: v1 مقابل v2 على رسائله الحقيقية

| | |
|---|---|
| وقت الحساب | ${at} |
| الورقة | \`${sheetPath}\` |
| الرسائل المحكوم عليها | ${n} من ${score.items} |

| | العدد |
|---|---|
| v2 وحده صحيح | ${score.counts.v2} |
| v1 وحده صحيح | ${score.counts.v1} |
| كلاهما صحيح | ${score.counts.both} |
| لا أحد | ${score.counts.neither} |

| | صحيح | Wilson 95% |
|---|---|---|
| v2 | ${score.v2Right}/${n} = ${pct(score.v2Right)} | ${range(score.v2Right)} |
| v1 | ${score.v1Right}/${n} = ${pct(score.v1Right)} | ${range(score.v1Right)} |

McNemar الدقيق على الرسائل التي صحّت فيها قراءة واحدة: v2 وحده ${score.mcnemar.b}، v1 وحده ${score.mcnemar.c}، **p = ${score.mcnemar.p.toPrecision(3)}**.

العينة هي الرسائل التي اختلفت فيها القراءتان فقط، فهذه النسب تقيس الفرق بينهما لا دقة كل منهما على كل الرسائل.

## حيث أخطأ v2 (${wrongForV2.length})

${wrongForV2.map(item => `- ${item.number}. «${item.text.replace(/\s+/gu, ' ').slice(0, 120)}» (${verdicts.get(item.number) === 'v1' ? 'v1 صحيح' : 'لا أحد'})`).join('\n') || 'لا شيء.'}
`;
const outFile = join(dirname(sheetPath), `scores-${at.replace(/[:.]/gu, '-')}.md`);
await writeFile(outFile, report, 'utf8');
await writeFile(outFile.replace(/\.md$/u, '.json'), JSON.stringify({ at, sheet: sheetPath, score, verdicts: Object.fromEntries(verdicts) }, null, 2), 'utf8');
console.log(report);
console.log(`written: ${outFile}`);
