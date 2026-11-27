import { describe, expect, it, vi } from 'vitest';
import { CodingResultSchema, type CodingResult, type SandboxTestResult } from '@mohassan/contracts';
import { codingOutcomeFields, codingOutcomeReport, codingOutcomeReportText } from '../apps/server/src/assistant/coding-outcome-report.js';
import { ASSERTION_OUTPUT, PASSING_OUTPUT, REAL_OUTPUT } from './fixtures/coding-test-output.js';

const paths = ['README.md', 'package.json', 'src/sum.ts', 'test/sum.test.mjs'];
function receipt(stdout: string, exitCode: number, timedOut = false): SandboxTestResult {
  return { stdout, stderr: '', exitCode, timedOut, durationMs: 1, provider: 'unit-fixture', network: 'denied',
    isolation: 'appcontainer', isolationVerified: true, snapshotHash: 'b'.repeat(64) };
}

function result(overrides: Partial<CodingResult> = {}): CodingResult {
  return CodingResultSchema.parse({
    kind: 'coding', summary: 'Correct the spelling of rightHandValue', projectId: 'p-demo', baseCommit: 'a'.repeat(40),
    branch: 'mohassan/task', checkpoint: 'c'.repeat(40), worktreeRetained: true, diff: '', diffHash: 'd'.repeat(64),
    changes: [{ path: 'src/sum.ts', beforeHash: '1'.repeat(64), afterHash: '2'.repeat(64) }],
    baselineTests: receipt(REAL_OUTPUT, 1), tests: receipt(PASSING_OUTPUT, 0),
    review: { passed: true, checks: [{ id: 'isolated_tests', passed: true, message: 'Checks passed.' }] },
    outcome: 'ready_for_review', sourceUnchanged: true, merged: false, model: 'deterministic-tools',
    usage: { inputTokens: 0, outputTokens: 0 }, verifiedAt: '2026-11-27T12:00:00Z',
    ...overrides,
  });
}

const remainingFailure = (tests: SandboxTestResult) => result({
  tests, outcome: 'tests_failed', checkpoint: null,
  review: { passed: false, checks: [{ id: 'isolated_tests', passed: false, message: 'Tests did not pass.' }] },
});
const render = (fields: string[], lang: 'ar' | 'en') => codingOutcomeReportText(
  key => fields.find(line => line.startsWith(`${key}: `))?.slice(key.length + 2) ?? null, lang);

