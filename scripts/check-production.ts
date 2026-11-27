import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));

export function runProductionGate(npmCli: string | undefined): number {
  if (!npmCli) {
    console.error('Run this check with npm run test:gate.');
    return 1;
  }

  const checks = [
    { name: 'Typecheck', executable: process.execPath, args: [npmCli, 'run', 'typecheck'] },
    { name: 'Vitest', executable: process.execPath, args: [npmCli, 'test'] },
    {
      name: 'Scratch benchmark', executable: process.execPath,
      args: [npmCli, 'test', '--', 'packages/scratch-classifiers/src/index.test.ts', '--mode', 'scratch-benchmark'],
    },
    { name: 'pytest', executable: 'python', args: ['-B', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', 'scripts'] },
  ];
  const startedAt = performance.now();
  const results = checks.map(({ name, executable, args }) => {
    const checkStartedAt = performance.now();
    const result = spawnSync(executable, args, { cwd: repository, stdio: 'inherit', windowsHide: true });
    if (result.error) console.error(`${name} could not start (${result.error.message}).`);
    if (result.signal) console.error(`${name} exited on ${result.signal}.`);
    return { name, passed: result.status === 0, seconds: (performance.now() - checkStartedAt) / 1_000 };
  });

  const passed = results.filter(result => result.passed).length;
  const success = passed === results.length;
  const seconds = (performance.now() - startedAt) / 1_000;
  console.log(`\nProduction gate ${success ? 'PASSED' : 'FAILED'} (${passed}/${results.length} checks, ${seconds.toFixed(2)}s)`);
  for (const result of results) {
    console.log(`  ${result.name} ${result.passed ? 'PASS' : 'FAIL'} (${result.seconds.toFixed(2)}s)`);
  }
  return success ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runProductionGate(process.env.npm_execpath);
}
