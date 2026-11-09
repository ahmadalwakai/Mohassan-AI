import { execFile } from 'node:child_process';
import { arch, release } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { captureEvidenceSources, createEvidenceRun } from './lib/evidence-report.ts';

// Fixed native fixture only: no dotenv, API, account, desktop input, or user window target.
// A completed diagnostic is not acceptance of mouse/keyboard control.
if (process.platform !== 'win32') throw new Error('The focus fixture requires Windows.');
if (process.argv.length !== 2) throw new Error('The fixed focus diagnostic takes no arguments.');
const repository = fileURLToPath(new URL('..', import.meta.url));
const startedAt = new Date().toISOString();
const evidence = await createEvidenceRun(repository, 'windows-focus', startedAt);
const sourcePaths = ['apps/windows/Companion.cs', 'scripts/windows-companion.ps1', 'scripts/check-windows-focus.ts', 'scripts/lib/evidence-report.ts'];
const before = await captureEvidenceSources(repository, sourcePaths, evidence.directory);
const powershell = join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const launcher = join(repository, 'scripts', 'windows-companion.ps1');
const nativePath = join(evidence.directory, 'native.json');
const execute = promisify(execFile);
const nativeSchema = z.object({
  diagnosticCompleted: z.literal(true), fixtureOnly: z.literal(true), inputAttempted: z.literal(false),
  nativeAcceptanceProven: z.literal(false), desktopScopeDenied: z.literal(true), safeDesktop: z.boolean(),
  focus: z.object({ outcome: z.string(), focusGranted: z.boolean(), inputAttempted: z.literal(false) }).passthrough(),
}).passthrough();
let binary: unknown;
let native: z.infer<typeof nativeSchema> | undefined;
let failure: string | undefined;
try {
  const compiled = await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', launcher, '-CompileOnly'], { cwd: repository, windowsHide: true, timeout: 30_000, maxBuffer: 128 * 1024 });
  binary = z.object({ sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), executable: z.string(), executableSha256: z.string().regex(/^[a-f0-9]{64}$/) }).parse(JSON.parse(compiled.stdout));
  await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', launcher, '-FixtureFocusDiagnostic', '-ResultPath', nativePath], { cwd: repository, windowsHide: true, timeout: 40_000, maxBuffer: 128 * 1024 });
  native = nativeSchema.parse(JSON.parse(await readFile(nativePath, 'utf8')));
} catch (error) {
  failure = error instanceof Error ? error.message.slice(0, 2000) : 'Focus diagnostic failed';
}
const after = await captureEvidenceSources(repository, sourcePaths);
const sourceStable = before.hash === after.hash;
await evidence.writeReport({
  startedAt, finishedAt: new Date().toISOString(), scope: 'fixture-focus-diagnostic-only',
  inputAttempted: false, nativeAcceptanceProven: false, sourceStable, sourcesBefore: before, sourcesAfter: after,
  runtime: { platform: process.platform, windowsRelease: release(), arch: arch(), node: process.version, launcher: powershell },
  binary, native, failure,
});
console.log(JSON.stringify({
  reportPath: evidence.reportPath, scope: 'fixture-focus-diagnostic-only', sourceStable,
  diagnosticCompleted: native?.diagnosticCompleted ?? false, focusGranted: native?.focus.focusGranted ?? false,
  outcome: native?.focus.outcome, inputAttempted: false, nativeAcceptanceProven: false, failure,
}));
process.exitCode = native?.diagnosticCompleted && sourceStable ? 0 : 1;
