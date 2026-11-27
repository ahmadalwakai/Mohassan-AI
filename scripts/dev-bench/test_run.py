"""Exercise the arm planner, installation reuse, and holdout exclusions."""

from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys

import pytest

import runner


DIRECTORY = Path(__file__).resolve().parent
PRODUCTION = DIRECTORY / 'profiles' / 'production-2026-11-26.json'
COMMIT = '0' * 40
REASONING = 'MOHASSAN_REASONING'
COMPILER = 'MOHASSAN_PLAN_COMPILER'
SHADOW = 'MOHASSAN_CONVERSATION_SHADOW'


def dry_run(*args, profile=PRODUCTION):
    return subprocess.run(
        [sys.executable, '-B', str(DIRECTORY / 'run.py'), '--dry-run', '--profile', str(profile),
         '--arm', f'profile={COMMIT}', *args],
        env={'PATH': ''}, capture_output=True, text=True,
    )


def test_dry_run_reports_only_single_switch_changes_without_runtime(tmp_path):
    output = tmp_path / 'uncreated'
    process = dry_run('--ablate', f'{REASONING},{COMPILER},{SHADOW}', '--output', str(output),
                      '--set', 'profile:TEST_DRIVEN_CODING_PYTHON=/usr/local/bin/python3.12')
    assert process.returncode == 0, process.stderr
    plan = json.loads(process.stdout)
    assert not output.exists()
    assert plan['split'] == 'development'
    assert plan['installCommits'] == [COMMIT]
    assert plan['auditMonitors'] is True
    assert plan['profile']['sha256'] == sha256(PRODUCTION.read_bytes()).hexdigest()
    assert 'MOHASSAN_MODEL_WORKER' in plan['profile']['deploymentOnly']
    assert list(plan['arms']) == ['profile', REASONING, COMPILER, SHADOW]
    baseline = plan['arms']['profile']['settings']
    assert baseline['MOHASSAN_MONITORS_ENABLED'] == 'owner'
    assert baseline['TEST_DRIVEN_CODING_PYTHON'] == '/usr/local/bin/python3.12'
    assert 'MOHASSAN_MODEL_WORKER' not in baseline
    for switch, value in ((REASONING, '1'), (COMPILER, 'on'), (SHADOW, 'decide')):
        arm = plan['arms'][switch]
        assert arm == {'commit': COMMIT, 'settings': baseline | {switch: value}}
        assert baseline[switch] != value


def test_all_covers_every_disabled_production_profile_switch():
    profile = json.loads(PRODUCTION.read_text())
    assert profile['sources'].keys() == profile['flags'].keys() | profile['deployment_only'].keys()
    assert all(profile['sources'].values())
    process = dry_run('--ablate', 'all')
    assert process.returncode == 0, process.stderr
    plan = json.loads(process.stdout)
    assert set(plan['arms']) == {'profile', *profile['flags']} - {'MOHASSAN_MONITORS_ENABLED'}
    for name, arm in plan['arms'].items():
        expected = profile['flags'].copy()
        if name != 'profile':
            expected[name] = runner.ENABLE_SWITCH[name][1]
            assert expected[name] != profile['flags'][name]
        assert arm['settings'] == expected


@pytest.mark.parametrize(('args', 'error'), [
    (('--ablate', f'{COMPILER},{COMPILER}'), 'duplicate switch'),
    (('--ablate', 'MOHASSAN_MONITORS_ENABLED'), 'not a disabled benchmark switch'),
    (('--ablate', 'MOHASSAN_V5_CHAT'), 'not a disabled benchmark switch'),
    (('--ablate', f'{REASONING},'), 'not a disabled benchmark switch'),
    (('--set', f'profile:{REASONING}=1'), 'edit the profile'),
    (('--arm', f'other={COMMIT}'), 'exactly one --arm profile=COMMIT'),
])
def test_invalid_profile_plans_fail_before_launch(args, error):
    process = dry_run(*args)
    assert process.returncode == 2
    assert error in process.stderr


def test_partial_profile_cannot_inherit_benchmark_defaults(tmp_path):
    path = tmp_path / 'profile.json'
    path.write_text(json.dumps({'flags': {REASONING: '0'}}))
    process = dry_run(profile=path)
    assert process.returncode == 2
    assert 'profile must explicitly set legacy defaults' in process.stderr


def test_legacy_plan_still_accepts_arm_overrides():
    process = subprocess.run(
        [sys.executable, '-B', str(DIRECTORY / 'run.py'), '--dry-run', '--arm', f'legacy={COMMIT}',
         '--set', f'legacy:{SHADOW}=0'],
        env={'PATH': ''}, capture_output=True, text=True, check=True,
    )
    plan = json.loads(process.stdout)
    assert plan['arms']['legacy']['settings'] == runner.BASE_FLAGS | {SHADOW: '0'}


def test_reuses_install_and_keeps_dependency_copies_isolated(tmp_path, monkeypatch):
    calls = []

    def fake_install(args, cwd, environment, log):
        calls.append(args)
        log.write_text('installed\n')
        (cwd / 'node_modules').mkdir()
        (cwd / 'node_modules' / 'module').symlink_to('../apps/example')
        package = cwd / 'apps' / 'example' / 'node_modules' / 'nested'
        package.mkdir(parents=True)
        (package / 'entry.js').write_text('original')

    monkeypatch.setattr(runner, 'run_logged', fake_install)
    snapshot = tmp_path / 'snapshot'
    install = ['npm', 'ci']
    for name in ('first', 'second'):
        output = tmp_path / name
        checkout = output / 'product'
        checkout.mkdir(parents=True)
        runner.install_for_arm(checkout, output, output, {'PATH': '/usr/bin:/bin'}, install, snapshot, False)
        assert (output / 'npm-ci.log').read_text() == 'installed\n'
        assert (checkout / 'node_modules' / 'module').readlink() == Path('../apps/example')
        entry = checkout / 'apps' / 'example' / 'node_modules' / 'nested' / 'entry.js'
        assert entry.read_text() == 'original'
        entry.write_text('changed by arm')
    assert calls == [install]


def test_pinned_installer_rejects_every_holdout_before_blob_read(tmp_path, monkeypatch):
    for holdout in runner.HOLDOUTS:
        def listed_paths(repo, command, *args):
            assert command == 'ls-tree'
            return f'{holdout}/case.json\0'.encode()

        monkeypatch.setattr(runner, 'git', listed_paths)
        with pytest.raises(ValueError, match='development inputs only'):
            runner.install_inputs(tmp_path, tmp_path, COMMIT, (holdout,), {}, 'v2')
