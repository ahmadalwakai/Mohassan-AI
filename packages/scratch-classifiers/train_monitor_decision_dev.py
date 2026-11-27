#!/usr/bin/env python3
"""Fit a CPU monitor head and compare it with the reasoner on a bounded development window."""

from __future__ import annotations

import argparse
import base64
import json
import math
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from time import perf_counter

# The monitor trainer sets the BLAS thread limits before importing NumPy.
import train_monitor_decision as monitor
import numpy as np
from scipy.sparse import csr_matrix
from training.linear import acceptance_threshold, logistic, predict, quantize, temperature

TRIAL_SOURCE = "monitor-development-trial"
CODE_PATHS = (
    Path(__file__).resolve().relative_to(monitor.ROOT),
    "packages/scratch-classifiers/train_monitor_decision.py",
    "packages/scratch-classifiers/monitor_corpora.py",
    "packages/scratch-classifiers/prepare_data.py",
    "packages/scratch-classifiers/data/sources.json",
    "packages/scratch-classifiers/data_guard.py",
    "packages/scratch-classifiers/requirements.txt",
    "packages/scratch-classifiers/training/linear.py",
    "packages/scratch-classifiers/src/features.ts",
    "scripts/monitor-decision/export-development.ts",
    "scripts/monitor-decision/featurize-public.ts",
    "apps/server/src/monitors/decision/exclusion.ts",
    "apps/server/src/monitors/decision/frame.ts",
    "apps/server/src/monitors/decision/features.ts",
    "apps/server/src/monitors/decision/reasoner.ts",
    "packages/model-relations/src/monitor-decision.ts",
    "packages/model-relations/src/monitor-arbiter-training.ts",
)


@dataclass(frozen=True)
class Window:
    name: str
    path: Path
    start: datetime
    end: datetime


def read_window(name: str, path: Path) -> Window:
    manifest = json.loads(path.with_name(f"{path.name}.manifest.json").read_bytes())
    bounds = manifest.get("trialWindow")
    if manifest.get("source") != "human" or not isinstance(bounds, dict):
        raise ValueError(f"{name} requires a bounded human trial export.")
    if any(not isinstance(bounds.get(key), str) or not bounds[key].endswith("Z") for key in ("start", "end")):
        raise ValueError(f"{name} trial bounds require UTC timestamps.")
    start, end = monitor.stamp(bounds["start"]), monitor.stamp(bounds["end"])
    if start >= end:
        raise ValueError(f"{name} trial bounds must be increasing.")
    return Window(name, path, start, end)


def load_window(window: Window, schema: monitor.Schema):
    rows, receipt = monitor.load_export(window.path, "human", schema)
    if any(not window.start <= row.proposed_at <= row.feedback_at < window.end for row in rows):
        raise ValueError(f"{window.name} contains decisions outside its declared window.")
    return rows, receipt | {"start": monitor.utc_stamp(window.start), "end": monitor.utc_stamp(window.end)}


def require_disjoint(earlier: list[monitor.RealDecision], later: list[monitor.RealDecision]) -> None:
    if ({row.conversation_key for row in earlier} & {row.conversation_key for row in later}
            or {row.monitor_key for row in earlier} & {row.monitor_key for row in later}):
        raise ValueError("A conversation or monitor crosses trial windows.")


def latest_feedback(rows: list[monitor.RealDecision]) -> list[monitor.RealDecision]:
    by_monitor = {row.monitor_key: row for row in sorted(rows, key=lambda row: (row.feedback_at, row.case_id))}
    return list(by_monitor.values())


def fit_weights(schema: monitor.Schema, features: csr_matrix, expected: Sequence[str],
                calibration: csr_matrix, calibration_targets: Sequence[str]) -> bytes:
    observed = set(expected)
    labels = [label for label in monitor.LABELS if label in observed]
    weights_fit, bias_fit = logistic(features, np.array([labels.index(label) for label in expected]), len(labels))
    weights = np.zeros((schema.dimensions, len(monitor.LABELS)))
    bias = np.full(len(monitor.LABELS), -1e6)
    for index, label in enumerate(labels):
        weights[:, monitor.LABELS.index(label)] = weights_fit[:, index]
        bias[monitor.LABELS.index(label)] = bias_fit[index]
    packed, scale = quantize(weights)

    targets = np.array([monitor.LABELS.index(label) for label in calibration_targets])
    logits = (calibration @ packed) * scale + bias
    calibrated = observed >= set(calibration_targets) and len(set(calibration_targets)) >= 2
    fitted_temperature = temperature(logits, targets) if calibrated else 1.0
    # Match the monitor trainer's calibration target.
    threshold = (acceptance_threshold(predict(logits, fitted_temperature), targets, 0.80)
                 if calibrated else math.nextafter(1.0, math.inf))

    # The runtime loader accepts human production weights, never these trial weights.
    return monitor.json_bytes({
        "schemaVersion": monitor.SCHEMA_VERSION,
        "featureSchemaVersion": monitor.SCHEMA_VERSION,
        "trainingSource": TRIAL_SOURCE,
        "labels": monitor.LABELS,
        "frameFeatureKeys": schema.frame_keys,
        "textFeatureDimensions": schema.text_dimensions,
        "dimensions": schema.dimensions,
        "weights": base64.b64encode(packed.T.tobytes()).decode("ascii"),
        "weightScale": scale,
        "bias": bias.tolist(),
        "temperature": fitted_temperature,
        "threshold": threshold,
    })


