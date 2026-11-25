import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { downloadSource, sha256, upstreamNoticePins } from '../scripts/agent-capability-bench/v2/sources.js';

const checkout = fileURLToPath(new URL('../', import.meta.url));
const bundle = 'tests/fixtures/agent-capability-bench/v2/sealed';

it('allows the canonical checkout seed while keeping importer output outside the checkout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mohassan-release-import-'));
  try {
    const cache = join(directory, 'cache');
    await mkdir(cache, { mode: 0o700 });
    await writeFile(join(cache, 'clinc150.json'), 'TAMPERED_ARTIFACT_SENTINEL');
    const run = (seed: string, out: string) => spawnSync(process.execPath, [
      '--import', 'tsx', 'scripts/agent-capability-bench/v2/import.ts', '--cache', cache,
      '--seed', seed, '--out', out,
    ], { cwd: checkout, encoding: 'utf8' });
    const validSeed = run(`${bundle}/sampling-v2.seed`, join(directory, 'release'));
    expect(validSeed.status).toBe(1);
    expect(validSeed.stderr.trim()).toBe('SHA-256 mismatch for clinc150.json.');

    const otherCheckoutSeed = run(`${bundle}/README.md`, join(directory, 'release'));
    expect(otherCheckoutSeed.status).toBe(1);
    expect(otherCheckoutSeed.stderr.trim()).toBe('Could not prepare private directories and seed.');

    const checkoutOutput = run(`${bundle}/sampling-v2.seed`, `${bundle}/release`);
    expect(checkoutOutput.status).toBe(1);
    expect(checkoutOutput.stderr.trim()).toBe('Could not prepare private directories and seed.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

it('verifies cached upstream attribution bytes before release assembly', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'mohassan-notice-cache-'));
  const name = 'GSM8K-LICENSE.txt';
  try {
    const license = await readFile(join(checkout, bundle, 'attribution', name));
    const cached = join(cache, name);
    await writeFile(cached, license);
    expect(sha256(await downloadSource(cache, name))).toBe(upstreamNoticePins[name].sha256);
    await writeFile(cached, 'TAMPERED_NOTICE_SENTINEL');
    await expect(downloadSource(cache, name)).rejects.toThrow(`SHA-256 mismatch for ${name}.`);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});
