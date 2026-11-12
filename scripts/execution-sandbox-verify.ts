/**
 * Independent behavioral verification of generated TypeScript inside the existing
 * Windows AppContainer sandbox (network denied, filesystem confined, Node permissions).
 *
 * Input job (JSON): { candidates: [{ id, content, functionName, probes: [{ arg, expected }] }] }
 * Expected values come from the evaluator's oracle, never from the model.
 * Generated code is NEVER imported or executed on the host by this script.
 *
 * Usage: tsx scripts/execution-sandbox-verify.ts <job.json> <result.json>
 */
import { readFile, writeFile } from 'node:fs/promises';
import { WindowsAppContainerSandbox, type SandboxFile } from '../packages/sandbox/src/index.ts';

interface Probe { arg: number | 'null' | 'undefined'; expected: number }
interface Candidate { id: string; content: string; functionName: string; probes: Probe[] }

const BATCH = 90; // sandbox accepts at most 100 files per run
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function harness(entries: { file: string; id: string; functionName: string; probes: Probe[] }[]): string {
  // Each candidate is loaded in isolation; a syntax/runtime error marks only that candidate.
  return `import test from 'node:test';
const entries = ${JSON.stringify(entries)};
const results = {};
test('candidates', async () => {
  for (const entry of entries) {
    const outcome = { loaded: false, exported: false, passed: 0, failed: [], error: null };
    try {
      const module = await import('./' + entry.file);
      outcome.loaded = true;
      const fn = module[entry.functionName];
      if (typeof fn === 'function') {
        outcome.exported = true;
        for (const probe of entry.probes) {
          const arg = probe.arg === 'null' ? null : probe.arg === 'undefined' ? undefined : probe.arg;
          let observed;
          try { observed = fn(arg); } catch (error) { observed = 'threw:' + (error && error.name); }
          if (Object.is(observed, probe.expected)) outcome.passed++; else outcome.failed.push({ arg: probe.arg, observed: String(observed), expected: probe.expected });
        }
      }
    } catch (error) { outcome.error = String((error && (error.code || error.name)) + ':' + (error && error.message)).slice(0, 200); }
    results[entry.id] = outcome;
  }
  console.log('VERIFY_RESULTS=' + JSON.stringify(results));
});
`;
}

async function main(): Promise<void> {
  const [jobPath, resultPath] = process.argv.slice(2);
  if (!jobPath || !resultPath) throw new Error('usage: execution-sandbox-verify.ts <job.json> <result.json>');
  const job = JSON.parse(await readFile(jobPath, 'utf8')) as { candidates: Candidate[] };
  const sandbox = new WindowsAppContainerSandbox();
  const availability = await sandbox.available();
  if (!availability.available) {
    await writeFile(resultPath, JSON.stringify({ available: false, message: availability.message }));
    return;
  }
  const results: Record<string, unknown> = {};
  const receipts: unknown[] = [];
  for (let start = 0; start < job.candidates.length; start += BATCH) {
    const batch = job.candidates.slice(start, start + BATCH);
    const files: SandboxFile[] = [];
    const entries = batch.map((candidate, index) => {
      if (!IDENT.test(candidate.functionName)) throw new Error('invalid function name in job');
      const file = `c${index}.ts`;
      files.push({ path: file, content: candidate.content.slice(0, 4000) });
      return { file, id: candidate.id, functionName: candidate.functionName, probes: candidate.probes };
    });
    // Stops Node's package-scope lookup at the work root; the sandbox denies reads above it.
    files.push({ path: 'package.json', content: '{"type":"module","private":true}' });
    files.push({ path: 'verify.test.mjs', content: harness(entries) });
    const receipt = await sandbox.run({ files, testFiles: ['verify.test.mjs'], timeoutMs: 20_000 });
    const line = receipt.stdout.split(/\r?\n/).find(value => value.startsWith('VERIFY_RESULTS='));
    const parsed = line ? JSON.parse(line.slice('VERIFY_RESULTS='.length)) as Record<string, unknown> : {};
    for (const entry of entries) results[entry.id] = parsed[entry.id] ?? { loaded: false, error: 'no_result' };
    receipts.push({ batchStart: start, size: batch.length, exitCode: receipt.exitCode, timedOut: receipt.timedOut,
      durationMs: receipt.durationMs, provider: receipt.provider, network: receipt.network, isolation: receipt.isolation,
      isolationVerified: receipt.isolationVerified, snapshotHash: receipt.snapshotHash });
  }
  await writeFile(resultPath, JSON.stringify({ available: true, provider: availability.provider, receipts, results }));
}

await main();
