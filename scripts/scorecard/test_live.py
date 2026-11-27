from pathlib import Path
from types import SimpleNamespace
from hashlib import sha256

import pytest

from scripts.scorecard import live
from scripts.scorecard.receipts import validate_arm_receipt


def test_native_scores_keep_area_and_language_and_only_use_observed_samples(tmp_path):
    raw = tmp_path / 'receipt.json'
    log = tmp_path / 'v1.log'
    versions = {
        'v1': {'scores': [{'id': 'doc-ar', 'area': 'document-file', 'language': 'ar', 'passed': True,
                           'scorecard': {'expectedTurns': 2, 'peakRssBytes': 4096, 'diskBytes': 0, 'residentBytes': 0,
                                         'turns': [{'firstProgressMs': 2, 'finalAnswerMs': 8, 'cpuMs': 5}, None]}}]},
        'v2': {'scores': [{'id': 'math-en', 'area': 'calculation', 'language': 'en', 'passed': False,
                           'scorecard': {'expectedTurns': 1, 'peakRssBytes': 8192, 'diskBytes': 0, 'residentBytes': 0,
                                         'turns': [{'firstProgressMs': None, 'finalAnswerMs': None, 'cpuMs': 3}]}}]},
    }
    source = {'commands': {'v1.log': {'command': ['node', 'fixture.ts'], 'recorded_at': '2026-11-27T01:00:00Z',
                                      'raw_output': str(log)}}}
    result = live.normalize_development({'id': 'candidate', 'commit': 'a' * 40}, source, versions, raw, ['python', '-m', 'scripts.scorecard'])
    validate_arm_receipt(result)
    assert result['cases'] == [
        {'suite_id': 'dev-bench-v1', 'case_id': 'doc-ar', 'family': 'document-file', 'language': 'ar', 'correct': True},
        {'suite_id': 'dev-bench-v2', 'case_id': 'math-en', 'family': 'calculation', 'language': 'en', 'correct': False},
    ]
    assert result['turns_by_language'] == {'ar': 2, 'en': 1}
    assert result['samples_by_language'] == {
        'first_progress_ms': {'ar': 1, 'en': 0}, 'final_answer_ms': {'ar': 1, 'en': 0}, 'cpu_ms_per_turn': {'ar': 1, 'en': 1},
    }
    assert result['metrics'] == {'first_progress_ms': [2], 'final_answer_ms': [8], 'cpu_ms_per_turn': [5, 3],
                                 'peak_rss_bytes': 8192, 'model_files_bytes': 0, 'resident_worker_bytes': 0}
    assert result['evidence']['raw_output'] == str(raw)
    assert result['sources'] == list(source['commands'].values())


def test_arm_profiles_and_private_command_redaction():
    baseline, production = live.default_arms(Path(__file__).resolve().parents[2])
    assert baseline['switches']['MOHASSAN_MODEL_RELATIONS'] == 'off'
    assert baseline['switches']['MOHASSAN_SCRATCH_CLASSIFIERS'] == '0'
    assert baseline['switches']['MOHASSAN_JUDGE_SHADOW'] == '0'
    assert production['switches']['MOHASSAN_MODEL_RELATIONS'] == 'shadow'
    assert production['switches']['MOHASSAN_SCRATCH_CLASSIFIERS'] == '1'
    assert live._public_args(['--private-suite', '/owner/questions', '--private-evaluator=/owner/scorer', '--offline']) == [
        '--private-suite', '<owner-local>', '--private-evaluator', '<owner-local>', '--offline',
    ]


@pytest.mark.parametrize(("allowed", "expected"), [
    ({"off", "on"}, "off"),
    ({"0", "off", "false"}, "0"),
    ({"off", "false"}, "off"),
    ({"false", "true"}, "false"),
])
def test_baseline_uses_the_first_supported_off_value(allowed, expected):
    bench = SimpleNamespace(OVERRIDES={"SYNTHETIC_SWITCH": allowed}, BASE_FLAGS={})
    baseline, _ = live._profiles(bench)
    assert baseline["SYNTHETIC_SWITCH"] == expected


def test_baseline_refuses_a_switch_without_a_supported_off_value():
    bench = SimpleNamespace(OVERRIDES={"SYNTHETIC_SWITCH": {"on", "shadow"}}, BASE_FLAGS={})
    with pytest.raises(ValueError, match="SYNTHETIC_SWITCH has no supported off value"):
        live._profiles(bench)


def test_scorecard_preserves_the_replies_tail_for_later_scoring_hooks(tmp_path, monkeypatch):
    root = Path(__file__).resolve().parents[2]
    runner = tmp_path / "run.ts"
    runner.write_text(
        "for (const item of cases) scores.push(scoreCapabilityCase(item, await observe(item)));\n"
        "summary, splits: results,\n"
    )
    monkeypatch.setattr(live, "_instrument_observer", lambda *_: None)
    with live.development_modules(root) as (_, bench):
        live._instrument_runner(runner, "v1", bench, {})
    source = runner.read_text()
    assert "scorecard: { turns:" in source
    assert source.count("replies: observation.turns.map(turn => turn.answer) });") == 1


