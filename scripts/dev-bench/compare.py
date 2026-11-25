"""Verify release parity and feature-on subgroup scores for a development run."""

import argparse
from collections import Counter
from dataclasses import dataclass
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import re


VERSIONS = {"v1": 240, "v2": 2400}


@dataclass(frozen=True)
class Case:
    id: str
    area: str
    language: str
    passed: bool
    replies: tuple[str, ...]
    checks: tuple[object, ...] = ()
    monitor_audit: tuple[dict, ...] | None = None


@dataclass(frozen=True)
class Receipt:
    digest: str
    commit: str
    source: dict
    tool: dict
    versions: dict[str, list[Case]]


def read_receipt(path: Path) -> Receipt:
    payload = path.read_bytes()
    receipt = json.loads(payload)
    commit = receipt.get("commit")
    versions = receipt.get("versions")
    if not isinstance(commit, str) or re.fullmatch(r"[0-9a-f]{40}", commit) is None:
        raise ValueError(f"{path} has no full measured commit")
    if not isinstance(versions, dict) or versions.keys() != VERSIONS.keys():
        raise ValueError(f"{path} does not contain exactly the two development versions")

    cases_by_version = {}
    for version, expected_count in VERSIONS.items():
        scores = versions[version]["scores"]
        if not isinstance(scores, list) or len(scores) != expected_count:
            raise ValueError(f"{path} {version} needs {expected_count} scores")
        cases = []
        seen = set()
        for score in scores:
            case_id, area, language = (score[key] for key in ("id", "area", "language"))
            passed, replies = score["passed"], score["replies"]
            if not all(isinstance(field, str) and field for field in (case_id, area, language)):
                raise ValueError(f"{path} {version} has invalid case metadata")
            if case_id in seen:
                raise ValueError(f"{path} {version} has duplicate case {case_id}")
            if type(passed) is not bool or not isinstance(replies, list) or not all(
                isinstance(reply, str) for reply in replies
            ):
                raise ValueError(f"{path} {version} case {case_id} has an invalid verdict or replies")
            audit = score.get("monitorAudit")
            checks = (score.get("failures"), [{key: value for key, value in turn.items() if key != "latencyMs"}
                                              for turn in score.get("turns", [])])
            cases.append(Case(case_id, area, language, passed, tuple(replies), checks,
                              tuple(audit) if audit is not None else None))
            seen.add(case_id)
        cases_by_version[version] = cases
    return Receipt(
        sha256(payload).hexdigest(), commit, receipt.get("source", {}), receipt.get("tool", {}), cases_by_version
    )


def groups(cases: list[Case]) -> dict[tuple[str, ...], dict[str, int]]:
    total = Counter()
    passed = Counter()
    for case in cases:
        case_groups = (
            ("overall",),
            ("area", case.area),
            ("language", case.language),
            ("area/language", case.area, case.language),
        )
        total.update(case_groups)
        if case.passed:
            passed.update(case_groups)
    return {group: {"passed": passed[group], "total": total[group]} for group in sorted(total)}


def coverage(cases: list[Case]) -> list[tuple[str, str, str]]:
    return [(case.id, case.area, case.language) for case in cases]


def summarize_monitor_audit(versions, requested_cases):
    categories = ("detection", "management", "proactive")
    per_turn = {category: [] for category in categories}
    matches = {category: [] for category in (*categories, "offers", "falseOffers")}
    for version, cases in versions.items():
        for case in cases:
            if case.monitor_audit is None:
                raise ValueError("Monitor audit was not enabled for every arm")
            hits = {category: [] for category in matches}
            for index, turn in enumerate(case.monitor_audit, start=1):
                for category in categories:
                    samples = turn[category]
                    if samples:
                        per_turn[category].append(sum(sample["ms"] for sample in samples))
                    if any(sample["matched"] for sample in samples):
                        hits[category].append(index)
                if turn["offers"]:
                    hits["offers"].append(index)
                    if (version, case.id) not in requested_cases:
                        hits["falseOffers"].append(index)
            for category, turns in hits.items():
                if turns:
                    matches[category].append({"version": version, "caseId": case.id, "turns": turns})
    return {
        "counts": {category: len(cases) for category, cases in matches.items()},
        "matches": matches,
        "turns": sum(len(case.monitor_audit) for cases in versions.values() for case in cases),
        "timing": {
            category: {"measuredTurns": len(samples), **{
                percentile: sorted(samples)[math.ceil(rank * len(samples)) - 1] if samples else None
                for percentile, rank in (("p50Ms", 0.50), ("p95Ms", 0.95))
            }} for category, samples in per_turn.items()
        },
    }


