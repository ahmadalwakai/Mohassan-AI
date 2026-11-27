import hashlib
from itertools import product
import json
from math import sqrt
from pathlib import Path
from statistics import NormalDist
import subprocess
import sys

import pytest

from ablation import build_report, mcnemar_exact, summarize_pairs, wilson95
from compare import Case, VERSIONS


REASONING = 'MOHASSAN_REASONING'
ARBITER = 'MOHASSAN_ARBITER_ROUTING'


def synthetic_receipt():
    def sha256(label):
        return hashlib.sha256(label.encode()).hexdigest()

    commit = sha256('synthetic product')[:40]
    domains = (('planning', 'ar'), ('planning', 'en'), ('tool', 'ar'), ('tool', 'en'))
    versions = {}
    for version, total in VERSIONS.items():
        scores = []
        for index in range(total):
            area, language = domains[index % len(domains)]
            score = {'id': f'case-{index}', 'area': area, 'language': language, 'replies': ['fixture reply']}
            set_verdict(score, index % len(domains) != 0)
            scores.append(score)
        versions[version] = {'scores': scores}
    return {
        'commit': commit,
        'source': {
            'split': 'development',
            'commit': commit,
            'pins': {version: sha256(version)[:40] for version in VERSIONS},
            'inputs': {'product/package-lock.json': sha256('synthetic lockfile')},
            'toolchain': {'node': 'synthetic node'},
            'settings': {REASONING: '0', ARBITER: '0'},
        },
        'tool': {'sha256': sha256('synthetic benchmark code')},
        'versions': versions,
    }


def set_verdict(score, passed):
    failures = [] if passed else [{'turn': 1, 'stage': 'planning', 'check': 'fixture'}]
    score.update(passed=passed, failures=failures, turns=[{'failures': failures, 'latencyMs': 1}])


def write_receipt(tmp_path, name, receipt):
    path = tmp_path / f'{name}.json'
    path.write_text(json.dumps(receipt), encoding='utf-8')
    return path


def test_deltas_agree_with_exhaustive_paired_verdicts():
    for verdicts in product((False, True), repeat=6):
        before, after = verdicts[:3], verdicts[3:]
        pairs = [(Case(str(index), 'planning', 'ar', old, ()), Case(str(index), 'planning', 'ar', new, ()))
                 for index, (old, new) in enumerate(zip(before, after))]
        row = summarize_pairs(pairs)
        assert row['deltaPercentagePoints'] == pytest.approx(100 * (sum(after) - sum(before)) / len(before))
        assert row['noVerdictChanges'] is (before == after)


@pytest.mark.parametrize('passed', range(8))
def test_wilson_endpoints_agree_with_brute_force_score_test(passed):
    total = 7
    resolution = 10_000
    step = 1 / resolution
    normal = NormalDist()
    accepted = []
    for index in range(resolution + 1):
        null_rate = index / resolution
        standard_error = sqrt(null_rate * (1 - null_rate) / total)
        difference = abs(passed / total - null_rate)
        p_value = 2 * normal.cdf(-difference / standard_error) if standard_error else float(difference == 0)
        if p_value >= 0.05:
            accepted.append(null_rate)
    lower, upper = wilson95(passed, total)
    assert lower == pytest.approx(min(accepted), abs=step)
    assert upper == pytest.approx(max(accepted), abs=step)


