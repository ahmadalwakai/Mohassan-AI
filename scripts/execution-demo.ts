/**
 * Bounded local demonstration of the custom execution model under supervisor control.
 *
 * Supervisor (this script, standing in for the Cognitive Runtime) prepares Phase 1
 * contracts -> Phase 1 router selects deterministic or learned strategy -> learned
 * route calls the scratch-trained model through the Phase 5 wire protocol -> Phase 1
 * validates the untrusted candidate -> eligibility is checked against an explicit
 * permission observation -> the edit is applied to a DISPOSABLE temp workspace with
 * compare-and-swap on the preimage hash -> a supervisor-authored test runs in the
 * Windows AppContainer sandbox -> evidence is recorded.
 *
 * No production file, database, provider, Google Ads API, or runtime route is touched.
 * Usage: tsx scripts/execution-demo.ts <inference-checkpoint-dir> <evidence-output.json>
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ExecutionResultValidator, ExecutionStrategyRouter, submitExecutionModelTask,
  type ExecutionModelIdentity, type ExecutionResult,
} from '../packages/cognitive/src/execution-model/index.ts';
import { ExperimentalUncontainedWorkerTransport } from '../packages/execution-integration/src/experimental-worker-transport.ts';
import { TransportBackedExecutionModelAdapter } from '../packages/execution-integration/src/phase1-model-adapter.ts';
import { contract, countOutputTokens, eligibilitySnapshot, functionSource, routingContext, sha, workspaceRef, type Evidence } from '../packages/execution-integration/src/phase1-contract-fixtures.ts';
import { WindowsAppContainerSandbox, type SandboxFile } from '../packages/sandbox/src/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Compare-and-swap write strictly inside the disposable workspace. */
async function applyEdit(workspace: string, path: string, expectedHash: string, content: string): Promise<void> {
  const target = resolve(workspace, path);
  if (!target.startsWith(workspace + sep)) throw new Error('edit escapes the disposable workspace');
  const current = await readFile(target, 'utf8');
  if (sha(current) !== expectedHash) throw new Error('stale preimage: refusing to apply');
  await writeFile(target, content, 'utf8');
}

function supervisorTest(module: string, name: string, increment: number): string {
  const numeric = [-1024, -1, 0, 7].map(input => `[${input}, ${input + increment}]`).join(', ');
  return `import test from 'node:test';import assert from 'node:assert/strict';import { ${name} } from './${module}';
test('${name} specification', () => {
  for (const [input, expected] of [[null, 0], [undefined, 0], ${numeric}]) assert.equal(${name}(input), expected, String(input));
});\n`;
}

async function sandboxTest(sandbox: WindowsAppContainerSandbox, files: Record<string, string>) {
  const list: SandboxFile[] = [{ path: 'package.json', content: '{"type":"module","private":true}' },
    ...Object.entries(files).map(([path, content]) => ({ path, content }))];
  const receipt = await sandbox.run({ files: list, testFiles: ['spec.test.mjs'], timeoutMs: 20_000 });
  const failure = receipt.stdout.split(/\r?\n/).find(line => /AssertionError|actual|expected/.test(line)) ?? '';
  return { passed: receipt.exitCode === 0 && !receipt.timedOut, receipt: { exitCode: receipt.exitCode, timedOut: receipt.timedOut, durationMs: receipt.durationMs,
    provider: receipt.provider, network: receipt.network, isolation: receipt.isolation, isolationVerified: receipt.isolationVerified, snapshotHash: receipt.snapshotHash }, failure: failure.trim().slice(0, 300), stdout: receipt.stdout };
}

