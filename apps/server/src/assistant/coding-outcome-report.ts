import { explainCheckRun, relativeOutput } from '@mohassan/coding';
import { CodingResultSchema, type CodingResult, type SandboxTestResult } from '@mohassan/contracts';
import { z } from 'zod';
import { redactSensitiveCredentialText } from '../sensitive-credential-text.js';

const Location = z.object({ path: z.string(), line: z.number().int().nonnegative() });
const Failure = z.object({
  test: z.string().nullable(),
  location: Location.nullable(),
  origin: Location.nullable(),
  error: z.string(),
});
const Run = z.object({
  status: z.enum(['passed', 'failed', 'timed_out']),
  counts: z.object({ tests: z.number().int(), pass: z.number().int(), fail: z.number().int() }).nullable(),
  failures: z.array(Failure),
  omittedFailures: z.number().int().nonnegative(),
});
type Failure = z.infer<typeof Failure>;
type Location = z.infer<typeof Location>;
type Run = z.infer<typeof Run>;

interface CodingOutcomeReport {
  before: Run | null;
  after: Run;
}

const compact = (text: string) => redactSensitiveCredentialText(text).replace(/[\r\n\u2028\u2029]+\s*/gu, ' ').trim();
const locationOf = (location: Location | null): Location | null => location && Number.isSafeInteger(location.line)
  ? { path: compact(location.path), line: location.line } : null;

function runFacts(receipt: SandboxTestResult, paths: readonly string[], failureLimit: number): Run {
  const report = explainCheckRun(receipt, paths);
  const counts = Run.shape.counts.safeParse(report.counts);
  const failures: Failure[] = [];
  if (failureLimit) {
    failures.push(
      ...report.failures.map(failure => ({
        test: compact(relativeOutput(failure.test, paths)),
        location: locationOf(failure.location), origin: locationOf(failure.origin),
        error: compact([failure.error, failure.comparison].filter(Boolean).join(' ')),
      })),
      ...report.typecheck.map(item => ({
        test: null, location: locationOf(item), origin: null, error: compact(`${item.code}: ${item.message}`),
      })),
      ...report.syntax.map(item => ({
        test: null, location: locationOf(item.location), origin: null, error: compact(item.message),
      })),
    );
    if (report.unparsed) failures.push({ test: null, location: null, origin: null, error: compact(report.unparsed).slice(0, 300) });
  }
  return {
    status: report.status, counts: receipt.timedOut ? null : counts.data ?? null,
    failures: failures.slice(0, failureLimit),
    omittedFailures: failureLimit ? report.omittedFailures + Math.max(0, failures.length - failureLimit) : 0,
  };
}

/** Summarizes the verified receipts. Only the first two baseline failures are needed for comparison. */
export function codingOutcomeReport(result: CodingResult, trackedPaths: readonly string[]): CodingOutcomeReport {
  return {
    before: result.baselineTests ? runFacts(result.baselineTests, trackedPaths, 2) : null,
    after: runFacts(result.tests, trackedPaths, result.outcome === 'ready_for_review' ? 0 : 10),
  };
}

const BEFORE = 'tests before';
const AFTER = 'tests after';

/** A coding result stored by Runtime has already passed verification. Each field occupies one line. */
export async function codingOutcomeFields(raw: Record<string, unknown> | null,
    trackedPaths: (projectId: string, baseCommit: string) => Promise<readonly string[]> | undefined): Promise<string[]> {
  if (raw?.kind !== 'coding') return [];
  const parsed = CodingResultSchema.safeParse(raw);
  if (!parsed.success) return [];
  const result = parsed.data;
  // If the source cannot be inspected anymore, the receipt still supports counts and errors.
  const paths = await trackedPaths(result.projectId, result.baseCommit)?.catch(() => []) ?? [];
  const { before, after } = codingOutcomeReport(result, paths);
  return [`${BEFORE}: ${JSON.stringify(before)}`, `${AFTER}: ${JSON.stringify(after)}`];
}

function readRun(value: string | null): Run | null | undefined {
  if (value === null) return undefined;
  try { return Run.nullable().safeParse(JSON.parse(value)).data; }
  catch { return undefined; }
}

function runSummary(run: Run | null, ar: boolean): string {
  if (!run) return ar ? 'لا توجد نتيجة محفوظة.' : 'No result was recorded.';
  if (run.status === 'timed_out') return ar ? 'انتهت مهلة الفحوص.' : 'The checks timed out.';
  if (!run.counts) return run.status === 'passed'
    ? (ar ? 'نجحت الفحوص، ولم تتضمن المخرجات عدد الاختبارات.' : 'Checks passed. Test counts are unavailable.')
    : (ar ? 'فشلت الفحوص، ولم تتضمن المخرجات عدد الاختبارات.' : 'Checks failed. Test counts are unavailable.');
  const { tests, pass, fail } = run.counts;
  return ar ? `نجح ${pass} من ${tests}، وفشل ${fail}.` : `${pass} of ${tests} passed, ${fail} failed.`;
}

function failureLines(run: Run | null | undefined, heading: string, ar: boolean): string[] {
  if (!run?.failures.length) return [];
  const where = (location: Location | null) => location ? `\`${location.path}:${location.line}\`` : '';
  const lines = run.failures.map(({ test, location, origin, error }) => {
    const at = where(location), from = where(origin);
    const name = test && (ar ? `«${test}»` : `"${test}"`);
    const subject = name ? `${name}${at ? (ar ? ` في ${at}` : ` at ${at}`) : ''}` : at;
    const cause = from && from !== at ? (ar ? ` (المصدر ${from})` : ` (from ${from})`) : '';
    return `- ${subject ? `${subject} — ` : ''}${error}${cause}`;
  });
  if (run.omittedFailures) lines.push(ar ? `إخفاقات أخرى لم تُعرض: ${run.omittedFailures}.` : `Additional failures: ${run.omittedFailures}.`);
  return ['', heading, ...lines];
}

/** Renders the optional verified fields carried by the work tool. Older task text has no report fields. */
export function codingOutcomeReportText(field: (key: string) => string | null, lang: 'ar' | 'en'): string {
  const before = readRun(field(BEFORE)), after = readRun(field(AFTER));
  const ar = lang === 'ar', lines: string[] = [];
  if (before !== undefined) lines.push(`${ar ? 'قبل التعديل' : 'Before the change'}: ${runSummary(before, ar)}`);
  if (after !== undefined) lines.push(`${ar ? 'بعد التعديل' : 'After the change'}: ${runSummary(after, ar)}`);
  return [
    ...lines,
    ...failureLines(before, ar ? 'أول الإخفاقات قبل التعديل:' : 'First failures before the change:', ar),
    ...failureLines(after, ar ? 'ما زال يفشل بعد التعديل:' : 'Still failing after the change:', ar),
  ].join('\n');
}
