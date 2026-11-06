/** --live means real LOCAL disposable fixtures, not a configured service. */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== '--live') {
  process.stdout.write('Usage: node --import tsx scripts/check-skills.ts --live\n--live runs real LOCAL isolated instruction/read/write fixtures only. No configured server, production database, credentials, dotenv or external provider is used. Without this exact flag, no fixture is created.\n');
  process.exitCode = args.length && args[0] !== '--help' ? 2 : 0;
} else {
  try { await checkLocalSkills(); } catch (error) { process.stderr.write(`Local skill verification failed: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exitCode = 1; }
}

async function checkLocalSkills() {
  // Keep implementation imports behind the explicit invocation guard.
  const [{ SkillContractSchema }, { migrate }, { migrateAuth }, { createSkillControl, skillsMigration }, { createSkillBenchmarkControl }, { scoreSkillEvaluation }, { SkillBenchmarkSuiteSchema }, { getSkillBenchmarkSuite }, { createBenchmarkDatabase }, { createSkillBenchmarkRunner }] = await Promise.all([
    import('@mohassan/contracts'), import('@mohassan/database'), import('../apps/server/src/auth.ts'), import('@mohassan/skills'), import('../packages/skills/src/benchmark.ts'), import('../packages/skills/src/quality.ts'),
    import('../packages/contracts/src/skill-benchmarks.ts'), import('../packages/skills/src/benchmark-suites.ts'), import('../apps/server/src/skill-benchmark-isolation.ts'), import('../apps/server/src/skill-benchmark-runner.ts'),
  ]);
  const base = await realpath(tmpdir()), directory = await realpath(await mkdtemp(join(base, 'mohassan-benchmark-cli-')));
  let store: Awaited<ReturnType<typeof createBenchmarkDatabase>> | undefined, control: ReturnType<typeof createSkillBenchmarkControl> | undefined, interrupted = false;
  const stop = () => { interrupted = true; void control?.shutdown(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const evaluations: unknown[] = [], summaries: unknown[] = [];
  try {
    store = await createBenchmarkDatabase(); await migrateAuth(store.db); await migrate(store.db); await skillsMigration(store.db);
    const ownerId = randomUUID(); await store.db.insertInto('user').values({ id: ownerId, name: 'Local benchmark CLI fixture owner', email: `benchmark-cli-${ownerId}@example.test` }).execute();
    const skills = createSkillControl(store.db, { allowedRoots: [directory], executableReady: async () => false });
    control = createSkillBenchmarkControl(store.db, { suite: id => SkillBenchmarkSuiteSchema.parse(getSkillBenchmarkSuite(id)), runner: createSkillBenchmarkRunner() });
    for (const fixture of [{ folder: 'instruction', suite: 'instruction-delivery-v1' }, { folder: 'file-read', suite: 'file-read-correctness-v1' }, { folder: 'file-write', suite: 'file-write-correctness-v1' }] as const) {
      if (interrupted) break;
      const contract = SkillContractSchema.parse(JSON.parse(await readFile(new URL(`../tests/fixtures/skills/benchmarks/${fixture.folder}/skill.contract.json`, import.meta.url), 'utf8')));
      const instructions = await readFile(new URL(`../tests/fixtures/skills/benchmarks/${fixture.folder}/SKILL.md`, import.meta.url), 'utf8');
      const versions = [];
      for (const arm of ['baseline', 'candidate'] as const) {
        const source = join(directory, `${fixture.folder}-${arm}`); await mkdir(source);
        const copy = arm === 'baseline' ? contract : SkillContractSchema.parse({ ...contract, version: '1.0.1' });
        const text = arm === 'baseline' ? instructions : `${instructions.replace('version: 1.0.0', 'version: 1.0.1')}\nKeep the original evidence identifiers visible.\n`;
        await writeFile(join(source, 'SKILL.md'), text, { flag: 'wx' }); await writeFile(join(source, 'skill.contract.json'), JSON.stringify(copy), { flag: 'wx' });
        const imported = (await skills.importLocal(ownerId, { path: source })).skill;
        versions.push((await skills.inspect(ownerId, imported.id, { expectedRevision: imported.revision })).skill);
      }
      const [baseline, candidate] = versions;
      const evaluation = await control.execute(ownerId, { baselineId: baseline.id, baselineRevision: baseline.revision, candidateId: candidate.id, candidateRevision: candidate.revision, suiteId: fixture.suite }, randomUUID());
      evaluations.push(evaluation);
      summaries.push({ suiteId: fixture.suite, evaluationId: evaluation.id, status: evaluation.status, passed: evaluation.cases.filter(result => result.status === 'passed').length,
        failed: evaluation.cases.filter(result => result.status === 'failed').length, blocked: evaluation.cases.filter(result => result.status === 'blocked').length, unknown: evaluation.cases.filter(result => result.status === 'unknown').length,
        quality: scoreSkillEvaluation(evaluation) });
      if (evaluation.status !== 'completed' || evaluation.cases.some(result => result.status !== 'passed')) process.exitCode = 1;
    }
    if (interrupted) process.exitCode = 130;
  } finally {
    try { await control?.shutdown(); } finally {
      try { await store?.close(); } finally {
        process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
        const target = await realpath(directory), inside = relative(base, target);
        if (target !== directory || isAbsolute(inside) || inside.startsWith('..') || inside.includes('/') || inside.includes('\\') || !inside.startsWith('mohassan-benchmark-cli-')) throw new Error('Unsafe local benchmark cleanup');
        await rm(target, { recursive: true, force: true });
      }
    }
  }
  process.stdout.write(`${JSON.stringify({ mode: 'real_local_isolated_fixtures', cleanup: 'completed', externalServices: false, productionState: false,
    limitations: ['Instruction delivery is not semantic-quality measurement.', 'Safety applies to the fixed file/delivery cases, not sandbox guarantees.', 'Recovery is measured only for the confirmed-receipt worker checkpoint.', 'Monetary cost is unknown.'], summaries, evaluations }, null, 2)}\n`);
}
