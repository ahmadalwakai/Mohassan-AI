"""Prepare pinned public data, fit all four CPU heads, and export verified model bytes."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from array import array
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

# Keep reduction order fixed and avoid multithreaded BLAS overhead on small models.
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"

import numpy as np
from scipy.sparse import csr_matrix

from data_guard import read_receipt
from training.features import feature_ids
from training.linear import acceptance_threshold, logistic, macro_f1, perceptron, predict, quantize, score, temperature

PACKAGE = Path(__file__).resolve().parent
DATA_DIR = PACKAGE.parents[1] / ".data" / "scratch-classifiers"
HEADS = ("refusal", "speechAct", "route", "followUp")
SPLITS = ("train", "dev", "calibration", "test")
DIMENSIONS = 32768
SEED = 20261125
ACCEPTED_ACCURACY = 0.80


@dataclass(frozen=True)
class Example:
    text: str
    previous: str | None
    label: str
    dataset: str


def read_data(path: Path) -> dict[str, dict[str, list[Example]]]:
    data = {head: {split: [] for split in SPLITS} for head in HEADS}
    with path.open(encoding="utf-8") as rows:
        for line_number, line in enumerate(rows, 1):
            row = json.loads(line)
            previous = row.get("previous")
            labels = row["labels"]
            if (row["split"] not in SPLITS or not isinstance(row["text"], str)
                or not isinstance(row["dataset"], str) or previous is not None and not isinstance(previous, str)
                or not labels or any(head not in HEADS or not isinstance(label, str) or not label
                                     for head, label in labels.items())):
                raise ValueError(f"Invalid prepared example at line {line_number}")
            for head, label in labels.items():
                data[head][row["split"]].append(Example(
                    row["text"], previous if head == "followUp" else None, label, row["dataset"],
                ))
    return data


def featurize(examples: list[Example], label_ids: dict[str, int], dimensions: int) -> tuple[csr_matrix, np.ndarray]:
    indices = array("i")
    pointers = array("i", [0])
    for example in examples:
        indices.extend(feature_ids(example.text, dimensions, example.previous))
        pointers.append(len(indices))
    matrix = csr_matrix((np.ones(len(indices)), indices, pointers), shape=(len(examples), dimensions))
    return matrix, np.array([label_ids[example.label] for example in examples], dtype=int)


def fit_head(splits: dict[str, list[Example]], dimensions: int, seed: int) -> tuple[dict, dict, list[dict]]:
    labels = sorted({example.label for example in splits["train"]})
    other_labels = {example.label for split in SPLITS[1:] for example in splits[split]} - set(labels)
    if len(labels) < 2 or other_labels or not all(splits[split] for split in SPLITS):
        raise ValueError(f"Each split needs examples and every class needs training data. Missing training labels: {other_labels}")
    label_ids = {label: index for index, label in enumerate(labels)}
    train_x, train_y = featurize(splits["train"], label_ids, dimensions)
    dev_x, dev_y = featurize(splits["dev"], label_ids, dimensions)
    candidates = (
        ("logistic", lambda: logistic(train_x, train_y, len(labels))),
        ("averaged_perceptron", lambda: perceptron(train_x, train_y, len(labels), seed)),
    )
    candidate_f1 = {}
    best = None
    best_f1 = -1.0
    best_name = ""
    for name, fit in candidates:
        weights, bias = fit()
        quantized, scale = quantize(weights)
        dev_logits = (dev_x @ quantized) * scale + bias
        f1 = macro_f1(dev_logits.argmax(axis=1), dev_y, len(labels))
        candidate_f1[name] = f1
        if f1 > best_f1:
            best = (quantized, scale, bias, dev_logits)
            best_f1 = f1
            best_name = name
    assert best is not None
    quantized, scale, bias, dev_logits = best

    calibration_x, calibration_y = featurize(splits["calibration"], label_ids, dimensions)
    calibration_logits = (calibration_x @ quantized) * scale + bias
    fitted_temperature = temperature(calibration_logits, calibration_y)
    calibration_probabilities = predict(calibration_logits, fitted_temperature)
    threshold = acceptance_threshold(calibration_probabilities, calibration_y, ACCEPTED_ACCURACY)

    test_x, test_y = featurize(splits["test"], label_ids, dimensions)
    test_probabilities = predict((test_x @ quantized) * scale + bias, fitted_temperature)
    dataset_rows = defaultdict(list)
    for index, example in enumerate(splits["test"]):
        dataset_rows[example.dataset].append(index)
    metrics = {
        "labels": labels,
        "selectedModel": best_name,
        "developmentMacroF1": candidate_f1,
        "splitSizes": {split: len(splits[split]) for split in SPLITS},
        "temperature": fitted_temperature,
        "threshold": threshold,
        "calibration": score(calibration_probabilities, calibration_y, labels, threshold),
        "test": {
            dataset: score(test_probabilities[indices], test_y[indices], labels, threshold)
            for dataset, indices in sorted(dataset_rows.items())
        },
    }
    model = {
        "version": 1,
        "labels": labels,
        "dimensions": dimensions,
        "weights": base64.b64encode(quantized.T.tobytes()).decode("ascii"),
        "weightScale": scale,
        "bias": bias.tolist(),
        "temperature": fitted_temperature,
        "threshold": threshold,
    }

    goldens = []
    # Sample development examples for parity without redistributing red-team prompts.
    seen = set()
    for example, probabilities in zip(splits["dev"], predict(dev_logits, fitted_temperature), strict=True):
        if example.dataset.startswith("aya-"):
            continue
        top_indices = np.argsort(-probabilities, kind="stable")[:3]
        abstained = bool(probabilities[top_indices[0]] < threshold)
        identity = (example.dataset, abstained)
        if identity in seen or not feature_ids(example.text, dimensions):
            continue
        seen.add(identity)
        goldens.append({
            "dataset": example.dataset,
            "text": example.text,
            **({"previousText": example.previous} if example.previous is not None else {}),
            "abstained": abstained,
            "topK": [{"label": labels[index], "score": float(probabilities[index])} for index in top_indices],
        })
    return model, metrics, goldens


def json_bytes(value: object, *, pretty: bool = False) -> bytes:
    return (json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True,
                       indent=2 if pretty else None, separators=None if pretty else (",", ":")) + "\n").encode("utf-8")


def train(path: Path, output: Path, seed: int) -> None:
    with path.open("rb") as prepared:
        data_sha256 = hashlib.file_digest(prepared, "sha256").hexdigest()
    receipt = read_receipt(path, data_sha256, seed)
    data = read_data(path)
    models = {}
    goldens = []
    report = {"version": 1, "seed": seed, "minimumCalibrationAccuracy": ACCEPTED_ACCURACY,
              "dataSha256": data_sha256, "exclusionReceipt": receipt, "heads": {}}
    for head in HEADS:
        print(f"Training {head}…", flush=True)
        model, metrics, examples = fit_head(data[head], DIMENSIONS, seed)
        model_bytes = json_bytes(model)
        if len(model_bytes) >= 2_000_000:
            raise ValueError(f"{head} exceeds the 2 MB artifact budget")
        models[head] = model_bytes
        metrics["modelBytes"] = len(model_bytes)
        report["heads"][head] = metrics
        goldens.extend({"head": head, **example} for example in examples)
        print(f"{head}: {metrics['selectedModel']}, {metrics['developmentMacroF1']}, {len(model_bytes)} bytes", flush=True)

    # Each file is replaced atomically. Publish the checksum manifest after model files.
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as staging_path:
        staging = Path(staging_path)
        contents = {f"{head}.json": model for head, model in models.items()}
        contents["golden.json"] = json_bytes({"version": 1, "cases": goldens}, pretty=True)
        contents["metrics.json"] = json_bytes(report, pretty=True)
        contents["manifest.json"] = json_bytes({"version": 1, "sha256": {
            head: hashlib.sha256(model).hexdigest() for head, model in models.items()
        }}, pretty=True)
        for name, value in contents.items():
            (staging / name).write_bytes(value)
        for name in contents:
            (staging / name).replace(output / name)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, help="Use prepared JSONL with its v2 exclusion receipt instead of fetching the pinned sources.")
    parser.add_argument("--cache", type=Path, default=DATA_DIR / "sources", help="Directory for pinned download caches.")
    parser.add_argument("--output", type=Path, default=PACKAGE / "models")
    parser.add_argument("--seed", type=int, default=SEED)
    options = parser.parse_args()
    if options.data is None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=DATA_DIR) as temporary:
            path = Path(temporary) / "data.jsonl"
            subprocess.run([sys.executable, str(PACKAGE / "prepare_data.py"), "--output", str(path),
                            "--cache", str(options.cache), "--seed", str(options.seed)], check=True)
            train(path, options.output, options.seed)
    else:
        train(options.data, options.output, options.seed)


if __name__ == "__main__":
    main()
