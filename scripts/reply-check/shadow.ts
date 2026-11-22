/**
 * E4.1 in shadow (docs/RESPONSE-QUALITY-PLAN-2026-11-22.md, Phase 4): the pre-send reply check over the frozen real
 * replies of 2026-11-22, without changing a reply anyone saw.
 *
 * Usage: npx tsx scripts/reply-check/shadow.ts [--answers artifacts/plan-2026-11-22/real-answers-2026-11-22T02-17-34.jsonl] [--out artifacts/reply-check-2026-11-22]
 *
 * Reads the answers file as it is (it belongs to Phase 0) and writes under --out:
 *   shadow.json              counts per code and severity, the agreement with Phase 0's sameLanguage flag, every finding
 *   alerts-for-review.jsonl  one line per flagged reply with the proposed fixed text and an empty `verdict` for the owner
 *   README.md                the tables, and the known cases of 0-baseline §8.3 checked one by one
 * The owner's verdicts (correct | wrong) decide E4.1: 90% of 30 alerts correct is the proposed bar.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyReplyFixes, checkReply, type ReplyFinding, type ReplyFindingCode } from '../../apps/server/src/assistant/reply-check.js';

const argument = (name: string, fallback: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback; };
const answersPath = path.resolve(argument('answers', path.join('artifacts', 'plan-2026-11-22', 'real-answers-2026-11-22T02-17-34.jsonl')));
const out = path.resolve(argument('out', path.join('artifacts', 'reply-check-2026-11-22')));
await mkdir(out, { recursive: true });

interface Row { id: string; text: string; reply: string | null; auto?: { sameLanguage?: boolean | null; status?: string } }
const rows = (await readFile(answersPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Row);
const checked = rows.filter(row => typeof row.reply === 'string' && row.reply.trim());

const CODES: ReplyFindingCode[] = ['language_mismatch', 'foreign_heading', 'byline_lead', 'site_chrome', 'duplicate_line', 'lead_without_answer'];
const perCode = Object.fromEntries(CODES.map(code => [code, { replies: 0, findings: 0 }])) as Record<ReplyFindingCode, { replies: number; findings: number }>;
const alerts: { id: string; question: string; status: string | undefined; codes: ReplyFindingCode[]; findings: ReplyFinding[]; proposedFix: string | null; verdict: null; note: null }[] = [];
let fixable = 0, reviewOnly = 0;
for (const row of checked) {
  const input = { question: row.text, reply: row.reply! };
  const check = checkReply(input);
  if (!check.findings.length) continue;
  const codes = [...new Set(check.findings.map(finding => finding.code))];
  for (const code of codes) perCode[code].replies++;
  for (const finding of check.findings) perCode[finding.code].findings++;
  const hasFix = check.findings.some(finding => finding.severity === 'fix');
  if (hasFix) fixable++; else reviewOnly++;
  alerts.push({ id: row.id, question: row.text, status: row.auto?.status, codes, findings: check.findings, proposedFix: hasFix ? applyReplyFixes(input, check) : null, verdict: null, note: null });
}

// Agreement with Phase 0's automatic flag (scripts/quality/real-answers-facts.ts, `sameLanguage`).
const phase0Mismatch = new Set(checked.filter(row => row.auto?.sameLanguage === false).map(row => row.id));
const mine = new Set(alerts.filter(alert => alert.codes.includes('language_mismatch') || alert.codes.includes('foreign_heading')).map(alert => alert.id));
const agreement = { phase0Only: [...phase0Mismatch].filter(id => !mine.has(id)), checkerOnly: [...mine].filter(id => !phase0Mismatch.has(id)), both: [...mine].filter(id => phase0Mismatch.has(id)) };

// The known cases of 0-baseline §8.3, each expected to carry these codes.
const KNOWN: Record<string, ReplyFindingCode[]> = { rq010: ['byline_lead', 'site_chrome', 'foreign_heading'], rq028: ['foreign_heading'], rq036: ['foreign_heading'], rq064: ['foreign_heading', 'site_chrome'], rq090: ['foreign_heading', 'site_chrome'], rq022: ['language_mismatch'], rq097: ['language_mismatch'] };
const CLEAN: string[] = ['rq012', 'rq024', 'rq078'];
const known = Object.entries(KNOWN).map(([id, expected]) => { const got = alerts.find(alert => alert.id === id)?.codes ?? []; return { id, expected, got, ok: expected.every(code => got.includes(code)) }; });
const clean = CLEAN.map(id => ({ id, got: alerts.find(alert => alert.id === id)?.codes ?? [], ok: !alerts.some(alert => alert.id === id && alert.codes.includes('language_mismatch')) }));

const summary = { at: new Date().toISOString(), answers: path.relative(process.cwd(), answersPath), rows: rows.length, repliesChecked: checked.length, repliesFlagged: alerts.length,
  repliesWithFixableFinding: fixable, repliesReviewOnly: reviewOnly, perCode, agreementWithPhase0SameLanguage: agreement, knownCases: known, cleanCases: clean,
  thresholds: { note: 'proposed, not fixed by the owner', arabicShareInEnglishReply: 0.5, latinShareInArabicReply: 0.8, minWordsForLanguage: 4 } };
await writeFile(path.join(out, 'shadow.json'), `${JSON.stringify({ ...summary, alerts }, null, 2)}\n`);
await writeFile(path.join(out, 'alerts-for-review.jsonl'), alerts.map(alert => JSON.stringify(alert)).join('\n') + '\n');

const codeTable = ['| code | replies | findings | severity |', '|---|---|---|---|', ...CODES.map(code => `| ${code} | ${perCode[code].replies} | ${perCode[code].findings} | ${code === 'language_mismatch' || code === 'lead_without_answer' ? 'review' : 'fix'} |`)].join('\n');
const knownTable = ['| id | expected | found | ok |', '|---|---|---|---|', ...known.map(item => `| ${item.id} | ${item.expected.join(', ')} | ${item.got.join(', ') || '—'} | ${item.ok ? 'yes' : 'NO'} |`),
  ...clean.map(item => `| ${item.id} | no language_mismatch | ${item.got.join(', ') || '—'} | ${item.ok ? 'yes' : 'NO'} |`)].join('\n');
const readme = `# Pre-send reply check, shadow run (E4.1)

Measured ${summary.at} over \`${summary.answers}\`: ${summary.rows} rows, ${summary.repliesChecked} with a reply.

| | |
|---|---|
| replies flagged | ${alerts.length} of ${checked.length} |
| with a mechanical fix proposed | ${fixable} |
| review only | ${reviewOnly} |

${codeTable}

Agreement with Phase 0's \`sameLanguage=false\` (${phase0Mismatch.size} rows): both ${agreement.both.length} (${agreement.both.join(', ') || '—'}); Phase 0 only ${agreement.phase0Only.length} (${agreement.phase0Only.join(', ') || '—'}); checker only ${agreement.checkerOnly.length} (${agreement.checkerOnly.join(', ') || '—'}).

## Known cases of 0-baseline §8.3

${knownTable}

## For the owner

\`alerts-for-review.jsonl\` holds every flagged reply with its findings and the proposed fixed text. Fill \`verdict\` with \`correct\` or \`wrong\` per line; E4.1 proposes 90% correct over 30 alerts before the checker leaves shadow mode. Thresholds in this run are proposed: Arabic share ≥ 0.5 in an English reply, Latin share ≥ 0.8 in an Arabic reply, at least 4 words.
`;
await writeFile(path.join(out, 'README.md'), readme);
console.log(readme);
