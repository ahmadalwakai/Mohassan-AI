"""Report paired differences between coordinated development benchmark receipts."""

import argparse
from collections import defaultdict
import json
from math import comb, sqrt
import os
from pathlib import Path
from statistics import NormalDist

from compare import Case, Receipt, read_receipt


CONFIDENCE = 0.95
WILSON_Z = NormalDist().inv_cdf((1 + CONFIDENCE) / 2)
MATCHED_SOURCE_FIELDS = ('pins', 'inputs', 'toolchain')


def wilson95(passed: int, total: int) -> list[float]:
    """Invert the two-sided binomial score test at 95% confidence."""
    rate = passed / total
    z_squared = WILSON_Z ** 2
    denominator = 1 + z_squared / total
    center = (rate + z_squared / (2 * total)) / denominator
    radius = WILSON_Z * sqrt((rate * (1 - rate) + z_squared / (4 * total)) / total) / denominator
    return [0.0 if passed == 0 else center - radius, 1.0 if passed == total else center + radius]


def mcnemar_exact(improved: int, regressed: int) -> float:
    """Two-sided binomial test conditional on the number of discordant pairs."""
    discordant = improved + regressed
    tail = sum(comb(discordant, count) for count in range(min(improved, regressed) + 1))
    return min(1.0, 2 * tail / (1 << discordant))


def pass_rate(passed: int, total: int) -> dict:
    return {'passed': passed, 'rate': passed / total, 'wilson95': wilson95(passed, total)}


def summarize_pairs(pairs: list[tuple[Case, Case]]) -> dict:
    total = len(pairs)
    profile_passed = ablation_passed = improved = regressed = reply_changes = check_changes = 0
    for before, after in pairs:
        profile_passed += before.passed
        ablation_passed += after.passed
        improved += not before.passed and after.passed
        regressed += before.passed and not after.passed
        reply_changes += before.replies != after.replies
        check_changes += before.checks != after.checks

    no_verdict_changes = improved == regressed == 0
    return {
        'total': total,
        'profile': pass_rate(profile_passed, total),
        'ablation': pass_rate(ablation_passed, total),
        'deltaPercentagePoints': 100 * (improved - regressed) / total,
        'improved': improved,
        'regressed': regressed,
        'mcnemarExactP': mcnemar_exact(improved, regressed),
        'replyChanges': reply_changes,
        'checkChanges': check_changes,
        'noVerdictChanges': no_verdict_changes,
        'noObservedChange': no_verdict_changes and reply_changes == check_changes == 0,
    }


def compare_version(version: str, originals: list[Case], ablated: list[Case]) -> dict:
    by_id = {case.id: case for case in ablated}
    if by_id.keys() != {case.id for case in originals}:
        raise ValueError(f'{version}: case IDs differ from the profile')

    paired = []
    by_area = defaultdict(list)
    by_language = defaultdict(list)
    by_area_and_language = defaultdict(lambda: defaultdict(list))
    for before in originals:
        after = by_id[before.id]
        if (before.area, before.language) != (after.area, after.language):
            raise ValueError(f'{version}: subgroup metadata differs for {before.id}')
        pair = (before, after)
        paired.append(pair)
        by_area[before.area].append(pair)
        by_language[before.language].append(pair)
        by_area_and_language[before.area][before.language].append(pair)

    return {
        'overall': summarize_pairs(paired),
        'byArea': {area: summarize_pairs(pairs) for area, pairs in sorted(by_area.items())},
        'byLanguage': {language: summarize_pairs(pairs) for language, pairs in sorted(by_language.items())},
        'byAreaAndLanguage': {
            area: {language: summarize_pairs(pairs) for language, pairs in sorted(languages.items())}
            for area, languages in sorted(by_area_and_language.items())
        },
    }


def validation_settings(receipt: Receipt) -> dict[str, str]:
    fields = (*MATCHED_SOURCE_FIELDS, 'settings')
    if receipt.source.get('split') != 'development':
        raise ValueError('Ablation requires coordinated development receipts')
    if receipt.source.get('commit') != receipt.commit or not receipt.tool.get('sha256'):
        raise ValueError('Ablation receipt is missing matching commit or tool provenance')
    if not all(isinstance(receipt.source.get(field), dict) and receipt.source[field] for field in fields):
        raise ValueError('Ablation receipt is missing pins, inputs, toolchain or settings')
    settings = receipt.source['settings']
    if not all(isinstance(value, str) for value in settings.values()):
        raise ValueError('Ablation receipt settings must use strings')
    return settings


def receipt_reference(receipt: Receipt) -> dict[str, str]:
    return {'commit': receipt.commit, 'receiptSha256': receipt.digest}


def build_report(profile_path: Path, arm_paths: dict[str, Path]) -> dict:
    """Read combined development receipts and validate each one-switch comparison."""
    if not arm_paths:
        raise ValueError('Ablation requires at least one switch receipt')
    profile = read_receipt(profile_path)
    profile_settings = validation_settings(profile)
    switches = {}
    for switch, path in arm_paths.items():
        ablated = read_receipt(path)
        ablated_settings = validation_settings(ablated)
        if ablated.commit != profile.commit or ablated.tool != profile.tool or any(
            ablated.source[field] != profile.source[field] for field in MATCHED_SOURCE_FIELDS
        ):
            raise ValueError(f'{switch}: commit, tool, pins, inputs or toolchain differ from the profile')
        if (
            profile_settings.keys() != ablated_settings.keys()
            or {key for key in profile_settings if profile_settings[key] != ablated_settings[key]} != {switch}
        ):
            raise ValueError(f'{switch}: expected exactly that setting to differ from the profile')

        versions = {
            version: compare_version(version, originals, ablated.versions[version])
            for version, originals in profile.versions.items()
        }
        switches[switch] = {
            **receipt_reference(ablated),
            'noVerdictChanges': all(result['overall']['noVerdictChanges'] for result in versions.values()),
            'noObservedChange': all(result['overall']['noObservedChange'] for result in versions.values()),
            'versions': versions,
        }
    return {
        'schemaVersion': 1,
        'split': 'development',
        'profile': receipt_reference(profile),
        'switches': switches,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile-receipt', required=True, type=Path)
    parser.add_argument('--arm', action='append', required=True, metavar='SWITCH=RECEIPT')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    paths = {}
    for arm in args.arm:
        switch, _, path = arm.partition('=')
        if not switch or not path or switch in paths:
            parser.error('expected one receipt per switch as SWITCH=RECEIPT')
        paths[switch] = Path(path)

    try:
        report = build_report(args.profile_receipt, paths)
        with os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
            json.dump(report, output, indent=2, allow_nan=False)
            output.write('\n')
    except (AttributeError, KeyError, OSError, TypeError, ValueError) as error:
        parser.exit(2, f'{parser.prog}: {error}\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
