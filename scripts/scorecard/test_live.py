from pathlib import Path
from types import SimpleNamespace

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


def test_game_plan_profiles_and_private_command_redaction():
    baseline, production = live.default_arms(Path(__file__).resolve().parents[2])
    assert baseline['switches']['MOHASSAN_MODEL_RELATIONS'] == 'off'
    assert baseline['switches']['MOHASSAN_SCRATCH_CLASSIFIERS'] == '0'
    assert baseline['switches']['MOHASSAN_JUDGE_SHADOW'] == '0'
    assert production['switches']['MOHASSAN_MODEL_RELATIONS'] == 'shadow'
    assert production['switches']['MOHASSAN_SCRATCH_CLASSIFIERS'] == '1'
    assert live._public_args(['--private-suite', '/owner/questions', '--private-evaluator=/owner/scorer', '--offline']) == [
        '--private-suite', '<owner-local>', '--private-evaluator', '<owner-local>', '--offline',
    ]


def test_worktree_hides_protected_paths_and_uses_content_free_audit_merge(tmp_path):
    commands = []
    archives = []
    audit = 'b' * 40

    def git(directory, *args, input_bytes=None):
        commands.append((args, input_bytes))

    def run_arm(repository, output, commit, overrides, *, workers, offline):
        bench.hash_product(repository, commit)
        bench.git(repository, 'sparse-checkout', 'set', '--no-cone', '--stdin', input_bytes=b'/*\n')
        bench.git(repository, '-c', 'user.name=fixture', 'merge', '--no-ff', '--no-commit', audit)
        assert bench.HOLDOUTS == ('native-sealed',)
        return {}

    bench = SimpleNamespace(instrument_runner=None, collect_environment=None, run_logged=None, HOLDOUTS=('native-sealed',),
                            AUDIT=audit, git=git, hash_product=lambda *_: archives.append(bench.HOLDOUTS),
                            run_arm=run_arm, OVERRIDES={}, BASE_FLAGS={})
    coordinator = SimpleNamespace(combine=lambda *_: {}, write_json=lambda *_: None, tool_hashes=lambda: {}, digest=lambda _: '')
    live._run_one(tmp_path, tmp_path, {'id': 'baseline', 'commit': 'a' * 40}, coordinator, bench, 1, False, {})
    assert archives == [('native-sealed', *live.PROTECTED)]
    assert commands[0][1].decode().splitlines() == ['/*', *(f'!/{path}/' for path in live.PROTECTED)]
    assert commands[1][0][-6:] == ('merge', '--no-ff', '--no-commit', '-s', 'ours', audit)
    assert bench.git is git


def test_no_model_baseline_rejects_live_switch(tmp_path):
    root = Path(__file__).resolve().parents[2]
    baseline = live.default_arms(root)[0]
    baseline['switches']['MOHASSAN_MIND'] = '1'
    with live.development_modules(root) as (coordinator, bench), pytest.raises(ValueError, match='fixed off'):
        live._run_one(root, tmp_path, baseline, coordinator, bench, 1, False, {})