@pytest.mark.parametrize("explicit_archive", [False, True], ids=["legacy-archive", "explicit-archive"])
def test_worktree_hides_protected_paths_and_uses_content_free_audit_merge(tmp_path, explicit_archive):
    commands = []
    archives = []
    audit = 'b' * 40
    holdouts = ('native-sealed',)
    extra_exclusions = (*holdouts, 'additional-sealed')

    def git(directory, *args, input_bytes=None):
        commands.append((args, input_bytes))

    def legacy_hash_product(repository, commit):
        archives.append(bench.HOLDOUTS)

    def explicit_hash_product(repository, commit, excluded_paths=holdouts):
        assert bench.HOLDOUTS is holdouts
        archives.append(excluded_paths)

    def run_arm(repository, output, commit, overrides, *, workers, offline):
        bench.hash_product(repository, commit)
        if explicit_archive:
            bench.hash_product(repository, commit, extra_exclusions)
        bench.git(repository, 'sparse-checkout', 'set', '--no-cone', '--stdin', input_bytes=b'/*\n')
        bench.git(repository, '-c', 'user.name=fixture', 'merge', '--no-ff', '--no-commit', audit)
        assert bench.HOLDOUTS is holdouts
        return {}

    hash_product = explicit_hash_product if explicit_archive else legacy_hash_product
    bench = SimpleNamespace(instrument_runner=None, collect_environment=None, run_logged=None, HOLDOUTS=holdouts,
                            AUDIT=audit, git=git, hash_product=hash_product,
                            run_arm=run_arm, OVERRIDES={}, BASE_FLAGS={})
    coordinator = SimpleNamespace(combine=lambda *_: {}, write_json=lambda *_: None, tool_hashes=lambda: {}, digest=lambda _: '')
    live._run_one(tmp_path, tmp_path, {'id': 'baseline', 'commit': 'a' * 40}, coordinator, bench, 1, False, {})
    expected_archives = [(*holdouts, *live.PROTECTED)]
    if explicit_archive:
        expected_archives.append((*extra_exclusions, *live.PROTECTED))
    assert archives == expected_archives
    assert commands[0][1].decode().splitlines() == ['/*', *(f'!/{path}/' for path in live.PROTECTED)]
    assert commands[1][0][-6:] == ('merge', '--no-ff', '--no-commit', '-s', 'ours', audit)
    assert bench.git is git
    assert bench.hash_product is hash_product


def test_no_model_baseline_rejects_live_switch(tmp_path):
    root = Path(__file__).resolve().parents[2]
    baseline = live.default_arms(root)[0]
    baseline['switches']['MOHASSAN_MIND'] = '1'
    with live.development_modules(root) as (coordinator, bench), pytest.raises(ValueError, match='fixed off'):
        live._run_one(root, tmp_path, baseline, coordinator, bench, 1, False, {})


def test_model_artifact_pins_match_across_successful_workers(tmp_path):
    checkpoint = {"registryVersion": "fixture", "sha256": {"checkpoint": sha256(b'fixture model').hexdigest()}}
    changed = {"registryVersion": "fixture", "sha256": {"checkpoint": sha256(b'changed model').hexdigest()}}
    successful = {"scorecard": {"succeeded": 1, "pinnedArtifacts": checkpoint}}
    versions = {"v1": {"scores": [successful]}, "v2": {"scores": [successful]}}
    assert live._model_pins(versions, 'fixture-version', tmp_path) == checkpoint
    versions["v2"]["scores"] = [{"scorecard": {"succeeded": 1, "pinnedArtifacts": changed}}]
    with pytest.raises(ValueError, match='inconsistent artifact pins'):
        live._model_pins(versions, 'fixture-version', tmp_path)
    with pytest.raises(ValueError, match='No successful product council call'):
        live._model_pins({"v1": {"scores": [{"scorecard": {"succeeded": 0}}]}}, 'fixture-version', tmp_path)


def test_model_python_keeps_virtualenv_symlink(tmp_path, monkeypatch):
    root = Path(__file__).resolve().parents[2]
    executable = tmp_path / 'python-real'
    executable.touch()
    venv_python = tmp_path / 'env' / 'bin' / 'python'
    venv_python.parent.mkdir(parents=True)
    venv_python.symlink_to(executable)
    calls = []
    monkeypatch.setattr(live, '_run_one', lambda *args: (calls.append(args[-1]), {}, None))
    monkeypatch.setattr(live, 'normalize_development', lambda *_: {})
    arm = {'id': 'model', 'commit': 'a' * 40, 'model_version': 'fixture-version'}
    live.run_development(root, tmp_path / 'out', [arm], python=venv_python)
    assert calls == [{'EXECUTOR_PYTHON': str(venv_python)}]
