import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const fixtures = fileURLToPath(new URL('./fixtures/agent-capability-bench/v2', import.meta.url));
const importer = fileURLToPath(new URL('../scripts/agent-capability-bench/v2/import-dev.ts', import.meta.url));
const run = (cache: string, out: string) => promisify(execFile)(process.execPath,
  ['--import', 'tsx', importer, '--cache', cache, '--out', out], { timeout: 10_000 });

it.each([
  { split: 'sealed', label: 'sealed release' },
  { split: 'dev', label: 'committed development' },
])('rejects cache and output paths into the $label, including through a symlink', async ({ split, label }) => {
  const scratch = await mkdtemp(join(tmpdir(), 'mohassan-development-path-'));
  const bundle = join(fixtures, split);
  const alias = join(scratch, 'bundle-alias');
  const protectedChild = basename(scratch);
  const cache = join(scratch, 'source-cache');
  const out = join(scratch, 'output');
  try {
    await symlink(bundle, alias, 'dir');
    await mkdir(cache);
    await writeFile(join(cache, 'clinc150.json'), 'TAMPERED_ARTIFACT_SENTINEL');
    const expected = {
      code: 1, stdout: '', stderr: `Development cache and output paths must be outside the ${label} directory.\n`,
    };
    for (const directory of [bundle, alias]) {
      const nested = join(directory, protectedChild, 'missing');
      await expect(run(nested, out)).rejects.toMatchObject(expected);
      await expect(run(cache, nested)).rejects.toMatchObject(expected);
    }
    await expect(stat(join(bundle, protectedChild))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(out)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(join(bundle, protectedChild), { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
}, 45_000);
