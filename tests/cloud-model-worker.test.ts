import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/cloud-linux/setup-model-worker.sh', import.meta.url));
const originalRequirements = '# original reviewed lock\n';
const changedRequirements = '# changed reviewed lock\n';
const describeLinux = process.platform === 'linux' ? describe : describe.skip;

interface StubOptions {
  active?: boolean;
  failInstall?: boolean;
  failSwap?: boolean;
  pythonPatch?: number;
}

describeLinux('cloud model worker environment', () => {
  let root: string;
  let release: string;
  let requirements: string;
  let venv: string;
  let bin: string;
  let log: string;

  function stub(name: string, body: string) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mohassan-model-worker-'));
    release = join(root, 'reviewed-release');
    requirements = join(release, 'scripts/cloud-linux/model-worker-requirements-aarch64.txt');
    venv = join(root, 'venv-execution');
    bin = join(root, 'stub-bin');
    log = join(root, 'command-log');
    mkdirSync(bin);
    mkdirSync(dirname(requirements), { recursive: true });
    writeFileSync(requirements, originalRequirements);
    writeFileSync(log, '');

    stub('python', String.raw`
case "$*" in
  --version|'-I --version') printf 'Python 3.12.%s\n' "$TEST_PYTHON_PATCH" ;;
  '-I -m venv '*)
    printf '%s\n' venv >> "$TEST_LOG"
    mkdir -p "$4/bin"
    cp "$TEST_VENV_PYTHON" "$4/bin/python"
    ;;
  '-I - '*)
    printf '%s\n' activate >> "$TEST_LOG"
    [[ "$TEST_FAIL_SWAP" == 0 ]]
    exec /usr/bin/python3 "$@"
    ;;
  *) printf 'Unexpected system Python call: %s\n' "$*" >&2; exit 2 ;;
esac`);

    stub('venv-python', String.raw`
case " $* " in
  *' -m pip '*' install '*)
    printf '%s\n' install >> "$TEST_LOG"
    [[ " $* " == *' --require-hashes '* ]]
    while [[ "$1" != --requirement ]]; do shift; done
    cp "$2" "$(dirname "$(dirname "$0")")/installed-requirements"
    [[ "$TEST_FAIL_INSTALL" == 0 ]]
    ;;
  *' -m pip '*' check '*)
    printf '%s\n' check >> "$TEST_LOG"
    [[ ! -e "$(dirname "$(dirname "$0")")/reject-check" ]]
    ;;
  ' -I -B - '*)
    printf '%s\n' probe >> "$TEST_LOG"
    probe=$(cat)
    [[ "$probe" == *'from model_worker.engine import load_engine, torch'* ]]
    [[ ! -e "$(dirname "$(dirname "$0")")/reject-probe" ]]
    ;;
  *) printf 'Unexpected venv Python call: %s\n' "$*" >&2; exit 2 ;;
esac`);

    stub('runuser', String.raw`
[[ "$1 $2 $3 $4 $5" == '-u mohassan -- env -i' ]]
shift 5
while [[ "$1" == *=* ]]; do shift; done
exec "$@"`);

    stub('systemctl', String.raw`
[[ "$*" == 'show --property=ActiveState --value mohassan.service' ]]
printf '%s\n' "$TEST_SERVICE_STATE"`);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(mode: '--stage' | '--activate' | '--setup', options: StubOptions = {}) {
    return spawnSync('bash', ['-eu', '-o', 'pipefail', '-c',
      'source "$1"; setup_model_worker "$2" "$3" "$4" "$5"',
      'test', script, mode, release, venv, join(bin, 'python')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_LOG: log,
        TEST_VENV_PYTHON: join(bin, 'venv-python'),
        TEST_SERVICE_STATE: options.active ? 'active' : 'inactive',
        TEST_FAIL_INSTALL: options.failInstall ? '1' : '0',
        TEST_FAIL_SWAP: options.failSwap ? '1' : '0',
        TEST_PYTHON_PATCH: String(options.pythonPatch ?? 0),
      },
    });
  }

  function runSuccessfully(mode: '--stage' | '--activate' | '--setup', options?: StubOptions) {
    const result = run(mode, options);
    expect(result.status, result.stderr).toBe(0);
  }

  function events() {
    return readFileSync(log, 'utf8').split('\n').filter(Boolean);
  }

  it('defines setup functions without applying host changes when sourced', () => {
    const result = spawnSync('bash', ['-euc',
      'before=$(umask); source "$1" --invalid-mode; [[ $(umask) == "$before" ]]; declare -F setup_model_worker >/dev/null',
      'test', script], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('reuses a stamped environment after pip check and the probe pass', () => {
    runSuccessfully('--setup');
    const active = realpathSync(venv);
    writeFileSync(log, '');

    runSuccessfully('--stage', { active: true });
    expect(events()).toEqual(['check', 'probe']);
    runSuccessfully('--activate');
    expect(events()).not.toContain('install');
    expect(events()).not.toContain('activate');
    expect(realpathSync(venv)).toBe(active);
  });

  it('builds changed requirements beside the live venv and swaps after stopping the service', () => {
    runSuccessfully('--setup');
    const previous = realpathSync(venv);
    writeFileSync(requirements, changedRequirements);
    writeFileSync(log, '');

    runSuccessfully('--stage', { active: true });
    expect(events()).toEqual(['venv', 'install', 'check', 'probe']);
    expect(realpathSync(venv)).toBe(previous);
    expect(readFileSync(join(venv, 'installed-requirements'), 'utf8')).toBe(originalRequirements);
    expect(run('--activate', { active: true }).status).not.toBe(0);
    expect(realpathSync(venv)).toBe(previous);

    runSuccessfully('--activate');
    expect(realpathSync(venv)).not.toBe(previous);
    expect(dirname(realpathSync(venv))).toBe(dirname(venv));
    expect(readFileSync(join(venv, 'installed-requirements'), 'utf8')).toBe(changedRequirements);
    expect(events().filter(event => event === 'install')).toHaveLength(1);
    expect(events().filter(event => event === 'activate')).toHaveLength(1);
  });

  it('atomically replaces a legacy real directory and retains it as a backup', () => {
    mkdirSync(venv);
    writeFileSync(join(venv, 'old-venv-marker'), 'legacy environment');
    runSuccessfully('--stage', { active: true });
    expect(lstatSync(venv).isDirectory()).toBe(true);

    runSuccessfully('--activate');
    expect(lstatSync(venv).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(venv, 'installed-requirements'), 'utf8')).toBe(originalRequirements);
    const backup = readdirSync(root).find(name => existsSync(join(root, name, 'old-venv-marker')));
    expect(backup).toBeDefined();
    expect(readFileSync(join(root, backup!, 'old-venv-marker'), 'utf8')).toBe('legacy environment');

    writeFileSync(requirements, changedRequirements);
    runSuccessfully('--stage', { active: true });
    runSuccessfully('--activate');
    expect(readFileSync(join(venv, 'installed-requirements'), 'utf8')).toBe(changedRequirements);
  });

  it('stages a new environment when the Python patch version changes', () => {
    runSuccessfully('--setup');
    const active = realpathSync(venv);
    writeFileSync(log, '');

    runSuccessfully('--stage', { active: true, pythonPatch: 1 });
    expect(events()).toEqual(['venv', 'install', 'check', 'probe']);
    expect(realpathSync(venv)).toBe(active);
    runSuccessfully('--activate', { pythonPatch: 1 });
    expect(realpathSync(venv)).not.toBe(active);
  });

  it('keeps the previous environment usable if a changed-requirements install fails', () => {
    runSuccessfully('--setup');
    const active = realpathSync(venv);
    writeFileSync(requirements, changedRequirements);
    writeFileSync(log, '');

    expect(run('--stage', { active: true, failInstall: true }).status).not.toBe(0);
    expect(realpathSync(venv)).toBe(active);
    expect(readFileSync(join(venv, 'installed-requirements'), 'utf8')).toBe(originalRequirements);
    expect(events()).toEqual(['venv', 'install']);
    expect(run('--activate').status).not.toBe(0);
    expect(events()).toEqual(['venv', 'install']);
    expect(realpathSync(venv)).toBe(active);
  });

  it('leaves both environments usable when activation fails and retries without installing', () => {
    runSuccessfully('--setup');
    const active = realpathSync(venv);
    writeFileSync(requirements, changedRequirements);
    runSuccessfully('--stage', { active: true });
    const staged = realpathSync(`${venv}.staged`);
    writeFileSync(log, '');

    expect(run('--activate', { failSwap: true }).status).not.toBe(0);
    expect(realpathSync(venv)).toBe(active);
    expect(realpathSync(`${venv}.staged`)).toBe(staged);
    runSuccessfully('--activate');
    expect(realpathSync(venv)).toBe(staged);
    expect(realpathSync(`${venv}.staged`)).toBe(active);
    expect(events()).not.toContain('install');
  });

  it.each(['check', 'probe'])('rebuilds a matching stamped environment when its %s fails', failure => {
    runSuccessfully('--setup');
    const active = realpathSync(venv);
    writeFileSync(join(active, `reject-${failure}`), 'broken');
    writeFileSync(log, '');

    runSuccessfully('--stage', { active: true });
    expect(events()).toContain(failure);
    expect(events()).toContain('install');
    expect(realpathSync(venv)).toBe(active);
    runSuccessfully('--activate');
    expect(realpathSync(venv)).not.toBe(active);
    expect(existsSync(join(venv, `reject-${failure}`))).toBe(false);
  });
});