def development_offer_ids(path: Path, rows: list[monitor.RealDecision], expected_sha: str) -> set[str]:
    # The common export parser validates the rows but does not retain the original proposed action.
    raw = path.read_bytes()
    if monitor.digest(raw) != expected_sha:
        raise ValueError("Development export changed during evaluation.")
    return {row.case_id for row, line in zip(rows, raw.splitlines(), strict=True)
            if json.loads(line)["monitorDecision"] == "offer"}


def compare_development(rows: list[monitor.RealDecision], offer_ids: set[str], decisions: list[str | None]) -> dict:
    groups = {language: Counter(dict.fromkeys((
        "examples", "eligibleOffers", "positiveOffers", "negativeOffers", "suppressed", "baselineCorrect",
        "candidateCorrect", "gains", "losses",
    ), 0)) for language in monitor.LANGUAGES}
    improved_conversations = set()
    for row, decision in zip(rows, decisions, strict=True):
        group = groups[row.language]
        baseline = row.baseline["label"]
        eligible = baseline == "offer" and row.case_id in offer_ids
        suppress = eligible and decision == "none"
        baseline_passed = baseline == row.expected
        candidate_passed = ("none" if suppress else baseline) == row.expected
        gain = candidate_passed and not baseline_passed
        group.update({
            "examples": 1,
            "eligibleOffers": eligible,
            "positiveOffers": eligible and row.expected == "offer",
            "negativeOffers": eligible and row.expected == "none",
            "suppressed": suppress,
            "baselineCorrect": baseline_passed,
            "candidateCorrect": candidate_passed,
            "gains": gain,
            "losses": baseline_passed and not candidate_passed,
        })
        if gain:
            improved_conversations.add(row.conversation_key)

    overall = {key: sum(group[key] for group in groups.values()) for key in groups[monitor.LANGUAGES[0]]}
    # Same zero-loss conversation-clustered criterion as the monitor arbiter, applied only as a development screen.
    paired_p = 0.5 ** len(improved_conversations) if overall["losses"] == 0 else None
    passed = paired_p is not None and paired_p <= 0.05 and all(
        group["positiveOffers"] and group["negativeOffers"] for group in groups.values()
    )
    return {"overall": overall, "byLanguage": groups, "improvedConversations": len(improved_conversations),
            "pairedSignP": paired_p, "developmentPassed": passed}


def head_decisions(weight_bytes: bytes, features: csr_matrix) -> list[str | None]:
    model = json.loads(weight_bytes)
    packed = np.frombuffer(base64.b64decode(model["weights"]), dtype="<i2").reshape(len(model["labels"]), -1).T
    probabilities = predict((features @ packed) * model["weightScale"] + np.array(model["bias"]), model["temperature"])
    return [model["labels"][index] if confidence >= model["threshold"] else None
            for index, confidence in zip(probabilities.argmax(axis=1), probabilities.max(axis=1), strict=True)]


