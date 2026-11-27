import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const prepare = fileURLToPath(new URL('../scripts/cloud-linux/prepare.sh', import.meta.url));
const describeLinux = process.platform === 'linux' ? describe : describe.skip;

// The locked CLI looks for Inst lines in the simulated install and exits nonzero on errors.
// https://github.com/microsoft/playwright/blob/v1.64.1/packages/playwright-core/src/server/registry/dependencies.ts#L92-L148
// Retrieved 2026-11-27.
const dryRun = [
  'node install-deps --dry-run chromium',
  'apt-get install -s --no-install-recommends',
];
const install = [
  'node install-deps chromium',
  'apt-get update',
  'apt-get install -y --no-install-recommends',
];

describeLinux('cloud Linux preparation', () => {
  let root: string;
  let log: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mohassan-cloud-prepare-'));
    log = join(root, 'commands');
    writeFileSync(join(root, 'node'), `#!/bin/bash
set -eu
[[ $1 == locked-playwright-cli.js ]]
shift
printf 'node %s\\n' "$*" >> "$COMMAND_LOG"
case "$*" in
    'install-deps --dry-run chromium')
        [[ $LC_ALL == C ]]
        simulation=$(apt-get install -s --no-install-recommends)
        case "$simulation" in
            'Inst '*) exit 1 ;;
        esac
        ;;
    'install-deps chromium')
        apt-get update
        apt-get install -y --no-install-recommends
        ;;
    *) exit 2 ;;
esac
`, { mode: 0o700 });
    writeFileSync(join(root, 'apt-get'), `#!/bin/bash
set -eu
printf 'apt-get %s\\n' "$*" >> "$COMMAND_LOG"
case "$*:$APT_STATE" in
    'install -s --no-install-recommends:missing') printf 'Inst fixture-package (...)\\n' ;;
    'install -s --no-install-recommends:simulation-error'|'install -s --no-install-recommends:install-error')
        exit 1 ;;
    'install -y --no-install-recommends:install-error') exit 100 ;;
esac
`, { mode: 0o700 });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(aptState: string) {
    const result = spawnSync('/bin/bash', [
      '-euc', 'source "$1"; ensure_chromium_system_dependencies node locked-playwright-cli.js', 'test', prepare,
    ], {
      encoding: 'utf8',
      env: { PATH: root, COMMAND_LOG: log, APT_STATE: aptState },
    });
    return { result, commands: readFileSync(log, 'utf8').trimEnd().split('\n') };
  }

  it('can be sourced without running host preparation', () => {
    const result = spawnSync('/bin/bash', [
      '-euc', 'source "$1"; declare -F prepare_main', 'test', prepare,
    ], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('prepare_main');
  });

  it('makes no updating or installing apt calls when dependencies are present', () => {
    const { result, commands } = run('present');
    expect(result.status, result.stderr).toBe(0);
    expect(commands).toEqual(dryRun);
  });

  it.each(['missing', 'simulation-error'])('runs the original install for %s', aptState => {
    const { result, commands } = run(aptState);
    expect(result.status, result.stderr).toBe(0);
    expect(commands).toEqual([...dryRun, ...install]);
  });

  it('propagates an error from the real install', () => {
    const { result, commands } = run('install-error');
    expect(result.status, result.stderr).toBe(100);
    expect(commands).toEqual([...dryRun, ...install]);
  });
});
