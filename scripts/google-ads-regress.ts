import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { REQUIRED_REGRESSION_RUNS, defaultGateFiles, sourceFingerprint } from '@mohassan/google-ads';

/**
 * Runs the Google Ads suites in a row and stops at the first failure, so the file
 * can only claim consecutive passes. It binds the count to a fingerprint of the
 * package: any later code change closes the regression gate until this runs again.
 */
const SUITES = ['tests/google-ads.test.ts', 'tests/google-ads-api.test.ts', 'tests/google-ads-chat.test.ts', 'tests/google-ads-skill.test.ts', 'tests/google-ads-paused.test.ts', 'tests/google-ads-paused-intent.test.ts'];
const requested = Number(process.argv[2] ?? REQUIRED_REGRESSION_RUNS);
const files = defaultGateFiles();
const before = await sourceFingerprint(files.sourceDir);
const startedAt = new Date().toISOString();
const runs: { run: number; passed: boolean; tests: number | null; durationMs: number }[] = [];

for (let run = 1; run <= requested; run += 1) {
  const started = Date.now();
  const result = spawnSync(`npx vitest run ${SUITES.join(' ')} --reporter=dot`, { shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const tests = /Tests\s+(?:\d+ failed \| )?(\d+) passed/.exec(result.stdout)?.[1];
  const passed = result.status === 0;
  runs.push({ run, passed, tests: tests ? Number(tests) : null, durationMs: Date.now() - started });
  console.log(`run ${run}/${requested}: ${passed ? 'passed' : 'FAILED'} (${tests ?? '?'} tests, ${Date.now() - started} ms)`);
  if (!passed) { console.error(result.stdout.slice(-4000)); break; }
}

const after = await sourceFingerprint(files.sourceDir);
const consecutivePasses = before === after && runs.every(run => run.passed) ? runs.length : 0;
await mkdir(resolve('artifacts'), { recursive: true });
await writeFile(files.regressionFile, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), consecutivePasses, sourceFingerprint: after, suites: SUITES, runs }, null, 2));
console.log(`consecutive passes: ${consecutivePasses}`);
if (consecutivePasses < requested) process.exitCode = 1;
