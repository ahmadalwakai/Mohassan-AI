/**
 * The judge («الحَكَم») in shadow over the frozen real replies of 2026-11-22 (stage 4 of docs/BRAIN-PLAN-2026-11-16.md;
 * the owner's «ابدأ في الظل» of 2026-11-22). No reply anyone saw is changed; this records what the judge would have done.
 *
 * Usage: npx tsx scripts/judge/shadow.ts [--answers artifacts/plan-2026-11-22/real-answers-2026-11-22T02-17-34.jsonl] [--out artifacts/judge-2026-11-22]
 *
 * Reads the answers file as it is (it belongs to Phase 0) and writes under --out:
 *   shadow.json              every verdict; counts per decision, kind and code; the lead-vs-best margins; the comparison with reply-check's shadow
 *   alerts-for-review.jsonl  one line per reply the judge would fix, withhold or flag for review, with an empty `verdict` for the owner
 *   README.md                the tables (Arabic), the known cases checked one by one, and what was not measured
 * The frozen file holds no page texts, so the support check («every sentence from a source») is reported as not measured here.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { judge, JUDGE_THRESHOLDS, SEVERITY, type JudgeCode, type JudgeDecision, type JudgeVerdict, type ReplyKind } from '../../apps/server/src/assistant/judge.js';

const argument = (name: string, fallback: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback; };
const answersPath = path.resolve(argument('answers', path.join('artifacts', 'plan-2026-11-22', 'real-answers-2026-11-22T02-17-34.jsonl')));
const out = path.resolve(argument('out', path.join('artifacts', 'judge-2026-11-22')));
await mkdir(out, { recursive: true });

interface Row { id: string; kind: 'single' | 'pair'; previous: string | null; text: string; reply: string | null; auto?: { status?: string; usedBrowser?: boolean } }
const rows = (await readFile(answersPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Row);
const checked = rows.filter(row => typeof row.reply === 'string' && row.reply.trim());

const REPLY_CHECK_CODES = new Set<JudgeCode>(['language_mismatch', 'foreign_heading', 'byline_lead', 'site_chrome', 'duplicate_line', 'lead_without_answer']);
const DECISIONS: JudgeDecision[] = ['send', 'fix', 'withhold'];
const KINDS: ReplyKind[] = ['answer', 'quote', 'list', 'computed', 'memory', 'question', 'abstain', 'action', 'composed', 'fixed'];
const CODES = Object.keys(SEVERITY) as JudgeCode[];

interface Judged { id: string; question: string; previous: string | null; status: string | undefined; verdict: JudgeVerdict }
const judged: Judged[] = checked.map(row => ({ id: row.id, question: row.text, previous: row.previous, status: row.auto?.status,
  verdict: judge({ question: row.text, reply: row.reply!, status: row.auto?.status ?? null, previous: row.previous }) }));

const count = <T extends string>(keys: readonly T[], pick: (item: Judged) => T) => Object.fromEntries(keys.map(key => [key, judged.filter(item => pick(item) === key).length])) as Record<T, number>;
const decisions = count(DECISIONS, item => item.verdict.decision);
const kinds = count(KINDS, item => item.verdict.kind);
const decisionsByKind = Object.fromEntries(KINDS.map(kind => [kind, count(DECISIONS, item => item.verdict.kind === kind ? item.verdict.decision : ('-' as JudgeDecision))])) as Record<ReplyKind, Record<JudgeDecision, number>>;
// The severity each code actually carried in this run (a code can be downgraded, e.g. an Arabic subject word is review only).
const seenSeverity = (code: JudgeCode) => [...new Set(judged.flatMap(item => item.verdict.findings.filter(finding => finding.code === code).map(finding => finding.severity)))].join('/') || SEVERITY[code];
const perCode = Object.fromEntries(CODES.map(code => [code, { severity: seenSeverity(code), replies: judged.filter(item => item.verdict.codes.includes(code)).length,
  findings: judged.reduce((sum, item) => sum + item.verdict.findings.filter(finding => finding.code === code).length, 0),
  ids: judged.filter(item => item.verdict.codes.includes(code)).map(item => item.id) }])) as Record<JudgeCode, { severity: string; replies: number; findings: number; ids: string[] }>;

// Lead versus best among the sourced answers: how far behind the page-order lead sits. The margin threshold is the owner's to fix.
const sourcedAnswers = judged.filter(item => item.verdict.kind === 'answer' && item.verdict.sourced && item.verdict.lead && item.verdict.best);
const margins = sourcedAnswers.map(item => ({ id: item.id, margin: item.verdict.best!.score - item.verdict.lead!.score, lead: item.verdict.lead!, best: item.verdict.best! }));
const marginHistogram = { 0: margins.filter(m => m.margin === 0).length, 1: margins.filter(m => m.margin === 1).length, 2: margins.filter(m => m.margin === 2).length, '3+': margins.filter(m => m.margin >= 3).length };

// Timing: the judge must stay far below the reply itself (p50 of the server was 80 ms on the frozen run).
const ms = judged.map(item => item.verdict.ms).sort((a, b) => a - b);
const percentile = (p: number) => ms.length ? ms[Math.min(ms.length - 1, Math.ceil((p / 100) * ms.length) - 1)]! : 0;
const timing = { n: ms.length, p50: percentile(50), p95: percentile(95), max: ms[ms.length - 1] ?? 0 };

// What the judge adds over the pre-send reply check of E4.1 (8 of 91 flagged on 2026-11-22).
const replyCheckFlagged = new Set(judged.filter(item => item.verdict.codes.some(code => REPLY_CHECK_CODES.has(code))).map(item => item.id));
const judgeFlagged = new Set(judged.filter(item => item.verdict.codes.some(code => code !== 'evidence_unavailable')).map(item => item.id));
const comparison = { replyCheck: [...replyCheckFlagged].length, judge: [...judgeFlagged].length, judgeOnly: [...judgeFlagged].filter(id => !replyCheckFlagged.has(id)),
  blockedOrFixed: judged.filter(item => item.verdict.decision !== 'send').map(item => item.id) };

// The cases 0-baseline §8.3 and the design notes named, each expected to carry these codes.
const KNOWN: Record<string, { codes: JudgeCode[]; decision?: JudgeDecision }> = {
  rq016: { codes: ['lead_not_best'], decision: 'fix' }, rq018: { codes: ['duration_unit_missing'], decision: 'withhold' }, rq037: { codes: ['self_question_from_web'], decision: 'withhold' },
  rq019: { codes: ['fragment_lead', 'definition_form_missing'] }, rq006: { codes: ['fragment_lead'] }, rq013: { codes: ['fragment_lead'] }, rq015: { codes: ['fragment_lead'] },
  rq010: { codes: ['byline_lead', 'site_chrome', 'foreign_heading', 'lead_not_best'], decision: 'fix' }, rq028: { codes: ['fragment_lead', 'definition_form_missing', 'foreign_heading'], decision: 'fix' },
  rq084: { codes: ['local_intent_abstained'] }, rq022: { codes: ['language_mismatch'] }, rq020: { codes: ['fragment_lead', 'language_mismatch'] },
};
const CLEAN = ['rq005', 'rq008', 'rq023', 'rq025', 'rq027', 'rq029', 'rq026', 'rq075', 'rq012', 'rq024', 'rq073', 'rq077', 'rq095', 'rq002', 'rq066'];
const byId = new Map(judged.map(item => [item.id, item]));
const known = Object.entries(KNOWN).map(([id, expected]) => {
  const item = byId.get(id);
  const got = item?.verdict.codes ?? [];
  return { id, expected: expected.codes, expectedDecision: expected.decision ?? null, got, decision: item?.verdict.decision ?? null,
    ok: expected.codes.every(code => got.includes(code)) && (!expected.decision || item?.verdict.decision === expected.decision) };
});
const clean = CLEAN.map(id => { const item = byId.get(id); const got = (item?.verdict.codes ?? []).filter(code => code !== 'evidence_unavailable'); return { id, got, decision: item?.verdict.decision ?? null, ok: got.length === 0 && item?.verdict.decision === 'send' }; });

// The owner's verdicts live in their own file, which this script only reads (owner-verdicts.jsonl, one line per judged alert).
// A verdict carries over to this run when the alert's decision is the same and every code the owner saw is still there;
// otherwise the alert is marked as changed since the verdict and waits for a new one.
interface OwnerVerdict { id: string; decision: JudgeDecision; codes: string[]; verdict: 'correct' | 'wrong'; verdictBy: string; verdictAt: string; note?: string }
const ownerVerdicts = new Map<string, OwnerVerdict>();
try {
  for (const line of (await readFile(path.join(out, 'owner-verdicts.jsonl'), 'utf8')).split('\n').filter(Boolean)) { const verdict = JSON.parse(line) as OwnerVerdict; ownerVerdicts.set(verdict.id, verdict); }
} catch { /* no verdicts yet */ }
const carried = (id: string, decision: JudgeDecision, codes: readonly string[]) => {
  const owner = ownerVerdicts.get(id);
  if (!owner) return { verdict: null, verdictBy: null, verdictAt: null, changedSinceVerdict: false };
  const same = owner.decision === decision && owner.codes.every(code => codes.includes(code));
  return same ? { verdict: owner.verdict, verdictBy: owner.verdictBy, verdictAt: owner.verdictAt, changedSinceVerdict: false }
    : { verdict: null, verdictBy: null, verdictAt: null, changedSinceVerdict: true, previousVerdict: owner };
};
const alerts = judged.filter(item => item.verdict.decision !== 'send' || item.verdict.codes.some(code => code !== 'evidence_unavailable')).map(item => ({
  id: item.id, question: item.question, previous: item.previous, status: item.status, kind: item.verdict.kind, decision: item.verdict.decision, codes: item.verdict.codes,
  findings: item.verdict.findings, lead: item.verdict.lead, best: item.verdict.best, fixedReply: item.verdict.fixedReply, withholdText: item.verdict.withholdText,
  ...carried(item.id, item.verdict.decision, item.verdict.codes), note: null }));
