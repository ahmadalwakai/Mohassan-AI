import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { release, version } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WindowsAppContainerSandbox } from '../packages/sandbox/src/index.ts';
import type { SandboxScriptInput, SandboxScriptResult } from '../packages/sandbox/src/script.ts';
import { captureEvidenceSources, createEvidenceRun } from './lib/evidence-report.js';

// Standalone fixed fixtures only: no dotenv, API startup, database, user code, or credentials.
const mode = process.argv.slice(2).join(' ');
if (!['', '--lpac-only', '--startup-compare'].includes(mode)) throw new Error('Use no arguments for all gates, --lpac-only, or --startup-compare for bounded startup diagnostics.');
const repository = fileURLToPath(new URL('../', import.meta.url));
const startedAt = new Date().toISOString();
const run = await createEvidenceRun(repository, 'windows-isolation', startedAt);
async function sourceFiles() {
  return ['packages/sandbox/native/Runner.cs', 'packages/sandbox/native/run.ps1', 'packages/sandbox/package.json', 'package.json', 'package-lock.json', 'scripts/isolation-admin-setup.ps1', 'scripts/check-isolation-completion.ts', 'scripts/lib/evidence-report.ts',
    ...(await readdir(path.join(repository, 'packages/sandbox/src'))).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts')).map(name => 'packages/sandbox/src/' + name)];
}
async function runtimeIdentity() {
  return { platform: process.platform, architecture: process.arch, osRelease: release(), osVersion: version(), nodeVersion: process.version,
    nodeSha256: createHash('sha256').update(await readFile(process.execPath)).digest('hex') };
}
const before = await captureEvidenceSources(repository, await sourceFiles(), run.directory), runtime = await runtimeIdentity();
const sandbox = new WindowsAppContainerSandbox({ quotaRoot: 'C:\\MohassanQuota' });
async function finish(details: Record<string, unknown>) {
  const after = await captureEvidenceSources(repository, await sourceFiles()), runtimeAfter = await runtimeIdentity();
  const report = { version: 2, startedAt, finishedAt: new Date().toISOString(), source: before, finalSource: after,
    sourceStable: before.hash === after.hash, runtime, runtimeAfter, runtimeStable: JSON.stringify(runtime) === JSON.stringify(runtimeAfter), ...details };
  await run.writeReport(report);
  return report;
}
if (mode === '--lpac-only' || mode === '--startup-compare') {
  const fixture: SandboxScriptInput = { entry: 'lpac.mjs', files: [{ path: 'lpac.mjs', content: 'console.log("LPAC_STARTED");' }], inputJson: '{}', timeoutMs: 4000, memoryMb: 256, outputMaxBytes: 1024 };
  // Deliberately a repository-owned fixed probe, not a public execution permission.
  const runner = sandbox as unknown as { executeScript(input: SandboxScriptInput, lowPrivilege: boolean): Promise<SandboxScriptResult> };
  const results = [];
  for (const lowPrivilege of mode === '--startup-compare' ? [false, true] : [true]) {
    try {
      const result = await runner.executeScript(fixture, lowPrivilege);
      results.push({ requestedLowPrivilege: lowPrivilege, started: !result.timedOut && result.exitCode === 0 && result.stdout.trim() === 'LPAC_STARTED', ...result });
    } catch (error: any) {
      results.push({ requestedLowPrivilege: lowPrivilege, started: false, errorCode: typeof error?.code === 'string' && /^[A-Z0-9_]{2,60}$/.test(error.code) ? error.code : 'STARTUP_CHECK_UNAVAILABLE' });
    }
  }
  const report = await finish({ scope: mode === '--startup-compare' ? 'appcontainer-lpac-startup-comparison' : 'lpac-startup-only', fullReadinessAssessed: false, results });
  console.log(JSON.stringify({ sourceStable: report.sourceStable, runtimeStable: report.runtimeStable, results: results.map(result => ({ lowPrivilege: result.requestedLowPrivilege, started: result.started })), reportPath: run.reportPath }));
  process.exit(results.every(result => result.started) && report.sourceStable && report.runtimeStable ? 0 : 1);
}
const baseline = await sandbox.available();
const readiness = await sandbox.executableReadiness();
const report = await finish({
  scope: 'full-isolation-gates',
  baseline, readiness,
  errors: { quota: sandbox.quotaProbeError, lpac: sandbox.lpacProbeError, publicResource: sandbox.publicResourceProbeError, sideChannels: sandbox.sideChannelProbeError },
  quota: sandbox.quotaProbeEvidence && { stdout: sandbox.quotaProbeEvidence.stdout, nativeControls: sandbox.quotaProbeEvidence.nativeControls },
  lpac: sandbox.lpacProbeEvidence && { exitCode: sandbox.lpacProbeEvidence.exitCode, nativeControls: sandbox.lpacProbeEvidence.nativeControls },
  sideChannels: sandbox.sideChannelControlEvidence,
});
console.log(JSON.stringify({ baseline: baseline.available, executableSkills: readiness.enabled, sourceStable: report.sourceStable, runtimeStable: report.runtimeStable, blocked: readiness.gates.filter(gate => gate.status === 'blocked').map(gate => gate.id), reportPath: run.reportPath }));
process.exitCode = readiness.enabled && report.sourceStable && report.runtimeStable ? 0 : 1;