def run_trial(train_path: Path, calibration_path: Path, development_path: Path, development_end: datetime,
              cache: Path, sources_retrieved_on: date, destination: Path) -> dict:
    start = perf_counter()
    if destination.exists():
        raise ValueError("Choose a new output directory.")
    train, calibration, development = (read_window(name, path) for name, path in (
        ("train", train_path), ("calibration", calibration_path), ("development", development_path),
    ))
    if not train.end <= calibration.start or not calibration.end <= development.start or development.end != development_end:
        raise ValueError("Trial windows must be disjoint, ordered and end at the predeclared development cutoff.")

    metadata = json.loads(monitor.bridge(["--schema"]))
    schema = monitor.Schema(metadata["frameFeatureKeys"], metadata["textFeatureDimensions"])
    training_rows, train_receipt = load_window(train, schema)
    calibration_rows, calibration_receipt = load_window(calibration, schema)
    require_disjoint(training_rows, calibration_rows)
    train_rows, cal_rows = latest_feedback(training_rows), latest_feedback(calibration_rows)
    real_labels = {row.expected for row in train_rows}
    if "none" not in real_labels or not real_labels & {"offer", "propose"}:
        raise ValueError("Need both positive and negative feedback in the fitting window.")
    public_fit, public_receipt = monitor.public_examples(cache, train_rows, schema)
    features, targets = zip(*([(row.features, row.expected) for row in train_rows] + public_fit))
    fit_matrix = monitor.matrix(features, schema)
    calibration_matrix = monitor.matrix([row.features for row in cal_rows], schema)
    fit_started = perf_counter()

    weight_bytes = fit_weights(schema, fit_matrix, targets, calibration_matrix, [row.expected for row in cal_rows])
    weight_sha = monitor.digest(weight_bytes)
    # Freeze the quantized candidate before reading any development decision rows.
    development_started = perf_counter()
    development_rows, development_receipt = load_window(development, schema)
    require_disjoint(training_rows + calibration_rows, development_rows)
    offer_ids = development_offer_ids(development.path, development_rows, development_receipt["sha256"])
    dev_rows = latest_feedback(development_rows)
    development_matrix = monitor.matrix([row.features for row in dev_rows], schema)
    scoring_started = perf_counter()
    decisions = head_decisions(weight_bytes, development_matrix)
    scoring_seconds = perf_counter() - scoring_started
    comparison = compare_development(dev_rows, offer_ids, decisions)
    result = {
        "schemaVersion": monitor.SCHEMA_VERSION,
        "trainingSource": TRIAL_SOURCE,
        "weightsSha256": weight_sha,
        "weightsBytes": len(weight_bytes),
        "batchedHeadScoringMillisecondsPerRow": scoring_seconds * 1_000 / len(dev_rows),
        "fitThrough": monitor.utc_stamp(max(row.feedback_at for row in train_rows + cal_rows)),
        "countsByLanguage": {name: {lang: sum(row.language == lang for row in rows) for lang in monitor.LANGUAGES}
                             for name, rows in (("train", train_rows), ("calibration", cal_rows), ("development", dev_rows))},
        "timingSeconds": {
            "preparation": fit_started - start,
            "trainingAndCalibration": development_started - fit_started,
            "developmentEvaluation": perf_counter() - development_started,
            "batchedDevelopmentHeadScoring": scoring_seconds,
        },
        "comparison": comparison,
    }

    contents = {"trial-weights.json": weight_bytes, "development.json": monitor.json_bytes(result)}
    contents["manifest.json"] = monitor.json_bytes({
        "schemaVersion": monitor.SCHEMA_VERSION,
        "trainingSource": TRIAL_SOURCE,
        "weightsSha256": weight_sha,
        "sha256": {name: monitor.digest(content) for name, content in contents.items()},
        "codeSha256": {str(Path(code).as_posix()): monitor.digest((monitor.ROOT / code).read_bytes()) for code in CODE_PATHS},
        "ownerExports": {
            "usage": "Private owner-local trial only. No public licence.",
            "train": train_receipt,
            "calibration": calibration_receipt,
            "development": development_receipt,
        },
        "publicFit": public_receipt | {"retrievedOn": sources_retrieved_on.isoformat()},
    })
    destination.mkdir(parents=True, mode=0o700)
    with TemporaryDirectory(dir=destination) as temporary:
        for name, content in contents.items():
            (Path(temporary) / name).write_bytes(content)
        for name in contents:
            (Path(temporary) / name).replace(destination / name)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--train-decisions", type=Path, required=True)
    parser.add_argument("--calibration-decisions", type=Path, required=True)
    parser.add_argument("--development-decisions", type=Path, required=True)
    parser.add_argument("--development-end", type=monitor.stamp, required=True, help="Exclusive preregistered UTC cutoff.")
    parser.add_argument("--cache", type=Path, required=True, help="Existing checksum-pinned public cache.")
    parser.add_argument("--sources-retrieved-on", type=date.fromisoformat, required=True,
                        help="Recorded retrieval date (YYYY-MM-DD) for the pinned public archives.")
    parser.add_argument("--output", type=Path, required=True)
    options = parser.parse_args()
    started = perf_counter()
    result = run_trial(options.train_decisions, options.calibration_decisions, options.development_decisions,
                       options.development_end, options.cache, options.sources_retrieved_on, options.output)
    result["timingSeconds"]["totalIncludingArtifactWrites"] = perf_counter() - started
    print(monitor.json_bytes(result).decode(), end="")
    if not result["comparison"]["developmentPassed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