const judgedNow = alerts.filter(alert => alert.verdict);
const verdictSummary = { alerts: alerts.length, judged: judgedNow.length, correct: judgedNow.filter(alert => alert.verdict === 'correct').length,
  changedSinceVerdict: alerts.filter(alert => alert.changedSinceVerdict).map(alert => alert.id), unjudged: alerts.filter(alert => !alert.verdict && !alert.changedSinceVerdict).map(alert => alert.id),
  verdictsNoLongerAlerts: [...ownerVerdicts.keys()].filter(id => !alerts.some(alert => alert.id === id)) };

const summary = {
  at: new Date().toISOString(), answers: path.relative(process.cwd(), answersPath).replaceAll('\\', '/'), rows: rows.length, repliesJudged: judged.length,
  decisions, kinds, decisionsByKind, perCode, sourcedAnswers: sourcedAnswers.length, marginHistogram, margins, timing, comparisonWithReplyCheck: comparison, knownCases: known, cleanCases: clean, ownerVerdicts: verdictSummary,
  notMeasured: ['support (unsupported_sentence): the frozen file holds no page texts; measured only in the live shadow once evidence is passed'],
  thresholds: { note: 'proposed, not fixed by the owner', ...JUDGE_THRESHOLDS },
};
await writeFile(path.join(out, 'shadow.json'), `${JSON.stringify({ ...summary, verdicts: judged.map(item => ({ id: item.id, ...item.verdict })) }, null, 2)}\n`);
await writeFile(path.join(out, 'alerts-for-review.jsonl'), alerts.map(alert => JSON.stringify(alert)).join('\n') + '\n');

