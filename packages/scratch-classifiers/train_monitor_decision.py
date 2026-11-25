#!/usr/bin/env python3
"""Fit the monitor decision head offline from an owner export and pinned public rows."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import re
import subprocess
from bisect import bisect_right
from collections import Counter, defaultdict, deque
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory

os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"

import numpy as np
from scipy.sparse import csr_matrix

from data_guard import ContaminationGuard, REGISTRY_SHA256
from training.linear import acceptance_threshold, logistic, predict, quantize, score, temperature

PACKAGE = Path(__file__).resolve().parent
ROOT = PACKAGE.parents[1]
BRIDGE = ROOT / "scripts/monitor-decision/featurize-public.ts"
LABELS = ["none", "offer", "propose", "manage", "reminder"]
STAGES = ("headTrain", "headCalibration", "arbiterTrain", "arbiterCalibration", "holdout")
LANGUAGES = ("ar", "en")
CONVERSATION_STATES = ("initial", "follow-up", "pending")
POSITIVE_EVENTS = frozenset({"approved", "alert_helpful"})
NEGATIVE_EVENTS = frozenset({"declined", "stopped_early", "alert_unhelpful"})
SHA256 = re.compile(r"[0-9a-f]{64}")
SCHEMA_VERSION = 1


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_bytes(data: object) -> bytes:
    return (json.dumps(data, ensure_ascii=False, allow_nan=False, indent=2) + "\n").encode()


def stamp(value: str) -> datetime:
    result = datetime.fromisoformat(value)
    if result.utcoffset() is None:
        raise ValueError("Decision timestamps require a timezone.")
    return result


def utc_stamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class Features:
    ids: list[int]
    frame: dict[str, float]


@dataclass(frozen=True)
class RealDecision:
    case_id: str
    conversation_key: str
    monitor_key: str
    language: str
    expected: str
    proposed_at: datetime
    feedback_at: datetime
    conversation_state: str
    length: int
    baseline: dict
    features: Features


@dataclass(frozen=True)
class Schema:
    frame_keys: list[str]
    text_dimensions: int

    @property
    def dimensions(self) -> int:
        return self.text_dimensions + len(self.frame_keys)

    def parse(self, row: dict) -> Features:
        ids, frame = row["textFeatureIds"], row["frameFeatures"]
        if (not isinstance(ids, list) or any(type(index) is not int or not 0 <= index < self.text_dimensions
                                              for index in ids) or ids != sorted(set(ids))):
            raise ValueError("Invalid hashed text features.")
        if (not isinstance(frame, dict) or set(frame) != set(self.frame_keys)
                or any(type(value) not in (int, float) or not 0 <= value <= 8_000 for value in frame.values())):
            raise ValueError("Invalid monitor frame features.")
        return Features(ids, frame)


def bridge(args: list[str], input_text: str = "") -> str:
    result = subprocess.run(
        ["node", "--import", "tsx", str(BRIDGE), *args],
        cwd=ROOT, input=input_text, capture_output=True, encoding="utf-8", check=True,
    )
    return result.stdout


def load_export(path: Path, source: str, schema: Schema) -> tuple[list[RealDecision], dict]:
    raw = path.read_bytes()
    manifest = json.loads(path.with_name(f"{path.name}.manifest.json").read_bytes())
    if (manifest.get("version") != SCHEMA_VERSION or manifest.get("sha256") != digest(raw)
            or manifest.get("source") != source or manifest.get("v2ExclusionSha256") != REGISTRY_SHA256):
        raise ValueError("Expected a checksum-matched owner export with the required provenance and exclusion pin.")
    rows = []
    for line in raw.splitlines():
        row = json.loads(line)
        event = row["decision"]
        candidate = row["monitorDecision"]
        baseline = row["reasonerDecision"]
        confidence = row["reasonerScore"]
        proposed, feedback = stamp(row["proposedAt"]), stamp(row["decisionAt"])
        if (event not in POSITIVE_EVENTS | NEGATIVE_EVENTS or candidate not in ("offer", "propose")
                or baseline not in LABELS or type(confidence) not in (int, float) or not 0 <= confidence <= 1
                or row["language"] not in LANGUAGES or feedback < proposed
                or row["conversationState"] not in CONVERSATION_STATES
                or type(row["length"]) is not int or not 0 <= row["length"] <= 8_000
                or not all(SHA256.fullmatch(row[key]) for key in ("conversationKey", "monitorKey"))):
            raise ValueError("Invalid decision event in owner export.")
        case_id = digest(json.dumps([row["monitorKey"], row["decisionAt"], event]).encode())
        rows.append(RealDecision(
            case_id, row["conversationKey"], row["monitorKey"], row["language"],
            candidate if event in POSITIVE_EVENTS else "none",
            proposed, feedback, row["conversationState"], row["length"],
            {"label": baseline, "score": confidence}, schema.parse(row),
        ))
    if len(rows) != manifest.get("rows") or not rows:
        raise ValueError("Decision export is empty or its row count does not match the manifest.")
    return rows, {key: manifest[key] for key in ("version", "sha256", "source", "v2ExclusionSha256", "rows")}


def chronological_split(rows: list[RealDecision]) -> tuple[dict[str, list[RealDecision]], dict]:
    # Count one decision per monitor. Its newest feedback supersedes the initial approval.
    last_feedback = {}
    for row in sorted(rows, key=lambda item: (item.feedback_at, item.case_id)):
        last_feedback[row.monitor_key] = row
    cases = sorted(last_feedback.values(), key=lambda row: (row.proposed_at, row.case_id))
    boundaries = [cases[len(cases) * part // 10].proposed_at for part in (6, 7, 8, 9)]
    conv_partitions = defaultdict(set)
    for row in cases:
        conv_partitions[row.conversation_key].add(bisect_right(boundaries, row.proposed_at))

    splits: dict[str, list[RealDecision]] = {stage: [] for stage in STAGES}
    skipped = Counter()
    for row in cases:
        partition = bisect_right(boundaries, row.proposed_at)
        if len(conv_partitions[row.conversation_key]) > 1:
            skipped["conversationSpansBoundary"] += 1
        elif partition < len(boundaries) and row.feedback_at >= boundaries[partition]:
            skipped["feedbackCrossesBoundary"] += 1
        else:
            splits[STAGES[partition]].append(row)
    if not all(splits.values()):
        raise ValueError("Need decisions in all five disjoint chronological stages after dropping crossing groups.")
    return splits, {
        "boundaries": [utc_stamp(time) for time in boundaries],
        "supersededEvents": len(rows) - len(cases),
        "excludedDecisions": dict(skipped),
        "sizes": {stage: len(items) for stage, items in splits.items()},
        "sizesByLanguage": {
            stage: {language: sum(row.language == language for row in items) for language in LANGUAGES}
            for stage, items in splits.items()
        },
    }


def public_examples(cache: Path, real_fit: list[RealDecision], schema: Schema):
    from monitor_corpora import decision, pins, rows

    guard = ContaminationGuard.load()
    grouped = defaultdict(list)
    for row in rows(cache, guard, {"train"}):
        label = decision(row)
        if label is not None:
            if label not in ("none", "reminder"):
                raise ValueError("Public supervision is restricted to negatives and time reminders.")
            if row.partition not in ("train", "oos_train"):
                raise ValueError("Public fitting requires the official training partitions.")
            grouped[row.language, label, row.dataset, row.family].append(row)

    # Bound public volume by real fitting support and round-robin families so
    # the public intent priors cannot determine how often an offer is learned.
    pools = {
        key: deque(sorted(items, key=lambda row: digest(row.source_id.encode())))
        for key, items in sorted(grouped.items())
    }
    counts = Counter(row.language for row in real_fit)
    selected = []
    for language in LANGUAGES:
        for label in ("none", "reminder"):
            by_corpus = defaultdict(deque)
            for key, pool in pools.items():
                if key[:2] == (language, label):
                    by_corpus[key[2]].append(pool)
            corpora = deque(by_corpus.values())
            limit = (counts[language] + int(label == "reminder")) // 2
            for _ in range(limit):
                if not corpora:
                    break
                families = corpora.popleft()
                pool = families.popleft()
                selected.append((pool.popleft(), label))
                if pool:
                    families.append(pool)
                if families:
                    corpora.append(families)
    if not selected or not any(label == "reminder" for _, label in selected):
        raise ValueError("The real fitting window needs public negatives and time-reminder near misses.")
    reference_time = utc_stamp(max(row.proposed_at for row in real_fit))
    public_text = "".join(json.dumps(row.text, ensure_ascii=False) + "\n" for row, _ in selected)
    results = bridge([reference_time], public_text).splitlines()
    examples = [(schema.parse(json.loads(line)), label) for line, (_, label) in zip(results, selected, strict=True)]
    provenance = Counter((row.dataset, label) for row, label in selected)
    provenance_sha = digest(json_bytes([[row.source_id, label] for row, label in selected]))
    return examples, {
        "sources": pins(),
        "selected": {
            dataset: {label: count for (name, label), count in sorted(provenance.items()) if dataset == name}
            for dataset in sorted({name for name, _ in provenance})
        },
        "excluded": guard.receipt(provenance_sha, 0)["droppedRows"],
        "selectedSourceIdsSha256": provenance_sha,
        "referenceTime": reference_time,
    }


def matrix(examples: Sequence[Features], schema: Schema) -> csr_matrix:
    values, indices, offsets = [], [], [0]
    for example in examples:
        values.extend([1.0] * len(example.ids))
        indices.extend(example.ids)
        for index, key in enumerate(schema.frame_keys, schema.text_dimensions):
            value = example.frame[key]
            if value:
                values.append(value)
                indices.append(index)
        offsets.append(len(indices))
    return csr_matrix((values, indices, offsets), shape=(len(examples), schema.dimensions))


def output_artifacts(path: Path, source: str, schema: Schema, cache: Path | None, destination: Path):
    if destination.exists():
        raise ValueError("Choose a new output directory.")
    rows, export = load_export(path, source, schema)
    splits, split_report = chronological_split(rows)
    real_fit = splits["headTrain"]
    real_labels = {row.expected for row in real_fit}
    if "none" not in real_labels or not real_labels & {"offer", "propose"}:
        raise ValueError("Need both positive and negative feedback in the fitting window.")
    public_fit, public = public_examples(cache, real_fit, schema) if cache else ([], None)
    fit = [(row.features, row.expected) for row in real_fit] + public_fit
    features, expected = zip(*fit)
    observed = set(expected)
    labels_fit = [label for label in LABELS if label in observed]
    weights_fit, bias_fit = logistic(
        matrix(features, schema), np.array([labels_fit.index(label) for label in expected]), len(labels_fit),
    )
    # Keep the common five-label contract. A label unsupported by fitting data
    # never becomes a contender during calibration or held-out evaluation.
    weights = np.zeros((schema.dimensions, len(LABELS)))
    bias = np.full(len(LABELS), -1e6)
    for index, label in enumerate(labels_fit):
        weights[:, LABELS.index(label)] = weights_fit[:, index]
        bias[LABELS.index(label)] = bias_fit[index]
    packed, weight_scale = quantize(weights)

    def logits(items: list[RealDecision]) -> np.ndarray:
        return (matrix([row.features for row in items], schema) @ packed) * weight_scale + bias

    def targets(items: list[RealDecision]) -> np.ndarray:
        return np.array([LABELS.index(row.expected) for row in items])

    calibration = splits["headCalibration"]
    calibration_logits, calibration_targets = logits(calibration), targets(calibration)
    calibrated = set(labels_fit) >= {row.expected for row in calibration} and len(set(calibration_targets)) >= 2
    fitted_temperature = temperature(calibration_logits, calibration_targets) if calibrated else 1.0
    calibration_probs = predict(calibration_logits, fitted_temperature)
    threshold = (acceptance_threshold(calibration_probs, calibration_targets, 0.80)
                 if calibrated else math.nextafter(1.0, math.inf))
    model = {
        "schemaVersion": SCHEMA_VERSION,
        "featureSchemaVersion": SCHEMA_VERSION,
        "trainingSource": source,
        "labels": LABELS,
        "frameFeatureKeys": schema.frame_keys,
        "textFeatureDimensions": schema.text_dimensions,
        "dimensions": schema.dimensions,
        "weights": base64.b64encode(packed.T.tobytes()).decode("ascii"),
        "weightScale": weight_scale,
        "bias": bias.tolist(),
        "temperature": fitted_temperature,
        "threshold": threshold,
    }
    weight_bytes = json_bytes(model)
    weight_sha = digest(weight_bytes)

    replays = []
    for stage in STAGES[2:]:
        items = splits[stage]
        for row, probs in zip(items, predict(logits(items), fitted_temperature), strict=True):
            confidence, label = float(probs.max()), LABELS[int(probs.argmax())]
            replays.append({
                "caseId": row.case_id,
                "occurredAt": utc_stamp(row.feedback_at),
                "language": row.language,
                "conversationState": row.conversation_state,
                "length": row.length,
                "expected": row.expected,
                "baseline": row.baseline,
                "learned": {"label": label, "score": confidence} if confidence >= threshold else None,
                "stage": stage,
            })
    replays.sort(key=lambda row: (stamp(row["occurredAt"]), row["caseId"]))
    heldout = splits["holdout"]
    evaluation = {
        "version": SCHEMA_VERSION,
        "trainingSource": source,
        "split": split_report,
        "fittedLabelSupport": dict(Counter(expected)),
        "calibrationLabelSupport": dict(Counter(row.expected for row in calibration)),
        "holdoutLabelSupport": dict(Counter(row.expected for row in heldout)),
    }
    if source == "human":
        evaluation["calibration"] = score(calibration_probs, calibration_targets, LABELS, threshold)
        by_language = {}
        for language in LANGUAGES:
            items = [row for row in heldout if row.language == language]
            by_language[language] = language_metrics(items, targets, logits, fitted_temperature, threshold)
        evaluation["holdout"] = {
            "overall": language_metrics(heldout, targets, logits, fitted_temperature, threshold),
            "byLanguage": by_language,
        }
    else:
        evaluation["notice"] = "Pipeline check only. Generated labels do not measure real decision accuracy."

    contents = {
        "weights.json": weight_bytes,
        "evaluation.json": json_bytes(evaluation),
        "arbiter-replay.json": json_bytes({
            "schemaVersion": SCHEMA_VERSION,
            "trainingSource": source,
            "weightsSha256": weight_sha,
            "headTrainingThrough": utc_stamp(max(row.feedback_at for row in real_fit + calibration)),
            "rows": replays,
        }),
        "MODEL-CARD.md": model_card(source, labels_fit, split_report),
    }
    contents["manifest.json"] = json_bytes({
        "schemaVersion": SCHEMA_VERSION,
        "trainingSource": source,
        "weightsSha256": weight_sha,
        "sha256": {name: digest(content) for name, content in contents.items()},
        "codeSha256": {str(code.relative_to(ROOT)): digest(code.read_bytes()) for code in (
            Path(__file__).resolve(), BRIDGE, PACKAGE / "monitor_corpora.py", PACKAGE / "training/linear.py",
            PACKAGE / "data_guard.py", ROOT / "apps/server/src/monitors/decision/frame.ts",
            ROOT / "apps/server/src/monitors/decision/features.ts",
        )},
        "ownerExport": export,
        "publicFit": public,
        "split": split_report,
    })
    destination.mkdir(parents=True, mode=0o700)
    with TemporaryDirectory(dir=destination) as temporary:
        staged = Path(temporary)
        for name, content in contents.items():
            (staged / name).write_bytes(content)
        for name in contents:
            (staged / name).replace(destination / name)
    print(json.dumps({"source": source, "weightsBytes": len(weight_bytes), "weightsSha256": weight_sha,
                      "sizes": split_report["sizes"], "arbiterRows": len(replays)}))


def language_metrics(items, targets, logits, fitted_temperature, threshold):
    if not items:
        return {"examples": 0}
    return score(predict(logits(items), fitted_temperature), targets(items), LABELS, threshold) | {
        "baselineCorrect": sum(row.baseline["label"] == row.expected for row in items),
    }


def model_card(source: str, labels: list[str], split: dict) -> bytes:
    languages = "\n".join(
        f"| {name} | {counts['ar']} | {counts['en']} |"
        for name, counts in split["sizesByLanguage"].items()
    )
    claim = ("Pipeline check only. Code-generated feedback exercises the private recording and training format. "
             "This model and replay cannot be used for runtime or promotion.") if source == "pipeline-check" else (
        "Only observed human monitor feedback contributes to calibration, arbiter fitting or evaluation. "
        "Held-out feedback reflects the utility of monitor decisions on exposed proposals. "
        "It cannot estimate population-wide missed monitor needs or reminder accuracy."
    )
    return f"""# Monitor context decision head

