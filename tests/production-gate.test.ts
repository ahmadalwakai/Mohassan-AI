import { spawnSync } from 'node:child_process';
import { afterEach, expect, test, vi } from 'vitest';
import { runProductionGate } from '../scripts/check-production.ts';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

const run = vi.mocked(spawnSync);
const npmCli = 'npm-cli.js';

function commandResult(status: number) {
  return { pid: 1, status, signal: null, stdout: '', stderr: '', output: [] };
}

afterEach(() => {
  run.mockReset();
  vi.restoreAllMocks();
});

test('runs typecheck, the full Vitest suite, the scratch benchmark and pytest in order', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  run.mockReturnValue(commandResult(0));

  expect(runProductionGate(npmCli)).toBe(0);
  expect(run.mock.calls.map(([executable, args]) => [executable, args])).toEqual([
    [process.execPath, [npmCli, 'run', 'typecheck']],
    [process.execPath, [npmCli, 'test']],
    [process.execPath, [npmCli, 'test', '--', 'packages/scratch-classifiers/src/index.test.ts', '--mode', 'scratch-benchmark']],
    ['python', ['-B', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', 'scripts']],
  ]);
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/Production gate PASSED \(4\/4 checks, \d+\.\d{2}s\)/));
  expect(log).toHaveBeenCalledWith(expect.stringContaining('Scratch benchmark PASS'));
});

test.each([
  { failedCheck: 'Typecheck', statuses: [2, 0, 0, 0] },
  { failedCheck: 'Scratch benchmark', statuses: [0, 0, 2, 0] },
])('keeps running the other checks when $failedCheck fails', ({ failedCheck, statuses }) => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const status of statuses) run.mockReturnValueOnce(commandResult(status));

  expect(runProductionGate(npmCli)).toBe(1);
  expect(run).toHaveBeenCalledTimes(4);
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/Production gate FAILED \(3\/4 checks, \d+\.\d{2}s\)/));
  expect(log).toHaveBeenCalledWith(expect.stringContaining(`${failedCheck} FAIL`));
  expect(log).toHaveBeenCalledWith(expect.stringContaining('Vitest PASS'));
  expect(log).toHaveBeenCalledWith(expect.stringContaining('pytest PASS'));
});

test('reports a Python interpreter that cannot start as a failed check', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  run.mockReturnValueOnce(commandResult(0)).mockReturnValueOnce(commandResult(0)).mockReturnValueOnce(commandResult(0))
    .mockReturnValueOnce({ ...commandResult(0), status: null, error: new Error('spawnSync python ENOENT') });

  expect(runProductionGate(npmCli)).toBe(1);
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/Production gate FAILED \(3\/4 checks, \d+\.\d{2}s\)/));
  expect(error).toHaveBeenCalledWith('pytest could not start (spawnSync python ENOENT).');
  expect(log).toHaveBeenCalledWith(expect.stringContaining('pytest FAIL'));
});
