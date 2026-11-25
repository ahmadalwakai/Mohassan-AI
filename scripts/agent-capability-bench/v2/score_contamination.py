"""Score the training-overlap-free cases from private PR #63-style receipts."""

import argparse
from hashlib import sha256
import json
from pathlib import Path


PAYLOAD_SHA256 = "6ab7dac41ba54eccf0a48fd0958eada651e0c0fcb3a1156913bd6b9fdb25abbf"
MANIFEST_SHA256 = "c7ab3fbe2340053fca18ed892da1f248fc5fb92ffbc76d14cf2d2300aa20daf6"
COLLECTOR_SHA256 = "5e3c96492703f5529972ffe61390fd7e1ad67868806d8f745c13fe228bc3d1bd"
BASELINE = "c2a0ff765071657cf200b5ee7d12fabaad738c0b"
CANDIDATES = {
    "47": "8d6be4c66329679eb901e8129690562cb5df183a",
    "57": "1374bc44c0d73e8567acb5814e938f2576676fde",
}


def read_receipt(directory, lane, commit):
    raw = (directory / f"{lane}.paired.json").read_bytes()
    receipt = json.loads(raw)
    source = receipt["source"]
    baseline_verified = lane == "baseline"
    if (
        receipt["schemaVersion"] != 1
        or receipt["partition"] != "v2-sealed"
        or receipt["payloadSha256"] != PAYLOAD_SHA256
        or receipt["manifestSha256"] != MANIFEST_SHA256
        or source["gitCommit"] != commit
        or source["trackedWorktreeClean"] is not True
        or source["baselineVerified"] is not baseline_verified
        or source["harnessSha256"]["collect-paired-outcomes.ts"] != COLLECTOR_SHA256
    ):
        raise ValueError(f"{lane} receipt has unexpected evaluation provenance")

    outcomes = receipt["outcomes"]
    overall = receipt["summary"]["overall"]
    rows = {row["id"]: row for row in outcomes}
    if (
        len(rows) != 1200
        or len(outcomes) != 1200
        or overall["total"] != 1200
        or any(type(row["passed"]) is not bool for row in outcomes)
        or overall["passed"] != sum(row["passed"] for row in outcomes)
    ):
        raise ValueError(f"{lane} receipt has incomplete or inconsistent outcomes")
    return rows, {
        "sha256": sha256(raw).hexdigest(),
        "startedAt": receipt["startedAt"],
        "finishedAt": receipt["finishedAt"],
        "runtime": receipt["runtime"],
    }


def count_pairs(ids, baseline, candidate):
    pairs = [(baseline[key]["passed"], candidate[key]["passed"]) for key in ids]
    gains = pairs.count((False, True))
    losses = pairs.count((True, False))
    net = gains - losses
    return {
        "cases": len(pairs),
        "baselinePassed": sum(before for before, _ in pairs),
        "candidatePassed": sum(after for _, after in pairs),
        "gains": gains,
        "losses": losses,
        "net": net,
        "netPercentagePoints": round(100 * net / len(pairs), 2) if pairs else None,
    }


def score_pair(baseline, candidate, excluded_ids):
    if baseline.keys() != candidate.keys():
        raise ValueError("Paired receipts have different case IDs")
    for key, before in baseline.items():
        after = candidate[key]
        if (before["area"], before["language"]) != (after["area"], after["language"]):
            raise ValueError("Paired receipts disagree on case metadata")

    if not isinstance(excluded_ids, list) or any(not isinstance(key, str) for key in excluded_ids):
        raise ValueError("Sealed exclusions must be an array of case IDs")
    excluded = set(excluded_ids)
    if len(excluded) != len(excluded_ids) or not excluded <= baseline.keys():
        raise ValueError("Sealed exclusions contain repeated or unknown case IDs")
    clean = baseline.keys() - excluded
    all_cases = count_pairs(baseline, baseline, candidate)
    clean_cases = count_pairs(clean, baseline, candidate)
    return {
        "all": all_cases,
        "excluded": count_pairs(excluded, baseline, candidate),
        "clean": clean_cases,
        "percentOfFullNetRetained": round(100 * clean_cases["net"] / all_cases["net"], 2)
        if all_cases["net"] else None,
        "cleanByArea": {
            area: count_pairs([key for key in clean if baseline[key]["area"] == area], baseline, candidate)
            for area in sorted({row["area"] for row in baseline.values()})
        },
    }


def score_exposure(baseline, candidate, excluded, fit_excluded):
    combined = score_pair(baseline, candidate, excluded)
    fit_only = score_pair(baseline, candidate, fit_excluded)
    if not set(fit_excluded) <= set(excluded):
        raise ValueError("Fit exclusions must be included in combined exposure exclusions")
    return {**combined, "fitOnly": fit_only}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("receipts", type=Path)
    parser.add_argument("overlap", type=Path)
    args = parser.parse_args()
    overlap = json.loads(args.overlap.read_text(encoding="utf-8"))
    excluded = overlap["sealedExcludedCaseIds"]
    fit_excluded = overlap["sealedFitExcludedCaseIds"]
    baseline, baseline_info = read_receipt(args.receipts, "baseline", BASELINE)
    report = {"baselineReceipt": baseline_info}
    for pr, commit in CANDIDATES.items():
        candidate, info = read_receipt(args.receipts, f"pr-{pr}", commit)
        report[pr] = {"receipt": info, **score_exposure(baseline, candidate, excluded[pr], fit_excluded[pr])}
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
