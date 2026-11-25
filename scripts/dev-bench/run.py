#!/usr/bin/env python3
"""Run and coordinate the pinned development benchmark."""

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess

from runner import run_arm


STAGES = ('understanding', 'routing', 'planning', 'tool', 'answer', 'verification')
LANES = 8


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    with open(path, 'x', encoding='utf-8', opener=private_file) as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write('\n')


def private_file(path, flags):
    return os.open(path, flags, 0o600)


def summarize_group(scores):
    total = len(scores)
    passed = sum(score['passed'] for score in scores)
    rate = passed / total
    z = 1.959963984540054
    z_squared = z * z
    denominator = 1 + z_squared / total
    center = (rate + z_squared / (2 * total)) / denominator
    half_width = z * math.sqrt(rate * (1 - rate) / total + z_squared / (4 * total * total)) / denominator
    latency = sorted(score['latencyMs'] for score in scores if score['latencyMs'] is not None)
    primary = Counter(score['stage'] for score in scores)
    any_stage = Counter(stage for score in scores for stage in {failure['stage'] for failure in score['failures']})
    return {
        'passed': passed,
        'total': total,
        'rate': rate,
        'wilson95': [0 if passed == 0 else center - half_width, 1 if passed == total else center + half_width],
        'p50Ms': latency[math.ceil(0.5 * len(latency)) - 1] if latency else None,
        'p95Ms': latency[math.ceil(0.95 * len(latency)) - 1] if latency else None,
        'measuredLatency': len(latency),
        'completedWithFailure': sum(score['completedWithFailure'] for score in scores),
        'primaryFailureStages': {stage: primary[stage] for stage in STAGES},
        'anyFailureStages': {stage: any_stage[stage] for stage in STAGES},
    }


def summarize(scores):
    groups = {name: defaultdict(list) for name in ('byArea', 'byLanguage', 'byVariety', 'byAreaAndLanguage')}
    for score in scores:
        area, language = score['area'], score['language']
        groups['byArea'][area].append(score)
        groups['byLanguage'][language].append(score)
        groups['byVariety'][score['variety']].append(score)
        groups['byAreaAndLanguage'][f'{area}/{language}'].append(score)
    return {
        'overall': summarize_group(scores),
        **{name: {label: summarize_group(group) for label, group in sorted(members.items())}
           for name, members in groups.items()},
    }


def validate_summary(recomputed, reported, name):
    require(recomputed.keys() == reported.keys(), f'{name}: summary groups differ')
    for key, value in recomputed.items():
        other = reported[key]
        if isinstance(value, dict):
            validate_summary(value, other, f'{name}/{key}')
        elif key == 'wilson95':
            require(len(other) == 2 and all(math.isclose(a, b, abs_tol=1e-14) for a, b in zip(value, other)),
                    f'{name}/{key}: summary differs')
        else:
            require(value == other, f'{name}/{key}: summary differs')


def read_worker(output, filename, source):
    raw = (output / filename).read_bytes()
    require(digest(raw) == source['receipts'][filename], f'{filename}: receipt SHA-256 differs')
    receipt = json.loads(raw)
    require(receipt['source']['gitCommit'] == source['commit'], f'{filename}: measured commit differs')
    require(receipt['source']['lockfileSha256'] == source['inputs']['product/package-lock.json'],
            f'{filename}: measured lockfile SHA-256 differs')
    return receipt


def check_cases(scores, order, name):
    require([score['id'] for score in scores] == order, f'{name}: case coverage or order differs')
    for score in scores:
        require(type(score['passed']) is bool and score['passed'] == (not score['failures']),
                f'{name}: invalid verdict for {score["id"]}')
        require(isinstance(score['replies'], list) and all(isinstance(reply, str) for reply in score['replies']),
                f'{name}: invalid reply capture for {score["id"]}')


def check_order(order, count, name):
    require(len(order) == count and len(set(order)) == count, f'{name}: invalid release case order')


