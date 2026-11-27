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

test('runs typecheck, the full Vitest suite and pytest discovery in order', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  run.mockReturnValue(commandResult(0));

  expect(runProductionGate(npmCli)).toBe(0);
  expect(run.mock.calls.map(([executable, args]) => [executable, args])).toEqual([
    [process.execPath, [npmCli, 'run', 'typecheck']],
    [process.execPath, [npmCli, 'test']],
    ['python', ['-B', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', 'scripts']],
  ]);
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/Production gate PASSED \(3\/3 checks, \d+\.\d{2}s\)/));
});

test('keeps running the other checks after a failure and marks the gate failed', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  run.mockReturnValueOnce(commandResult(2)).mockReturnValue(commandResult(0));

  expect(runProductionGate(npmCli)).toBe(1);
  expect(run).toHaveBeenCalledTimes(3);
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/Production gate FAILED \(2\/3 checks, \d+\.\d{2}s\)/));
  expect(log).toHaveBeenCalledWith(expect.stringContaining('Typecheck FAIL'));
  expect(log).toHaveBeenCalledWith(expect.stringContaining('Vitest PASS'));
  expect(log).toHaveBeenCalledWith(expect.stringContaining('pytest PASS'));
});

test('reports a Python interpreter that cannot start as a failed check', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  run.mockReturnValueOnce(commandResult(0)).mockReturnValueOnce(commandResult(0)).mockReturnValueOnce({
    ...commandResult(0), status: null, error: new Error('spawnSync python ENOENT'),
  });

  expect(runProductionGate(npmCli)).toBe(1);
  expect(error).toHaveBeenCalledWith('pytest could not start (spawnSync python ENOENT).');
  expect(log).toHaveBeenCalledWith(expect.stringContaining('pytest FAIL'));
});
