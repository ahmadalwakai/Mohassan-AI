/**
 * Summarises the retained judge shadow log, including rotated archives next to the active file.
 * Usage: npx tsx scripts/judge/shadow-report.ts [--log .data/judge/shadow.jsonl] [--last 20]
 *        [--days N | --since YYYY-MM-DD] [--json]
 * --days includes today and the previous N-1 UTC calendar days. --since accepts a date or ISO
 * timestamp with a time zone. Both windows include their start.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { summarizeJudgeShadow } from './shadow-summary.js';

function printCounts(label: string, counts: Record<string, number>) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  console.log(`${label}  ${entries.map(([key, n]) => `${key} (${n})`).join('، ') || '—'}`);
}

try {
  const { values } = parseArgs({ options: {
    log: { type: 'string', default: path.join('.data', 'judge', 'shadow.jsonl') },
    last: { type: 'string', default: '20' },
    days: { type: 'string' },
    since: { type: 'string' },
    json: { type: 'boolean' },
  } });
  const logPath = path.resolve(values.log);
  const { summary, recent } = await summarizeJudgeShadow(logPath, {
    days: values.days === undefined ? undefined : Number(values.days), since: values.since,
    last: values.json ? 0 : Number(values.last),
  });

  if (values.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else if (!summary.all.total) {
    console.log(`لا توجد أحكام في السجل المحتفظ به ضمن الفترة المحددة في ${logPath}.`);
  } else {
    console.log(`سجل الحَكَم الحي، ${summary.all.total} ردًا من ${summary.from} إلى ${summary.to}`);
    const groups = [
      ['كل الردود', summary.all], ['ردود احتُفظ بنصها', summary.textKept], ['ردود حُذف نصها من السجل', summary.textOmitted],
    ] as const;
    for (const [name, group] of groups) {
      console.log(`\n${name} (${group.total}، طُبّق حكم الحَكَم على ${group.applied})`);
      printCounts('القرار', group.decision);
      printCounts('النوع', group.kind);
      printCounts('رموز الحَكَم (ردود)', group.code);
      printCounts('مصدر الرد', group.origin);
      const review = group.conversationReview;
      console.log(`مراجعة المحادثة، ${review.total} ردًا وطُبّقت المراجعة على ${review.applied}`);
      printCounts('إجراء المراجعة', review.action);
      printCounts('فحوص المراجعة (ملاحظات)', review.check);
      printCounts('رموز المراجعة (ملاحظات)', review.code);
    }
    const { latency, support } = summary;
    console.log(`\nالزمن، p50 ${latency.p50} ms، p95 ${latency.p95} ms، max ${latency.max} ms`);
    console.log(`\nالسند، ${support.repliesWithEvidence} ردًا مع أدلة، ووُجدت ${support.supported} من ${support.sentences} جملة في الأدلة`);
    if (recent.length) {
      console.log(`\nآخر ${recent.length} أحكام`);
      for (const line of recent) {
        const codes = line.codes.filter(code => code !== 'evidence_unavailable').join(',') || '-';
        console.log(`  ${line.at} ${line.decision.padEnd(8)} ${line.kind.padEnd(9)} ${line.origin} ${codes} | ${line.question.slice(0, 60).replace(/\s+/gu, ' ')}`);
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