@pytest.mark.parametrize(('improved', 'regressed', 'tail_outcomes'), [
    (0, 1, 1),  # One of two assignments is all regressions.
    (0, 5, 1),  # Only the all-regressions assignment is in the lower tail.
    (1, 5, 1 + 6),  # Zero improvements, or one in any of six positions.
    (2, 6, 1 + 8 + 8 * 7 // 2),  # Add the unordered pairs of eight positions.
])
def test_mcnemar_exact_hand_checked_small_tails(improved, regressed, tail_outcomes):
    expected = 2 * tail_outcomes / 2 ** (improved + regressed)
    assert mcnemar_exact(improved, regressed) == expected
    assert mcnemar_exact(regressed, improved) == expected


def test_mcnemar_exact_matches_enumeration_including_ties():
    for discordant in range(9):
        outcome_counts = [sum(assignment) for assignment in product((0, 1), repeat=discordant)]
        for improved in range(discordant + 1):
            extreme = abs(2 * improved - discordant)
            expected = sum(abs(2 * count - discordant) >= extreme for count in outcome_counts) / len(outcome_counts)
            assert mcnemar_exact(improved, discordant - improved) == expected


def test_report_pairs_by_case_id_and_groups_and_preserves_receipt_digests(tmp_path):
    profile = synthetic_receipt()
    ablated = synthetic_receipt()
    ablated['source']['settings'][REASONING] = '1'
    for version in VERSIONS:
        scores = ablated['versions'][version]['scores']
        for index in (0, 1, 4):
            set_verdict(scores[index], not scores[index]['passed'])
        scores.reverse()

    profile_path = write_receipt(tmp_path, 'profile', profile)
    arm_path = write_receipt(tmp_path, 'reasoning', ablated)
    report = build_report(profile_path, {REASONING: arm_path})
    assert report['split'] == 'development'
    assert report['profile']['receiptSha256'] == hashlib.sha256(profile_path.read_bytes()).hexdigest()
    switch = report['switches'][REASONING]
    assert switch['receiptSha256'] == hashlib.sha256(arm_path.read_bytes()).hexdigest()
    assert not switch['noVerdictChanges']
    assert not switch['noObservedChange']

    for version, result in switch['versions'].items():
        before, after = (receipt['versions'][version]['scores'] for receipt in (profile, ablated))
        overall = result['overall']
        assert (overall['improved'], overall['regressed']) == (2, 1)
        groups = [(overall, {})]
        groups.extend((row, {'area': area}) for area, row in result['byArea'].items())
        groups.extend((row, {'language': language}) for language, row in result['byLanguage'].items())
        groups.extend((row, {'area': area, 'language': language})
                      for area, languages in result['byAreaAndLanguage'].items() for language, row in languages.items())
        assert len(groups) == 1 + 2 + 2 + 4
        for row, criteria in groups:
            selected_before, selected_after = (
                [score['passed'] for score in scores if all(score[key] == value for key, value in criteria.items())]
                for scores in (before, after)
            )
            total = len(selected_before)
            delta = 100 * (sum(selected_after) - sum(selected_before)) / total
            assert row['total'] == total
            assert row['profile']['passed'] == sum(selected_before)
            assert row['ablation']['passed'] == sum(selected_after)
            assert row['deltaPercentagePoints'] == pytest.approx(delta)


@pytest.mark.parametrize('change', ['timing', 'reply', 'check', 'offsetting verdicts'])
def test_no_observed_change_uses_verdicts_replies_and_checks(tmp_path, change):
    profile = synthetic_receipt()
    ablated = synthetic_receipt()
    ablated['source']['settings'][ARBITER] = '1'
    scores = ablated['versions']['v1']['scores']
    if change == 'timing':
        scores[0]['turns'][0]['latencyMs'] += 1
        scores[0]['setupMs'] = 2
    elif change == 'reply':
        scores[0]['replies'].append('another fixture reply')
    elif change == 'check':
        scores[0]['turns'][0]['route'] = 'synthetic different route'
    else:
        set_verdict(scores[0], True)
        set_verdict(scores[1], False)
    profile_path = write_receipt(tmp_path, 'profile', profile)
    arm_path = write_receipt(tmp_path, 'arbiter', ablated)
    result = build_report(profile_path, {ARBITER: arm_path})['switches'][ARBITER]
    assert result['versions']['v1']['overall']['deltaPercentagePoints'] == 0
    assert result['noVerdictChanges'] is (change != 'offsetting verdicts')
    assert result['noObservedChange'] is (change == 'timing')


@pytest.mark.parametrize(('change', 'message'), [
    ('split', 'requires coordinated development receipts'),
    ('inputs', 'inputs or toolchain differ'),
    ('commit', 'commit, tool, pins, inputs or toolchain differ'),
    ('settings', 'expected exactly that setting'),
    ('case ID', 'case IDs differ'),
    ('subgroup', 'subgroup metadata differs'),
])
def test_rejects_receipts_that_do_not_match_frozen_profile(tmp_path, change, message):
    profile = synthetic_receipt()
    ablated = synthetic_receipt()
    ablated['source']['settings'][REASONING] = '1'
    if change == 'split':
        ablated['source']['split'] = 'other'
    elif change == 'inputs':
        ablated['source']['inputs']['product/package-lock.json'] = 'different input'
    elif change == 'commit':
        ablated['commit'] = ablated['source']['commit'] = hashlib.sha256(b'other commit').hexdigest()[:40]
    elif change == 'settings':
        ablated['source']['settings'][ARBITER] = '1'
    else:
        score = ablated['versions']['v2']['scores'][0]
        score.update({'id' if change == 'case ID' else 'language': 'different value'})
    profile_path = write_receipt(tmp_path, 'profile', profile)
    arm_path = write_receipt(tmp_path, 'reasoning', ablated)
    with pytest.raises(ValueError, match=message):
        build_report(profile_path, {REASONING: arm_path})


def test_ablation_cli_rebuilds_report_for_multiple_switches(tmp_path):
    profile = synthetic_receipt()
    profile_path = write_receipt(tmp_path, 'profile', profile)
    paths = {}
    for name in (REASONING, ARBITER):
        ablated = synthetic_receipt()
        ablated['source']['settings'][name] = '1'
        paths[name] = write_receipt(tmp_path, name, ablated)
    output = tmp_path / 'report.json'
    command = [sys.executable, str(Path(__file__).with_name('ablation.py')),
               '--profile-receipt', str(profile_path), '--output', str(output)]
    for switch, path in paths.items():
        command.extend(['--arm', f'{switch}={path}'])
    subprocess.run(command, check=True, capture_output=True)
    assert json.loads(output.read_bytes()) == build_report(profile_path, paths)


def test_coordinator_writes_ablation_and_receipt_digests_in_one_run(tmp_path, monkeypatch):
    import run as coordinator

    commit = synthetic_receipt()['commit']

    def fake_run_arm(repo, output, measured_commit, settings, **options):
        source = synthetic_receipt()['source']
        del source['split']
        return source | {'commit': measured_commit, 'settings': settings}

    def fake_combine(output, source):
        versions = synthetic_receipt()['versions']
        for result in versions.values():
            scores = result['scores']
            if source['settings'][REASONING] == '1':
                set_verdict(scores[0], True)
            result['summary'] = {'overall': {'passed': sum(score['passed'] for score in scores), 'total': len(scores)}}
        return versions

    profile = Path(__file__).with_name('profiles') / 'production-2026-11-26.json'
    output = tmp_path / 'owner-run'
    monkeypatch.setattr(coordinator, 'run_arm', fake_run_arm)
    monkeypatch.setattr(coordinator, 'combine', fake_combine)
    monkeypatch.setattr(sys, 'argv', ['run.py', '--arm', f'profile={commit}', '--profile', str(profile),
                                     '--ablate', f'{REASONING},{ARBITER}', '--output', str(output)])
    coordinator.main()

    report = json.loads((output / 'ablation.json').read_bytes())
    summary = json.loads((output / 'summary.json').read_bytes())
    assert report['profile']['receiptSha256'] == summary['arms']['profile']['receiptSha256']
    for switch, result in report['switches'].items():
        assert result['receiptSha256'] == summary['arms'][switch]['receiptSha256']
    assert report['switches'][REASONING]['versions']['v2']['overall']['improved'] == 1
    assert report['switches'][ARBITER]['noObservedChange'] is True
