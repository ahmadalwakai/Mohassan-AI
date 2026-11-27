import type { SandboxRunner } from '@mohassan/coding';
import recordings from './suite-sandbox-recordings.json' with { type: 'json' };

type SnapshotFile = { path: string; content: string };
type SnapshotHash = (files: readonly SnapshotFile[]) => string;
type CheckRequest = Parameters<SandboxRunner['run']>[0];
type LintRequest = Parameters<NonNullable<SandboxRunner['lintFix']>>[0];
type RecordedOutput = { exitCode: number; stdout: string; stderr: string };

const provider = 'suite-recording';

function checkKey(hash: string, scope: {
  testFiles: string[];
  syntaxFiles?: string[];
  jsonFiles?: string[];
  typecheckProject: string | null;
}) {
  return JSON.stringify([hash, scope.testFiles, [...(scope.syntaxFiles ?? [])].sort(),
    [...(scope.jsonFiles ?? [])].sort(), scope.typecheckProject]);
}

function lintKey(hash: string, scope: { configPath: string; fixFiles: string[]; formatting: boolean }) {
  return JSON.stringify([hash, scope.configPath, [...scope.fixFiles].sort(), scope.formatting]);
}

const checks = new Map<string, RecordedOutput>(recordings.checks.map(row => [checkKey(row.snapshotHash, row), row]));
const lintFixes = new Map<string, RecordedOutput & { fixes: SnapshotFile[] }>(
  recordings.lintFixes.map(row => [lintKey(row.snapshotHash, row), row]),
);

function fixtureReceipt(snapshotHash: string, { exitCode, stdout, stderr }: RecordedOutput) {
  return { exitCode, stdout, stderr, timedOut: false, durationMs: 0, provider,
    network: 'denied' as const, isolation: 'appcontainer' as const, isolationVerified: true, snapshotHash };
}

/** Test double for the evaluation only. It replays command output and never executes a supplied snapshot. */
export function createSuiteSandbox(snapshotHash: SnapshotHash): SandboxRunner {
  return {
    available: async () => ({ available: true, provider, message: 'Evaluation stub replaying recorded fixture commands' }),
    run: async (request: CheckRequest) => {
      request.signal?.throwIfAborted();
      const hash = snapshotHash(request.files);
      const output = checks.get(checkKey(hash, {
        ...request, typecheckProject: request.typecheck ? request.typecheck.project ?? 'tsconfig.json' : null,
      }));
      if (!output) throw new Error(`No recorded suite check for snapshot ${hash}`);
      return fixtureReceipt(hash, output);
    },
    lintFix: async (request: LintRequest) => {
      request.signal?.throwIfAborted();
      const hash = snapshotHash(request.files);
      const output = lintFixes.get(lintKey(hash, request));
      if (!output) throw new Error(`No recorded suite ESLint fix for snapshot ${hash}`);
      return { ...fixtureReceipt(hash, output), fixes: output.fixes.map(file => ({ ...file })) };
    },
  };
}