const AR_DECISION: Record<JudgeDecision, string> = { send: 'يُرسل', fix: 'يُصلح آليًا', withhold: 'يُحجب' };
const table = (header: string[], body: string[][]) => [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...body.map(row => `| ${row.join(' | ')} |`)].join('\n');
const readme = `# الحَكَم في وضع الظل: الردود الحقيقية المجمّدة

قِيس في ${summary.at} على \`${summary.answers}\`: ${summary.rows} صفًا، منها ${judged.length} ردًا يُحكم عليه. لم يتغير أي رد رآه أحد.

## القرار

${table(['القرار', 'عدد الردود'], DECISIONS.map(decision => [`${decision} (${AR_DECISION[decision]})`, String(decisions[decision])]))}

## القرار حسب نوع الرد

${table(['النوع', 'الردود', 'send', 'fix', 'withhold'], KINDS.filter(kind => kinds[kind]).map(kind => [kind, String(kinds[kind]), String(decisionsByKind[kind].send), String(decisionsByKind[kind].fix), String(decisionsByKind[kind].withhold)]))}

## الرموز

${table(['الرمز', 'الشدة', 'ردود', 'ملاحظات', 'المعرّفات'], CODES.filter(code => perCode[code].replies).map(code => [code, perCode[code].severity, String(perCode[code].replies), String(perCode[code].findings), perCode[code].ids.join(', ')]))}

## السطر الأول مقابل أفضل سطر (الأجوبة الموثّقة بمصدر: ${sourcedAnswers.length})

الفارق = درجة أفضل سطر − درجة السطر الأول. الحد المقترح للترقية ${JUDGE_THRESHOLDS.leadNotBestMargin}، والقرار للمالك.

${table(['الفارق', 'عدد الأجوبة'], Object.entries(marginHistogram).map(([margin, n]) => [margin, String(n)]))}

${table(['المعرّف', 'الفارق', 'السطر الأول', 'أفضل سطر'], margins.filter(m => m.margin >= 1).sort((a, b) => b.margin - a.margin).map(m => [m.id, String(m.margin), `${m.lead.score}: ${m.lead.text.slice(0, 70)}`, `${m.best.score}: ${m.best.text.slice(0, 70)}`]))}

## الزمن

${table(['n', 'p50 ms', 'p95 ms', 'max ms'], [[String(timing.n), String(timing.p50), String(timing.p95), String(timing.max)]])}

## مقابل فاحص الرد (E4.1)

فاحص الرد وحده يعلّم ${comparison.replyCheck} ردًا؛ الحَكَم يعلّم ${comparison.judge} ردًا، منها ${comparison.judgeOnly.length} لا يراها الفاحص: ${comparison.judgeOnly.join(', ') || '—'}.
الردود التي كان الحَكَم سيغيّرها (إصلاح أو حجب): ${comparison.blockedOrFixed.length}: ${comparison.blockedOrFixed.join(', ') || '—'}.

## الحالات المعروفة

${table(['المعرّف', 'المتوقع', 'الموجود', 'القرار', 'صحيح'], known.map(item => [item.id, item.expected.join(', ') + (item.expectedDecision ? ` → ${item.expectedDecision}` : ''), item.got.filter(code => code !== 'evidence_unavailable').join(', ') || '—', item.decision ?? '—', item.ok ? 'نعم' : 'لا']))}

${table(['المعرّف', 'المتوقع', 'الموجود', 'القرار', 'صحيح'], clean.map(item => [item.id, 'لا رموز، send', item.got.join(', ') || '—', item.decision ?? '—', item.ok ? 'نعم' : 'لا']))}

## ما لم يُقَس

- السند (unsupported_sentence): الملف المجمّد لا يحمل نصوص الصفحات، فلم يُقَس هنا. يُقاس في الظل الحي حين يمرّر المضيف الأدلة.
- ما فات الحَكَم (recall): يحتاج وسوم المالك على الردود كلها، لا على التنبيهات وحدها.

## أحكام المالك

تُقرأ من \`owner-verdicts.jsonl\` (لا يكتب هذا السكربت فوقه). على هذا التشغيل: ${verdictSummary.judged} من ${verdictSummary.alerts} تنبيهًا عليها حكم، صحيح منها ${verdictSummary.correct}.
تغيّر منذ الحكم (ينتظر حكمًا جديدًا): ${verdictSummary.changedSinceVerdict.join(', ') || '—'}. بلا حكم بعد: ${verdictSummary.unjudged.join(', ') || '—'}. أحكام لم تعد تنبيهًا: ${verdictSummary.verdictsNoLongerAlerts.join(', ') || '—'}.

## للمالك

كل حدّ هنا مقترح: هامش الترقية ${JUDGE_THRESHOLDS.leadNotBestMargin}، وطول السطر المقطوع ${JUDGE_THRESHOLDS.fragmentMaxWords} كلمة، وأدنى طول جملة تُقارن بالأدلة ${JUDGE_THRESHOLDS.supportMinChars} محرفًا.
`;
await writeFile(path.join(out, 'README.md'), readme);
console.log(readme);
