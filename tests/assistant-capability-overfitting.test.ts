import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { benchmarkFixtures, caseStringsInSource, sha256 } from './helpers/capability-case-string-audit.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const developmentPath = `${benchmarkFixtures}development.json`;
const frozenBenchmarkCommit = 'a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f';
const frozenDevelopmentSha256 = '712a170d3d60c6aec41f9fe44e7d5cc222bbafbe28d9ca763b5f396db2d2410b';

function readDevelopmentCorpus(): Buffer | undefined {
  const path = join(root, developmentPath);
  if (existsSync(path)) return readFileSync(path);
  const blob = spawnSync('git', ['show', `${frozenBenchmarkCommit}:${developmentPath}`], { cwd: root });
  if (blob.status === 0) return blob.stdout;
  return undefined;
}

const development = readDevelopmentCorpus();
// A fresh feature-only checkout may lack PR #22. Its fetched Git object also works without a scratch merge.
it.skipIf(development === undefined)('keeps frozen development case strings out of the source tree', () => {
  expect(sha256(development!)).toBe(frozenDevelopmentSha256);
  expect(caseStringsInSource(root, development!)).toEqual([]);
});

it('audits the runner’s existing read and reports a source leak without printing its text', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'capability-case-string-'));
  try {
    execFileSync('git', ['init', '-q', scratch]);
    const runner = join(scratch, 'scripts/agent-capability-bench/run.ts');
    const corpusPath = join(scratch, benchmarkFixtures, 'synthetic.json');
    const preload = 'tests/helpers/observe-sealed-capability-read.ts';
    const prompt = 'Which pastry will the moon colony bake in June?';
    mkdirSync(dirname(runner), { recursive: true });
    mkdirSync(dirname(corpusPath), { recursive: true });
    mkdirSync(dirname(join(scratch, preload)), { recursive: true });
    for (const module of [preload, 'tests/helpers/capability-case-string-audit.ts']) {
      cpSync(join(root, module), join(scratch, module));
    }
    writeFileSync(runner, [
      "import { readFile } from 'node:fs/promises';",
      "const corpus = JSON.parse((await readFile(process.argv[3])).toString('utf8'));",
      'console.log(`Runner received ${corpus.cases.length} case.`);',
    ].join('\n'));
    writeFileSync(corpusPath, JSON.stringify({ cases: [{ id: 'synthetic-audit', turns: [{ text: prompt }] }] }));
    writeFileSync(join(scratch, 'sample.ts'), `const prompt = ${JSON.stringify(prompt)};\n`);
    const result = spawnSync(process.execPath, ['--import', join(scratch, preload), runner, '--sealed', corpusPath], {
      cwd: scratch, encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Runner received 1 case.');
    expect(result.stderr).toContain('sample.ts:1 contains synthetic-audit turn 1 text');
    expect(result.stderr).not.toContain(prompt);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
