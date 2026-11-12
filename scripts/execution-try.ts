/**
 * Manual try-out for the local execution model.
 *
 * Asks the trained worker for one null-safe delta function, prints what it wrote, then runs a
 * supervisor-authored test against it inside the Windows AppContainer sandbox (network denied).
 * Nothing is written to the repository; the model gets only typed fields, never a free prompt.
 *
 * Usage: npx tsx scripts/execution-try.ts <functionName> <increment -9..9> [checkpoint-dir]
 * Example: npx tsx scripts/execution-try.ts addFive 5
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WindowsAppContainerSandbox } from '../packages/sandbox/src/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CHECKPOINT = join(root, 'artifacts', 'execution-model-runs', 'run-2026-11-12-c', 'inference-train-40m');
const PROTOCOL = 'mohassan.execution.local.v1';

function fail(message: string): never {
  console.error(message);
  console.error('Usage: npx tsx scripts/execution-try.ts <functionName> <increment -9..9> [checkpoint-dir]');
  process.exit(2);
}

function askWorker(checkpoint: string, identity: Record<string, string>, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
  const python = join(root, '.venv-execution', 'Scripts', 'python.exe');
  const child = spawn(python, ['-m', 'execution_pipeline.worker', '--checkpoint', checkpoint, '--model-id', identity.modelId,
    '--tokenizer-id', identity.tokenizerId, '--checkpoint-id', identity.checkpointId, '--device', 'cpu'],
  { cwd: join(root, 'packages', 'execution-pipeline'), env: { SystemRoot: 'C:\\Windows', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } });
  const request = { protocol: PROTOCOL, kind: 'generate', identity, requestId: 'manual-1', taskId: 'manual-try',
    capability: 'typescript.implement.v1:null-safe-delta', contract: { fields }, context: {}, maxOutputTokens: 96 };
  child.stdin.end(JSON.stringify(request) + '\n');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((done, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('worker timed out')); }, 120_000);
    child.on('close', code => {
      clearTimeout(timer);
      const frames = stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
      const response = frames.find(frame => frame.kind !== 'ready');
      if (!response) reject(new Error(`worker exited ${code} without a response${stderr ? ': ' + stderr.slice(-400) : ''}`));
      else done(response);
    });
  });
}

function specTest(name: string, increment: number): string {
  const numeric = [-1024, -1, 0, 7].map(input => `[${input}, ${input + increment}]`).join(', ');
  return `import test from 'node:test';import assert from 'node:assert/strict';import { ${name} } from './candidate.ts';
test('${name} specification', () => {
  for (const [input, expected] of [[null, 0], [undefined, 0], ${numeric}]) assert.equal(${name}(input), expected, String(input));
});\n`;
}

async function main(): Promise<void> {
  const [name, incrementText, checkpointArg] = process.argv.slice(2);
  if (!name || !/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(name)) fail('functionName must be a plain identifier.');
  const increment = Number(incrementText);
  if (!Number.isInteger(increment) || increment < -9 || increment > 9) fail('increment must be an integer from -9 to 9 (the trained range).');
  const checkpoint = resolve(checkpointArg ?? DEFAULT_CHECKPOINT);
  const manifestText = await readFile(join(checkpoint, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText) as { tokenizer_identity: string };
  const identity = { modelId: 'manual-try', tokenizerId: 'sha256:' + manifest.tokenizer_identity,
    checkpointId: 'sha256:' + createHash('sha256').update(manifestText.replace(/\n$/, '')).digest('hex') };

  console.log(`Task: export function ${name}(value) -> 0 for null/undefined, otherwise value + (${increment})`);
  console.log(`Checkpoint: ${checkpoint}\n`);
  const response = await askWorker(checkpoint, identity, { function_name: name, increment });
  const proposal = response.proposal as { text: string; generationMs: number; stopReason: string } | undefined;
  if (response.status !== 'candidate' || !proposal) {
    console.log('Model returned no candidate:', JSON.stringify(response));
    process.exitCode = 1;
    return;
  }
  console.log(`Model output (${response.outputTokens} tokens, ${proposal.generationMs} ms, stop: ${proposal.stopReason}):`);
  console.log('-----');
  console.log(proposal.text);
  console.log('-----\n');

  const sandbox = new WindowsAppContainerSandbox();
  if (!(await sandbox.available()).available) {
    console.log('AppContainer sandbox unavailable; the candidate was NOT executed.');
    process.exitCode = 1;
    return;
  }
  const receipt = await sandbox.run({ timeoutMs: 20_000, testFiles: ['spec.test.mjs'], files: [
    { path: 'package.json', content: '{"type":"module","private":true}' },
    { path: 'candidate.ts', content: proposal.text },
    { path: 'spec.test.mjs', content: specTest(name, increment) },
  ] });
  const passed = receipt.exitCode === 0 && !receipt.timedOut;
  console.log(`Sandbox (${receipt.provider}, network ${receipt.network}, isolation verified: ${receipt.isolationVerified}): ${passed ? 'TESTS PASS' : 'TESTS FAIL'}`);
  if (!passed) {
    const reason = receipt.stdout.split(/\r?\n/).find(line => /Error|actual|expected|SyntaxError/.test(line));
    if (reason) console.log('Reason:', reason.trim().slice(0, 300));
  }
  process.exitCode = passed ? 0 : 1;
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