def outside_literal(reply: str, value: str) -> tuple[str, str]:
    prefix, found, suffix = reply.partition(value)
    if not found or reply.find(value, len(prefix) + 1) != -1:
        raise ValueError("Each masked value must appear exactly once in its reply")
    if not prefix and not suffix:
        raise ValueError("A mask must leave surrounding reply text")
    return prefix, suffix


def prove_masks(
    baseline: Receipt, repeated: Receipt, flags_off: Receipt, rules: list
) -> dict[tuple[str, str, int], dict]:
    if not isinstance(rules, list):
        raise ValueError("Reply masks must be a JSON array")
    by_arm = {
        name: {
            (version, case.id): case
            for version, cases in receipt.versions.items()
            for case in cases
        }
        for name, receipt in (
            ("baseline", baseline), ("baselineRepeat", repeated), ("flagsOff", flags_off)
        )
    }
    proof = {}
    for rule in rules:
        version, case_id, turn = (rule[key] for key in ("version", "caseId", "turn"))
        arm_cases = (version, case_id)
        if arm_cases not in by_arm["baseline"] or type(turn) is not int or turn < 1:
            raise ValueError("Reply masks require an existing version, case ID, and positive turn")
        key = (version, case_id, turn)
        if key in proof:
            raise ValueError(f"Duplicate mask for {version} {case_id} turn {turn}")
        values = rule["values"]
        if not isinstance(values, dict) or values.keys() != by_arm.keys() or not all(
            isinstance(value, str) and value and "\n" not in value and "\r" not in value
            for value in values.values()
        ):
            raise ValueError("Each reply mask needs one single-line literal for each arm")
        if values["baseline"] == values["baselineRepeat"]:
            raise ValueError(f"Repeat does not prove a changing value for {version} {case_id} turn {turn}")
        cases = {name: arm[arm_cases] for name, arm in by_arm.items()}
        if any(turn > len(case.replies) for case in cases.values()):
            raise ValueError(f"Mask refers to a missing reply for {version} {case_id} turn {turn}")
        if cases["baseline"].passed != cases["baselineRepeat"].passed:
            raise ValueError(f"Repeat changed the verdict for masked case {version} {case_id}")
        contexts = {
            name: outside_literal(case.replies[turn - 1], values[name])
            for name, case in cases.items()
        }
        if len(set(contexts.values())) != 1:
            raise ValueError(f"Reply text outside the mask differs for {version} {case_id} turn {turn}")
        proof[key] = {
            "version": version,
            "caseId": case_id,
            "turn": turn,
            "valueSha256": {name: sha256(value.encode()).hexdigest() for name, value in values.items()},
            "replySha256": {
                name: sha256(case.replies[turn - 1].encode()).hexdigest()
                for name, case in cases.items()
            },
        }
    return proof