async function main(): Promise<void> {
  const [checkpointArg, evidencePath] = process.argv.slice(2);
  if (!checkpointArg || !evidencePath) throw new Error('usage: execution-demo.ts <checkpoint-dir> <evidence.json>');
  const checkpoint = resolve(checkpointArg);
  const manifestText = await readFile(join(checkpoint, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText) as { tokenizer_identity: string; weights_sha256: string };
  const checkpointIdentity = sha(manifestText.replace(/\n$/, ''));
  const runName = basename(dirname(checkpoint));
  const model: ExecutionModelIdentity = { id: 'mohassan-exec-local', version: `${runName}.${basename(checkpoint)}`, artifactHash: checkpointIdentity, initialization: 'random', locality: 'local' };
  const python = join(root, '.venv-execution', 'Scripts', 'python.exe');
  const transport = new ExperimentalUncontainedWorkerTransport({
    executable: python, args: ['-m', 'execution_pipeline.worker', '--checkpoint', checkpoint, '--model-id', model.id,
      '--tokenizer-id', 'sha256:' + manifest.tokenizer_identity, '--checkpoint-id', 'sha256:' + checkpointIdentity, '--device', 'cpu'],
    cwd: join(root, 'packages', 'execution-pipeline'),
    environment: { SystemRoot: 'C:\\Windows', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
    identity: { modelId: model.id, tokenizerId: 'sha256:' + manifest.tokenizer_identity, checkpointId: 'sha256:' + checkpointIdentity },
    readOnlyPaths: [checkpoint], maxRememberedRequestIds: 64,
    limits: { memoryBytes: 4 * 1024 ** 3, cpuTimeMs: 600_000, maxProcesses: 1, maxInputBytes: 65_536, maxMessageBytes: 65_536,
      maxOutputBytes: 262_144, maxStderrBytes: 0, maxOutputTokens: 96, startupTimeoutMs: 120_000, requestTimeoutMs: 120_000, cleanupTimeoutMs: 10_000 },
  }, { mode: 'uncontained-local-demonstration', reason: 'Bounded local demo; inference-only worker; no OS containment adapter exists for Python yet.' });
  const adapter = new TransportBackedExecutionModelAdapter({ transport, model, responseLanguages: ['ar', 'en'],
    limits: { maxInputBytes: 262_144, maxOutputTokens: 4096, maxTimeoutMs: 120_000 } });
  const learned = await adapter.discoverCapabilities({ signal: new AbortController().signal, timeoutMs: 120_000, deadlineAt: Date.now() + 120_000 });
  const sandbox = new WindowsAppContainerSandbox();
  if (!(await sandbox.available()).available) throw new Error('AppContainer sandbox unavailable; demonstration refused.');
  const validator = new ExecutionResultValidator();
  const evidence: Evidence[] = [];
  const workspace = await mkdtemp(join(tmpdir(), 'mohassan-exec-demo-'));
  const record = (entry: Evidence) => { evidence.push(entry); console.log(`${entry.passed ? 'PASS' : 'FAIL'}  ${entry.case}: expected ${entry.expected}, observed ${entry.observed}`); };

  async function supervise(name: string, rawTask: Record<string, unknown>, target: string, fn: string, increment: number) {
    const started = Date.now();
    const route = new ExecutionStrategyRouter().route(rawTask, routingContext(learned), countOutputTokens);
    const result: ExecutionResult = await submitExecutionModelTask(adapter, rawTask, routingContext(learned), { countOutputTokens });
    const generationMs = Date.now() - started;
    if (result.kind !== 'candidate') return { route: route.kind === 'selected' ? route.strategy : route.kind, result, generationMs };
    const eligibility = validator.checkEligibility(result, rawTask, eligibilitySnapshot(rawTask, 'granted', target), countOutputTokens);
    if (!eligibility.ok) return { route: 'learned', result, eligibility, generationMs };
    const edit = result.output.category === 'typescript_edit' ? result.output.proposal.edits[0]! : result.output.replacement;
    await applyEdit(workspace, target, edit.expectedHash, edit.content);
    const applied = await readFile(join(workspace, target), 'utf8');
    const verification = await sandboxTest(sandbox, { [target]: applied, 'spec.test.mjs': supervisorTest(target, fn, increment) });
    return { route: route.kind === 'selected' ? route.strategy : route.kind, result, eligibility, applied, verification, generationMs };
  }

  try {
    // ---- A. structured specification -> deterministic compiler -> validated operation ----
    const aTarget = 'clamp.ts';
    const aBefore = functionSource('clampDelta', 'value == null ? 0 : value');
    const aAfter = functionSource('clampDelta', 'value == null ? 0 : value + 2');
    await writeFile(join(workspace, aTarget), aBefore);
    const aTask = contract({ taskId: 'demo-a-structured', family: 'structured_specification', target: aTarget, files: { [aTarget]: aBefore }, replacement: aAfter });
    const a = await supervise('A', aTask, aTarget, 'clampDelta', 2);
    record({ case: 'A structured spec -> deterministic operation', expected: 'deterministic route; sandbox tests pass',
      observed: `${a.route}; ${a.verification?.passed ? 'tests pass' : 'tests fail'}`, passed: a.route === 'deterministic' && a.verification?.passed === true,
      details: { result: a.result.kind, verification: a.verification?.receipt } });

    // ---- B. short TypeScript implementation by the trained model ----
    const bTarget = 'delta.ts';
    const bStub = functionSource('offsetScore', '0');
    await writeFile(join(workspace, bTarget), bStub);
    const bTask = contract({ taskId: 'demo-b-implement', family: 'typescript_implementation', target: bTarget, files: { [bTarget]: bStub },
      spec: { function_name: 'offsetScore', increment: 4 } });
    const b = await supervise('B', bTask, bTarget, 'offsetScore', 4);
    record({ case: 'B TypeScript implementation by local model', expected: 'learned route; candidate validated; sandbox tests pass',
      observed: `${b.route}; ${b.result.kind}; ${b.verification ? (b.verification.passed ? 'tests pass' : 'tests fail') : 'not executed'}`,
      passed: b.route === 'learned' && b.result.kind === 'candidate' && b.verification?.passed === true,
      details: { result: b.result.kind === 'candidate' ? 'candidate' : b.result, eligibility: b.eligibility && !b.eligibility.ok ? b.eligibility.result : undefined, candidate: b.applied, generationMs: b.generationMs, verification: b.verification?.receipt, failure: b.verification?.failure } });

    // ---- C. local repair from concrete sandbox failure evidence ----
    const cTarget = 'repair.ts';
    const cBroken = functionSource('scaleBonus', 'value + 6');
    await writeFile(join(workspace, cTarget), cBroken);
    const before = await sandboxTest(sandbox, { [cTarget]: cBroken, 'spec.test.mjs': supervisorTest(cTarget, 'scaleBonus', 6) });
    // Concrete evidence is the observed sandbox behavior, written by the supervisor.
    const failureEvidence = before.passed ? [] : [{ id: 'ev-null', details: 'scaleBonus(null) returned 6; expected 0' },
      { id: 'ev-undefined', details: 'scaleBonus(undefined) returned NaN; expected 0' }];
    const cTask = contract({ taskId: 'demo-c-repair', family: 'local_code_repair', target: cTarget, files: { [cTarget]: cBroken },
      spec: { function_name: 'scaleBonus', increment: 6, failure_category: 'missing_null_guard' }, evidence: failureEvidence });
    const c = await supervise('C', cTask, cTarget, 'scaleBonus', 6);
    record({ case: 'C repair from failure evidence by local model', expected: 'failure reproduced; learned route; sandbox tests pass after repair',
      observed: `before=${before.passed ? 'pass' : 'fail'}; ${c.route}; ${c.result.kind}; ${c.verification ? (c.verification.passed ? 'tests pass' : 'tests fail') : 'not executed'}`,
      passed: !before.passed && c.route === 'learned' && c.verification?.passed === true,
      details: { failureBefore: before.failure, result: c.result.kind === 'candidate' ? 'candidate' : c.result, eligibility: c.eligibility && !c.eligibility.ok ? c.eligibility.result : undefined, candidate: c.applied, generationMs: c.generationMs, verification: c.verification?.receipt } });

    // ---- Negative and boundary cases (no model output is applied) ----
    const missing = await submitExecutionModelTask(adapter, contract({ taskId: 'demo-missing', family: 'typescript_implementation', target: 'x.ts',
      files: { 'x.ts': bStub }, omitTargetFile: true, spec: { function_name: 'f', increment: 1 } }), routingContext(learned), { countOutputTokens });
    record({ case: 'Missing context', expected: 'missing_context', observed: missing.kind, passed: missing.kind === 'missing_context', details: { missing } });

    const unsupported = await submitExecutionModelTask(adapter, contract({ taskId: 'demo-unsupported', family: 'typescript_implementation', target: 'x.ts',
      files: { 'x.ts': bStub }, category: 'react', spec: { function_name: 'f', increment: 1 } }), routingContext(learned), { countOutputTokens });
    record({ case: 'Unsupported operation (react)', expected: 'unsupported', observed: unsupported.kind, passed: unsupported.kind === 'unsupported', details: {} });

    const outOfDomain = await submitExecutionModelTask(adapter, contract({ taskId: 'demo-out-of-domain', family: 'typescript_implementation', target: 'x.ts',
      files: { 'x.ts': bStub }, spec: { function_name: 'f', increment: 500 } }), routingContext(learned), { countOutputTokens });
    record({ case: 'Fields outside trained domain', expected: 'unsupported', observed: outOfDomain.kind, passed: outOfDomain.kind === 'unsupported', details: {} });

    const staleTask = contract({ taskId: 'demo-stale', family: 'typescript_implementation', target: 'x.ts', files: { 'x.ts': bStub }, spec: { function_name: 'f', increment: 1 } });
    const staleSnapshot = { ...eligibilitySnapshot(staleTask, 'granted', 'x.ts'), workspace: workspaceRef({ 'x.ts': 'changed' }) };
    const fakeCandidate = { kind: 'candidate', taskId: 'demo-stale', workspace: staleTask.workspace, producer: { strategy: 'learned', model },
      output: { category: 'typescript_edit', language: 'typescript', proposal: { summary: 's', edits: [{ path: 'x.ts', expectedHash: sha(bStub), content: 'x' }] } },
      verification: 'not_verified', executionAllowed: false };
    const stale = validator.checkEligibility(fakeCandidate, staleTask, staleSnapshot, countOutputTokens);
    record({ case: 'Stale workspace at dispatch', expected: 'stale_workspace', observed: stale.ok ? 'eligible' : (stale.result as { code?: string }).code ?? stale.result.kind,
      passed: !stale.ok && (stale.result as { code?: string }).code === 'stale_workspace', details: {} });

    const denied = validator.checkEligibility(fakeCandidate, staleTask, eligibilitySnapshot(staleTask, 'denied', 'x.ts'), countOutputTokens);
    record({ case: 'Permission denied', expected: 'permission_required', observed: denied.ok ? 'eligible' : (denied.result as { code?: string }).code ?? '',
      passed: !denied.ok && (denied.result as { code?: string }).code === 'permission_required', details: {} });

    const escaping = { ...fakeCandidate, output: { ...fakeCandidate.output, proposal: { summary: 's', edits: [{ path: '.env', expectedHash: sha(bStub), content: 'x' }] } } };
    const escape = validator.validateStructure(escaping, staleTask, countOutputTokens);
    record({ case: 'Model proposes a write outside allowed files (.env)', expected: 'rejected', observed: escape.ok ? 'accepted' : 'rejected', passed: !escape.ok, details: {} });

    const controller = new AbortController(); controller.abort();
    const cancelled = await submitExecutionModelTask(adapter, contract({ taskId: 'demo-cancel', family: 'typescript_implementation', target: 'x.ts',
      files: { 'x.ts': bStub }, spec: { function_name: 'f', increment: 1 } }), routingContext(learned), { countOutputTokens, signal: controller.signal });
    record({ case: 'Cancellation before generation', expected: 'cancelled', observed: cancelled.kind === 'failure' ? cancelled.code : cancelled.kind,
      passed: cancelled.kind === 'failure' && cancelled.code === 'cancelled', details: {} });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
  const output = { schema: 'execution-demo-v1', at: new Date().toISOString(), model, transport: 'ExperimentalUncontainedWorkerTransport (inference-only, uncontained)',
    sandbox: 'windows-appcontainer', passed: evidence.filter(e => e.passed).length, total: evidence.length, evidence };
  await mkdir(dirname(resolve(evidencePath)), { recursive: true });
  await writeFile(evidencePath, JSON.stringify(output, null, 2));
  console.log(`\n${output.passed}/${output.total} demonstration checks passed. Evidence: ${evidencePath}`);
  if (output.passed !== output.total) process.exitCode = 1;
}

await main();
