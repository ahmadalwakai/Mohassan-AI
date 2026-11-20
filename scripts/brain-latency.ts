import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { brainLabCategories, type BrainLabCategory } from '../packages/learning/src/brain-lab.js';

const statusPath = 'artifacts/brain-lab/status.json';
const writeMethods = ['addStep', 'setProgress', 'saveState'] as const;
type WriteMethod = (typeof writeMethods)[number];
type BudgetName = 'local' | 'site' | 'research';
const budgetCategories: Record<BudgetName, readonly BrainLabCategory[]> = {
  local: ['routing', 'compute', 'memory', 'limits'],
  site: ['site_check'],
  research: ['research'],
};

const writesSchema = z.object({ addStep: z.int().nonnegative(), setProgress: z.int().nonnegative(), saveState: z.int().nonnegative() });
const developmentReportSchema = z.object({
  command: z.string(),
  startedUtc: z.string(),
  endedUtc: z.string(),
  split: z.literal('development'),
  mind: z.literal('on'),
  gpuLockAtStart: z.boolean(),
  gpuLockAtEnd: z.boolean(),
  rows: z.array(z.object({
    id: z.string(),
    category: z.enum(brainLabCategories),
    language: z.enum(['ar', 'en']),
    status: z.string(),
    elapsedMs: z.number().nonnegative(),
    gpuLockAtStart: z.boolean(),
    gpuLockAtEnd: z.boolean(),
    judgment: z.object({ passed: z.boolean(), failures: z.array(z.string()), violations: z.array(z.string()) }),
    writes: writesSchema,
    writeQueries: z.array(z.object({ method: z.enum(writeMethods) })),
  })).nonempty(),
});
type Report = z.infer<typeof developmentReportSchema>;
type Row = Report['rows'][number];

const limitSchema = z.object({ median: z.number().positive(), p95: z.number().positive(), max: z.number().positive().optional() });
const statusSchema = z.object({ ownerAcceptance: z.object({ speedBudgetsMs: z.object({
  local: limitSchema, site: limitSchema, research: limitSchema,
}) }) });

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''));
}

function readDevelopmentReport(path: string): Report {
  const resolved = realpathSync(path);
  if (basename(resolved) !== 'report.json' || !basename(dirname(resolved)).endsWith('-development-mind-on')) {
    throw new Error(`Expected a development report with mind enabled: ${path}`);
  }
  const report = developmentReportSchema.parse(readJson(resolved));
  if (new Set(report.rows.map(row => row.id)).size !== report.rows.length) {
    throw new Error(`Duplicate development case IDs: ${path}`);
  }
  for (const row of report.rows) {
    for (const method of writeMethods) {
      if (row.writes[method] !== row.writeQueries.filter(query => query.method === method).length) {
        throw new Error(`Database counter does not match logged writes: ${row.id} (${method})`);
      }
    }
  }
  return report;
}

function measure(rows: readonly Row[]) {
  const elapsed = rows.map(row => row.elapsedMs).sort((left, right) => left - right);
  const n = elapsed.length;
  const midpoint = Math.floor(n / 2);
  const writes = Object.fromEntries(writeMethods.map(method => {
    const counts = rows.map(row => row.writes[method]);
    return [method, {
      total: counts.reduce((sum, count) => sum + count, 0),
      tasksWithWrites: counts.filter(count => count > 0).length,
      maxPerTask: Math.max(0, ...counts),
    }];
  })) as Record<WriteMethod, { total: number; tasksWithWrites: number; maxPerTask: number }>;
  return {
    n,
    passed: rows.filter(row => row.judgment.passed).length,
    casesWithViolations: rows.filter(row => row.judgment.violations.length > 0).length,
    medianMs: n === 0 ? null : n % 2 ? elapsed[midpoint] : (elapsed[midpoint - 1] + elapsed[midpoint]) / 2,
    p95Ms: n === 0 ? null : elapsed[Math.ceil(0.95 * n) - 1],
    maxMs: elapsed.at(-1) ?? null,
    gpuLockPresentAtBoth: rows.filter(row => row.gpuLockAtStart && row.gpuLockAtEnd).length,
    gpuLockAbsentAtBoth: rows.filter(row => !row.gpuLockAtStart && !row.gpuLockAtEnd).length,
    gpuLockChangedBetweenSamples: rows.filter(row => row.gpuLockAtStart !== row.gpuLockAtEnd).length,
    writes,
  };
}

function forBothLanguages(rows: readonly Row[]) {
  return {
    total: measure(rows),
    ar: measure(rows.filter(row => row.language === 'ar')),
    en: measure(rows.filter(row => row.language === 'en')),
  };
}

function compareJudgments(report: Report, baseline: Report) {
  const baselineCases = new Map(baseline.rows.map(row => [row.id, row]));
  const changedJudgments = [];
  const changedFinalStatuses = [];
  for (const row of report.rows) {
    const previous = baselineCases.get(row.id);
    if (!previous || previous.category !== row.category || previous.language !== row.language) {
      throw new Error(`Development case identity changed: ${row.id}`);
    }
    if (!isDeepStrictEqual(previous.judgment, row.judgment)) changedJudgments.push(row.id);
    if (previous.status !== row.status) changedFinalStatuses.push(row.id);
  }
  if (report.rows.length !== baseline.rows.length) throw new Error('Development case count changed');
  return {
    n: report.rows.length,
    changedJudgments,
    changedFinalStatuses,
    sameObservedLockStates: report.rows.every(row => {
      const previous = baselineCases.get(row.id)!;
      return row.gpuLockAtStart === previous.gpuLockAtStart && row.gpuLockAtEnd === previous.gpuLockAtEnd;
    }),
  };
}

const [, , reportPath, baselinePath, ...rest] = process.argv;
if (!reportPath || rest.length) {
  throw new Error('Usage: node --import tsx scripts/brain-latency.ts <development-report.json> [baseline-report.json]');
}

const report = readDevelopmentReport(reportPath);
const baseline = baselinePath && readDevelopmentReport(baselinePath);
const budgets = statusSchema.parse(readJson(statusPath)).ownerAcceptance.speedBudgetsMs;
const comparison = baseline ? { baselinePath, ...compareJudgments(report, baseline) } : undefined;
const budgetChecks = Object.fromEntries(Object.entries(budgetCategories).map(([name, categories]) => {
  const limits = budgets[name as BudgetName];
  const measured = forBothLanguages(report.rows.filter(row => categories.includes(row.category)));
  const { medianMs, p95Ms, maxMs } = measured.total;
  const within = medianMs !== null && p95Ms !== null && maxMs !== null
    && medianMs <= limits.median && p95Ms <= limits.p95 && (limits.max === undefined || maxMs <= limits.max);
  return [name, { categories, limits, measured, within }];
}));

console.log(JSON.stringify({
  analysisUtc: new Date().toISOString(),
  command: `node --import tsx scripts/brain-latency.ts ${process.argv.slice(2).join(' ')}`,
  source: { path: reportPath, command: report.command, startedUtc: report.startedUtc, endedUtc: report.endedUtc,
    gpuLockAtStart: report.gpuLockAtStart, gpuLockAtEnd: report.gpuLockAtEnd },
  budgetSource: statusPath,
  budgetChecks,
  measured: forBothLanguages(report.rows),
  categories: Object.fromEntries(brainLabCategories.map(category =>
    [category, forBothLanguages(report.rows.filter(row => row.category === category))])),
  writesByCase: report.rows.map(({ id, category, language, writes }) => ({ id, category, language, writes })),
  comparison,
}, null, 2));

if (comparison?.changedJudgments.length) process.exitCode = 1;