def combine(output, source):
    v1 = read_worker(output, 'v1-development.json', source)
    require(v1['schemaVersion'] == 1 and v1['sealedIncluded'] is False
            and [split['name'] for split in v1['splits']] == ['development'], 'v1: expected only development')
    v1_scores = v1['splits'][0]['scores']
    check_order(v1['caseOrder'], 240, 'v1')
    check_cases(v1_scores, v1['caseOrder'], 'v1')
    v1_summary = summarize(v1_scores)
    validate_summary(v1_summary, v1['summary'], 'v1')
    validate_summary(v1_summary, v1['splits'][0]['summary'], 'v1 development')

    v2_order = None
    v2_scores = {}
    v2_manifest = None
    for index in range(LANES):
        filename = f'v2-lane-{index}.json'
        lane = read_worker(output, filename, source)
        require(lane['schemaVersion'] == 2 and lane['split'] == 'development'
                and lane['lane'] == {'index': index, 'count': LANES}, f'{filename}: invalid lane metadata')
        if index == 0:
            v2_order, v2_manifest = lane['caseOrder'], lane['manifest']
            check_order(v2_order, 2400, 'v2')
        require(lane['caseOrder'] == v2_order and lane['manifest'] == v2_manifest,
                f'{filename}: development bundle differs')
        check_cases(lane['scores'], v2_order[index::LANES], filename)
        validate_summary(summarize(lane['scores']), lane['summary'], filename)
        v2_scores.update((score['id'], score) for score in lane['scores'])

    ordered_v2 = [v2_scores[case_id] for case_id in v2_order]
    return {
        'v1': {'scores': v1_scores, 'summary': v1_summary},
        'v2': {'scores': ordered_v2, 'summary': summarize(ordered_v2)},
    }


def tool_hashes():
    directory = Path(__file__).resolve().parent
    files = {path.name: digest(path.read_bytes()) for path in sorted(directory.glob('*.py'))}
    listing = json.dumps(files, separators=(',', ':'), sort_keys=True).encode()
    return {'sha256': digest(listing), 'files': files}


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True, help='new directory outside the product checkout')
    parser.add_argument('--arm', action='append', required=True, metavar='NAME=COMMIT', help='full pinned SHA, repeat in run order')
    parser.add_argument('--set', action='append', default=[], metavar='NAME:KEY=VALUE', help='override one allowed flag in an arm')
    parser.add_argument('--workers', type=int, choices=range(1, LANES + 1), default=LANES,
                        help='concurrent V2 workers; all eight lanes always run')
    parser.add_argument('--offline', action='store_true', help='install from the local npm cache without network access')
    args = parser.parse_args()
    arms = {}
    for spec in args.arm:
        name, _, commit = spec.partition('=')
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]*', name) or name in arms or not re.fullmatch(r'[0-9a-f]{40}', commit):
            parser.error(f'invalid or duplicate arm {name!r}; expected a name and full 40-character commit SHA')
        arms[name] = (commit, {})
    for spec in args.set:
        arm, _, setting = spec.partition(':')
        key, equal, value = setting.partition('=')
        if arm not in arms or not equal or not key or key in arms[arm][1]:
            parser.error(f'invalid or duplicate override for {arm!r}: {key!r}')
        arms[arm][1][key] = value
    return args, arms


def main():
    args, arms = arguments()
    output = args.output.resolve()
    repo = Path(__file__).resolve().parents[2]
    require(not output.is_relative_to(repo), 'write receipts outside the product checkout')
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    tool = tool_hashes()
    run_summary = {'schemaVersion': 1, 'tool': tool, 'arms': {}}
    for name, (commit, settings) in arms.items():
        arm_output = output / name
        arm_output.mkdir(mode=0o700)
        print(f'{name}: measuring {commit}', flush=True)
        source = run_arm(repo, arm_output, commit, settings, workers=args.workers, offline=args.offline)
        require(source['commit'] == commit, f'{name}: launcher measured a different commit')
        versions = combine(arm_output, source)
        receipt = {'schemaVersion': 1, 'name': name, 'commit': commit, 'tool': tool, 'source': source, 'versions': versions}
        receipt_path = arm_output / 'receipt.json'
        write_json(receipt_path, receipt)
        run_summary['arms'][name] = {
            'commit': commit,
            'source': source,
            'receiptSha256': digest(receipt_path.read_bytes()),
            'versions': {version: result['summary'] for version, result in versions.items()},
        }
        for version, result in versions.items():
            overall = result['summary']['overall']
            print(f'{name} {version}: {overall["passed"]}/{overall["total"]}', flush=True)
    write_json(output / 'summary.json', run_summary)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.CalledProcessError) as error:
        raise SystemExit(f'dev-bench: {error}') from None
