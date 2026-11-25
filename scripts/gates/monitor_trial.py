"""Score the owner monitor trial from a local production-metrics JSON export."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import operator
import re
import sys
from pathlib import Path

from .common import GateError, parse_json, pinned_bytes, timestamp, write_once
from .evidence import load_cases
from .registration import load_run

HOUR_MS = 3_600_000
WEEK_MS = 168 * HOUR_MS
OPTIONAL_CHANNELS = {"tab", "webPush", "apns"}
COMPARISONS = {"min": operator.ge, "max": operator.le, "eq": operator.eq}


def metric_sum(metrics, paths):
    total = 0
    for path in paths:
        value = metrics
        for part in path.split("."):
            if not isinstance(value, dict) or part not in value:
                raise GateError(f"Missing registered metric {path}.")
            value = value[part]
        if value is None:
            return None
        if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
            raise GateError(f"Invalid numeric value for registered metric {path}.")
        total += value
    return total


def score_trial(trial, report, cases):
    start_ms = trial.get("startMs")
    if type(start_ms) is not int or start_ms < 0 or start_ms % HOUR_MS:
        raise GateError("The approved trial must start on a UTC hour boundary.")
    end_ms = start_ms + WEEK_MS
    channels = trial.get("deliveryChannels")
    release = trial.get("releaseCommit")
    if (not isinstance(channels, list) or any(channel not in OPTIONAL_CHANNELS for channel in channels)
            or len(set(channels)) != len(channels) or not isinstance(release, str) or not re.fullmatch(r"[0-9a-f]{40}", release)):
        raise GateError("The approved trial needs the release commit and intended notification channels.")
    week = report.get("completedMonitorWeek", {})
    generated = report.get("generatedAtMs")
    if (report.get("enabled") is not True or report.get("snapshotAvailable") is not True
            or report.get("countingOnly") is not False or type(generated) is not int
            or not end_ms <= generated < end_ms + HOUR_MS or week.get("startMs") != start_ms
            or week.get("endMs") != end_ms or not isinstance(week.get("monitors"), dict)):
        raise GateError("Export complete monitor metrics during the first UTC hour after the approved trial closes.")

    results = []
    metrics = week["monitors"]
    for case in cases:
        value = metric_sum(metrics, case["metrics"])
        comparison = case["comparison"]
        target = case["threshold"]
        if "channel" in case and case["channel"] not in channels:
            comparison, target = "eq", 0
        if "denominator" in case:
            denominator = metric_sum(metrics, case["denominator"])
            value = value / denominator if denominator and value is not None else None
        if "thresholdMetric" in case:
            target = metric_sum(metrics, [case["thresholdMetric"]])
        passed = value is not None and target is not None and COMPARISONS[comparison](value, target)
        results.append({"id": case["id"], "label": "pass" if passed else "stop", "confidence": 1,
                        "value": value, "comparison": comparison, "threshold": target})
    return results


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path, help="The gate run started before the trial.")
    parser.add_argument("metrics", type=Path, help="The owner-only JSON export for the completed window.")
    args = parser.parse_args(argv)
    argv = sys.argv[1:] if argv is None else argv
    try:
        document, start, pins = load_run(args.run)
        if document["gate_id"] != "monitor-owner-week-phase1":
            raise GateError("Choose the monitor owner-week gate run.")
        trial = parse_json(pinned_bytes(pins["candidate"], "approved trial plan"), "approved trial plan")
        producer_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        if trial.get("producerSha256") != producer_hash:
            raise GateError("The metrics evaluator differs from the approved trial plan.")
        report_bytes = args.metrics.read_bytes()
        report = parse_json(report_bytes, "production metrics export")
        results = score_trial(trial, report, load_cases(document, pins))
        if timestamp(start["started_at"]).timestamp() * 1000 > trial["startMs"]:
            raise GateError("The gate run must start before the approved trial window opens.")
        report_hash = hashlib.sha256(report_bytes).hexdigest()
        write_once(args.run / "candidate-provenance.json", {
            "command": [sys.executable, "-m", "scripts.gates.monitor_trial", *argv], "settings": None,
        })
        for result in results:
            print(json.dumps({**result, "metricsSha256": report_hash}, allow_nan=False))
    except (GateError, OSError, TypeError, ValueError, KeyError, AttributeError) as error:
        parser.exit(1, f"Trial evaluation failed: {error}\n")


if __name__ == "__main__":
    main()