describe('verified coding outcome report', () => {
  it('reads the recorded failing and passing spec reports and keeps declaration and error origin', () => {
    const report = codingOutcomeReport(result(), paths);
    expect(report).toEqual({
      before: {
        status: 'failed',
        counts: { tests: 2, pass: 0, fail: 2 },
        failures: [
          { test: 'adds positive values', location: { path: 'test/sum.test.mjs', line: 5 },
            origin: { path: 'src/sum.ts', line: 2 }, error: 'ReferenceError: rightHandVaule is not defined' },
          { test: 'adds negative values', location: { path: 'test/sum.test.mjs', line: 6 },
            origin: { path: 'src/sum.ts', line: 2 }, error: 'ReferenceError: rightHandVaule is not defined' },
        ],
        omittedFailures: 0,
      },
      after: { status: 'passed', counts: { tests: 2, pass: 2, fail: 0 }, failures: [], omittedFailures: 0 },
    });
    expect(JSON.stringify(report)).not.toContain('mohassan-sandbox');
  });

  it('reports remaining assertion failures from the post-fix receipt', () => {
    const report = codingOutcomeReport(remainingFailure(receipt(ASSERTION_OUTPUT, 1)), paths);
    expect(report.after).toMatchObject({
      counts: { tests: 2, pass: 0, fail: 2 },
      failures: [
        { test: 'adds positive values', location: { path: 'test/sum.test.mjs', line: 5 },
          origin: { path: 'test/sum.test.mjs', line: 5 }, error: 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: -1 !== 5' },
        { test: 'adds negative values', location: { path: 'test/sum.test.mjs', line: 6 },
          origin: { path: 'test/sum.test.mjs', line: 6 }, error: 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: -4 !== -2' },
      ],
    });
  });

  it('preserves passing test counts when independent review fails', () => {
    const failedReview = result({
      outcome: 'review_failed', checkpoint: null,
      review: { passed: false, checks: [{ id: 'diff_whitespace', passed: false, message: 'Whitespace check failed.' }] },
    });
    expect(codingOutcomeReport(failedReview, paths).after).toEqual({
      status: 'passed', counts: { tests: 2, pass: 2, fail: 0 }, failures: [], omittedFailures: 0,
    });
  });

  it('reports a located check error when the test reporter was never reached', () => {
    const tsc = 'C:/Temp/sandbox/work/src/sum.ts(2,26): error TS2552: Cannot find name rightHandVaule';
    const report = codingOutcomeReport(remainingFailure(receipt(tsc, 1)), paths);
    expect(report.after).toMatchObject({
      status: 'failed', counts: null,
      failures: [{ test: null, location: { path: 'src/sum.ts', line: 2 }, error: 'TS2552: Cannot find name rightHandVaule' }],
    });
  });

  it('omits unknown locations and redacts test names and the fallback output', () => {
    const marker = 'sample-value-for-redaction';
    const named = REAL_OUTPUT.replace('✖ adds positive values (0.6578ms)\n  ReferenceError',
      `✖ password = "${marker}" (0.6578ms)\n  ReferenceError`);
    const fallback = receipt(`spawn failed in /tmp/private.txt\npassword = "${marker}"`, 1);
    const report = codingOutcomeReport({ ...remainingFailure(fallback), baselineTests: receipt(named, 1) }, []);
    expect(report.before?.failures[0]).toMatchObject({ location: null, origin: null });
    expect(report.after.failures[0]?.error).toContain('spawn failed in <path>');
    expect(JSON.stringify(report)).not.toMatch(/sample-value-for-redaction|private\.txt/u);
  });

  it('limits the baseline to the first failures and marks timeouts without presenting a final count', async () => {
    const additionalFailure = REAL_OUTPUT.slice(REAL_OUTPUT.indexOf('test at'));
    const extraOutput = `${REAL_OUTPUT}${additionalFailure}`.replace('ℹ tests 2', 'ℹ tests 4').replace('ℹ fail 2', 'ℹ fail 4');
    const timedOut = { ...remainingFailure(receipt(PASSING_OUTPUT, 0, true)), baselineTests: receipt(extraOutput, 1) };
    const report = codingOutcomeReport(timedOut, paths);
    expect(report.before?.failures).toHaveLength(2);
    expect(report.before?.omittedFailures).toBe(2);
    expect(report.after).toMatchObject({ status: 'timed_out', counts: null });
    const rendered = render(await codingOutcomeFields(timedOut, async () => paths), 'en');
    expect(rendered).toContain('Before the change: 0 of 4 passed, 4 failed.');
    expect(rendered).toContain('After the change: The checks timed out.');
    expect(rendered).toContain('Additional failures: 2.');
  });

  it('passes single-line fields to the bilingual reply and tolerates absent or invalid older facts', async () => {
    const trackedPaths = vi.fn(async () => paths);
    const fields = await codingOutcomeFields(result(), trackedPaths);
    expect(trackedPaths).toHaveBeenCalledWith('p-demo', 'a'.repeat(40));
    expect(fields.join('\n').split('\n')).toHaveLength(2);
    expect(render(fields, 'ar')).toContain('قبل التعديل: نجح 0 من 2، وفشل 2.\nبعد التعديل: نجح 2 من 2، وفشل 0.');
    expect(render(fields, 'en')).toContain('Before the change: 0 of 2 passed, 2 failed.\nAfter the change: 2 of 2 passed, 0 failed.');
    expect(render(['tests before: {', 'tests after: {"status":"made-up"}'], 'en')).toBe('');
    expect(await codingOutcomeFields({ kind: 'coding' }, trackedPaths)).toEqual([]);
    expect(await codingOutcomeFields({ kind: 'studio_change' }, trackedPaths)).toEqual([]);
    expect(trackedPaths).toHaveBeenCalledTimes(1);
    const noBaseline = await codingOutcomeFields(result({ baselineTests: null }), async () => { throw new Error('source unavailable'); });
    expect(render(noBaseline, 'en')).toContain('Before the change: No result was recorded.');
    expect(render(noBaseline, 'en')).toContain('After the change: 2 of 2 passed, 0 failed.');
  });
});