def compare(
    baseline: Receipt,
    flags_off: Receipt,
    flags_on: Receipt,
    repeated: Receipt | None = None,
    masks: list | None = None,
    monitor_requests: set[tuple[str, str]] | None = None,
) -> dict:
    if flags_off.commit != flags_on.commit:
        raise ValueError("The two feature-flag arms must measure the same commit")
    if masks is not None and repeated is None:
        raise ValueError("Reply masks require a baseline repeat")
    comparison_inputs = {"baseline": baseline, "flagsOff": flags_off, "flagsOn": flags_on}
    if monitor_requests is not None:
        settings = [receipt.source["settings"] for receipt in comparison_inputs.values()]
        profiles = [{key: value for key, value in arm.items() if key != "MOHASSAN_MONITORS_V2"} for arm in settings]
        if (profiles[0] != profiles[1] or profiles[0] != profiles[2]
                or profiles[0].get("MOHASSAN_MONITORS_ENABLED") != "1"
                or [arm.get("MOHASSAN_MONITORS_V2", "0") for arm in settings] != ["0", "0", "1"]):
            raise ValueError("Monitor audit requires the same profile with v1 enabled and v2 on only for flagsOn")
        known_cases = {(version, case.id) for version, cases in baseline.versions.items() for case in cases}
        if not monitor_requests <= known_cases:
            raise ValueError("Monitor request labels must refer to published development case IDs")
    if repeated is not None:
        same_source = all(
            key in baseline.source and baseline.source[key] == repeated.source.get(key)
            for key in ("settings", "inputs", "toolchain")
        )
        if (
            repeated.commit != baseline.commit
            or not baseline.tool.get("sha256")
            or baseline.tool != repeated.tool
            or not same_source
        ):
            raise ValueError("Repeat must match the baseline commit, settings, inputs, tool, and toolchain")
        comparison_inputs["baselineRepeat"] = repeated

    for version in VERSIONS:
        originals = baseline.versions[version]
        for label, receipt in comparison_inputs.items():
            cases = receipt.versions[version]
            if coverage(originals) != coverage(cases):
                raise ValueError(f"{version} {label} case order or subgroup metadata differs from baseline")

    proof = prove_masks(baseline, repeated, flags_off, masks) if repeated is not None and masks is not None else {}
    versions = {}
    for version in VERSIONS:
        originals = baseline.versions[version]
        off_cases = flags_off.versions[version]
        on_cases = flags_on.versions[version]
        verdict_differences = []
        check_differences = []
        reply_differences = []
        for before, after in zip(originals, off_cases, strict=True):
            if before.passed != after.passed:
                verdict_differences.append(
                    {"caseId": before.id, "baseline": before.passed, "flagsOff": after.passed}
                )
            if monitor_requests is not None and before.checks != after.checks:
                check_differences.append(before.id)
            different_turns = [
                index
                for index, (expected, actual) in enumerate(
                    zip(before.replies, after.replies), start=1
                )
                if expected != actual and (version, before.id, index) not in proof
            ]
            if different_turns or len(before.replies) != len(after.replies):
                reply_differences.append({
                    "caseId": before.id,
                    "turns": different_turns,
                    "baselineTurnCount": len(before.replies),
                    "flagsOffTurnCount": len(after.replies),
                })

        original_groups, off_groups, on_groups = map(groups, (originals, off_cases, on_cases))
        compared_groups = [
            {
                "group": list(group),
                "total": scores["total"],
                "baseline": scores["passed"],
                "flagsOff": off_groups[group]["passed"],
                "flagsOn": on_groups[group]["passed"],
            }
            for group, scores in original_groups.items()
        ]
        regressions = [row for row in compared_groups if row["flagsOn"] < row["baseline"]]
        repeated_cases = repeated.versions[version] if repeated is not None else originals
        repeat_verdict_differences = [
            before.id for before, repeat in zip(originals, repeated_cases, strict=True)
            if before.passed != repeat.passed
        ]
        repeat_reply_differences = [
            before.id for before, repeat in zip(originals, repeated_cases, strict=True)
            if before.replies != repeat.replies
        ]
        versions[version] = {
            "casesCompared": len(originals),
            "flagsOffVerdictDifferences": verdict_differences,
            **({"flagsOffCheckDifferences": check_differences} if monitor_requests is not None else {}),
            "flagsOffReplyDifferences": reply_differences,
            "groups": compared_groups,
            "flagsOnRegressions": regressions,
            "repeatVerdictDifferences": repeat_verdict_differences,
            "repeatReplyDifferences": repeat_reply_differences,
            "passed": not (verdict_differences or check_differences or reply_differences or regressions or repeat_verdict_differences),
        }
    audits = ({name: summarize_monitor_audit(receipt.versions, monitor_requests)
               for name, receipt in comparison_inputs.items()} if monitor_requests is not None else {})
    return {
        "schemaVersion": 1,
        "inputs": {
            label: {"commit": receipt.commit, "receiptSha256": receipt.digest}
            for label, receipt in comparison_inputs.items()
        },
        "replyMasks": list(proof.values()),
        "versions": versions,
        **({"monitorAudit": audits} if audits else {}),
        "passed": all(version["passed"] for version in versions.values())
        and (not audits or audits["flagsOn"]["counts"]["falseOffers"] == 0),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--flags-off", required=True, type=Path)
    parser.add_argument("--flags-on", required=True, type=Path)
    parser.add_argument("--baseline-repeat", type=Path)
    parser.add_argument("--reply-masks", type=Path)
    parser.add_argument("--monitor-requests", type=Path,
                        help="audit monitors with a JSON object listing reviewed monitoring-request case IDs by version")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        report = compare(
            *(read_receipt(path) for path in (args.baseline, args.flags_off, args.flags_on)),
            repeated=read_receipt(args.baseline_repeat) if args.baseline_repeat else None,
            masks=json.loads(args.reply_masks.read_bytes()) if args.reply_masks else None,
            monitor_requests={(version, case_id)
                              for version, ids in json.loads(args.monitor_requests.read_bytes()).items() for case_id in ids}
            if args.monitor_requests else None,
        )
        with os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
            json.dump(report, output, indent=2)
            output.write("\n")
    except (AttributeError, KeyError, OSError, TypeError, ValueError) as error:
        parser.exit(2, f"{parser.prog}: {error}\n")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