{claim}

The CPU trainer starts multinomial logistic regression at zero, uses L2 regularization
and inverse square-root class frequency weights, and quantizes weights to signed
16-bit integers. The inputs are bounded numeric frame features and hashed Unicode
character and word features from the current user turn and previous assistant turn.
The five runtime labels are `{", ".join(LABELS)}`. Fitting support was available for
`{", ".join(labels)}`.

Approvals and helpful alerts support the action originally proposed. A decline,
early stop or unhelpful alert counts against that original action. The newest
event per monitor supplies its label. Delayed feedback and conversations that
straddle split boundaries are excluded from the comparable windows.

| Window | Arabic decisions | English decisions |
| --- | ---: | ---: |
{languages}

Human training uses the official CLINC150 and MASSIVE training partitions
through the capability v2 contamination guard. The export and source pins
are recorded in the manifest. Management and time-trigger safety checks remain
authoritative in chat. The reasoner remains the default until the arbiter dual
gate passes on real chronological holdout decisions.
[Scratch classifier data card](https://github.com/ahmadalwakai/Mohassan-AI/blob/c88a38a3bb5f07186885af31cdc8c18174af12f1/packages/scratch-classifiers/DATA-CARD.md)
""".encode("utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--decisions", type=Path, required=True)
    parser.add_argument("--cache", type=Path, help="Existing checksum-pinned public corpus cache. No download occurs.")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--pipeline-check", action="store_true", help="Use only a generated pipeline-check export.")
    options = parser.parse_args()
    if options.pipeline_check == (options.cache is not None):
        parser.error("Human training requires --cache; --pipeline-check uses only its marked fixture export.")
    metadata = json.loads(bridge(["--schema"]))
    schema = Schema(metadata["frameFeatureKeys"], metadata["textFeatureDimensions"])
    output_artifacts(options.decisions, "pipeline-check" if options.pipeline_check else "human",
                     schema, options.cache, options.output)


if __name__ == "__main__":
    main()
