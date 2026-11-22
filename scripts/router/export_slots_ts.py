"""Derive an immutable TS inference bundle from the frozen slot candidate.

No retraining, threshold fitting, owner data, assessment data or runtime
activation. The bundle copies raw weights and binds a Unicode/feature contract,
strict tensor layout, source checksums and unchanged date/place calibration.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import struct
import sys
import unicodedata
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
CANDIDATE = ROOT / "artifacts/brain-slot-development-v1/first-cpu-20261121-a"
OUTPUT = ROOT / "artifacts/brain-slot-development-v1"
FIXTURE = ROOT / "tests/fixtures/slot-tagger-v1"
FORMAT = "mohassan-slot-tagger-ts-v1"
FEATURE_VERSION = "slot-token-ngrams-unicode14-v1"
CANONICAL_VERSION = "typed-ieee754-be-v1"
SLOTS = ("place", "date", "time", "time_of_day", "time_zone", "news_topic")
TAGS = ["O", *(tag for slot in SLOTS for tag in (f"B-{slot}", f"I-{slot}"))]
NAMES = ("embedding.weight", "encoder.weight_ih_l0", "encoder.weight_hh_l0", "encoder.bias_ih_l0", "encoder.bias_hh_l0",
         "encoder.weight_ih_l0_reverse", "encoder.weight_hh_l0_reverse", "encoder.bias_ih_l0_reverse", "encoder.bias_hh_l0_reverse", "classifier.weight", "classifier.bias")
PARITY_TEXTS = (
    "The garden in Bristol opens next Friday.",
    "ذكّرني بزيارة القاعة في حماة غدًا عند الخامسة.",
    "😀 A trip from Porto to Lyon next Tuesday.",
    "From Paris to Paris on Monday.",
    "موعد اللقاء يوم الأربعاء الساعة ١٤:٣٠ في طنطا.",
    "Read the science news about ocean currents tonight.",
    "A quiet morning in New York.",
    "لا تستخدم مدينة قديمة؛ المقصود هو فاس مساء الخميس.",
    "I paid GBP 18 for a blue notebook.",
    "İZMİR and Kelvin at 09:15",
    "Cafe\u0301 near Lodi\u00a0tomorrow.",
    "Room_42\u001cLondon\u0085Saturday.",
    "Before\ufeffRome and 𐐀 after Ⅻ ² ½.",
)


def sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def typed_canonical(value: Any) -> bytes:
    """Portable content addressing: JSON numeric syntax never changes the hash."""
    def visit(item):
        if item is None or isinstance(item, (str, bool)):
            return item
        if isinstance(item, (int, float)):
            if not math.isfinite(item):
                raise ValueError("nonfinite_canonical_number")
            return {"$f64": struct.pack(">d", float(item)).hex()}
        if isinstance(item, list):
            return [visit(child) for child in item]
        if isinstance(item, dict):
            return {key: visit(child) for key, child in item.items()}
        raise ValueError("unsupported_canonical_type")
    return json_bytes(visit(value))


def ranges(predicate) -> list[list[int]]:
    output = []
    start = None
    for codepoint in range(0x110000):
        matches = predicate(chr(codepoint))
        if matches and start is None:
            start = codepoint
        if not matches and start is not None:
            output.append([start, codepoint - 1])
            start = None
    if start is not None:
        output.append([start, 0x10FFFF])
    return output


def unicode_contract() -> dict[str, Any]:
    if unicodedata.unidata_version != "14.0.0":
        raise ValueError("unicode_version_requires_explicit_contract_revision")
    body = {"version": "14.0.0", "wordRanges": ranges(lambda char: char.isalnum() or char == "_"),
            "digitRanges": ranges(str.isdigit), "uppercaseRanges": ranges(str.isupper), "spaceRanges": ranges(str.isspace),
            "assignedRanges": ranges(lambda char: unicodedata.category(char) not in ("Cn", "Cs")),
            "lowercaseMap": [[codepoint, chr(codepoint).lower()] for codepoint in range(0x110000) if chr(codepoint).lower() != chr(codepoint)]}
    return {**body, "sha256": sha(typed_canonical(body))}


def expected_shapes(buckets: int, dim: int, hidden: int) -> dict[str, list[int]]:
    return {"embedding.weight": [buckets, dim], "encoder.weight_ih_l0": [3 * hidden, dim + 6], "encoder.weight_hh_l0": [3 * hidden, hidden],
            "encoder.bias_ih_l0": [3 * hidden], "encoder.bias_hh_l0": [3 * hidden],
            "encoder.weight_ih_l0_reverse": [3 * hidden, dim + 6], "encoder.weight_hh_l0_reverse": [3 * hidden, hidden],
            "encoder.bias_ih_l0_reverse": [3 * hidden], "encoder.bias_hh_l0_reverse": [3 * hidden],
            "classifier.weight": [len(TAGS), 2 * hidden], "classifier.bias": [len(TAGS)]}


def validate_layout(header: dict[str, Any], weights: bytes) -> None:
    if header.get("format") != "mohassan-slot-gru-v1" or header.get("tags") != TAGS or sha(weights) != header.get("sha256") or len(weights) > 4 * 1024 * 1024:
        raise ValueError("candidate_weight_identity")
    shapes = expected_shapes(header["config"]["buckets"], header["config"]["dim"], header["config"]["hidden"])
    if [item.get("name") for item in header["layout"]] != list(NAMES):
        raise ValueError("candidate_tensor_order")
    offset = 0
    for item in header["layout"]:
        if set(item) != {"name", "shape", "offsetBytes", "lengthBytes"} or item["shape"] != shapes[item["name"]] or item["offsetBytes"] != offset or item["lengthBytes"] != math.prod(item["shape"]) * 4:
            raise ValueError("candidate_tensor_shape")
        offset += item["lengthBytes"]
    if offset != len(weights):
        raise ValueError("candidate_tensor_total")
    values = np.frombuffer(weights, dtype="<f4")
    if not np.isfinite(values).all() or np.abs(values).max() > 64:
        raise ValueError("candidate_float_bounds")


def verify_candidate(candidate: Path = CANDIDATE) -> tuple[dict[str, Any], bytes, dict[str, Any], dict[str, Any]]:
    checksums = json.loads((candidate / "checksums.json").read_text(encoding="utf-8"))
    if not isinstance(checksums, dict) or len(checksums) > 32:
        raise ValueError("candidate_checksums_bounds")
    base = candidate.resolve()
    for name, expected in checksums.items():
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or name in (".", ".."):
            raise ValueError("candidate_checksum_path")
        path = (candidate / name).resolve()
        if path.parent != base or path.stat().st_size > 16 * 1024 * 1024:
            raise ValueError("candidate_artifact_bounds")
        if sha(path.read_bytes()) != expected:
            raise ValueError("candidate_checksum_mismatch")
    required = {"weights.bin", "model.json", "calibration.json", "manifest.json", "parity.json"}
    if not required.issubset(checksums):
        raise ValueError("candidate_checksums_incomplete")
    weights = (candidate / "weights.bin").read_bytes()
    header = json.loads((candidate / "model.json").read_text(encoding="utf-8"))
    calibration = json.loads((candidate / "calibration.json").read_text(encoding="utf-8"))
    manifest = json.loads((candidate / "manifest.json").read_text(encoding="utf-8"))
    validate_layout(header, weights)
    if set(calibration["thresholds"]) != set(SLOTS) or not 0 < calibration["temperature"] <= 100:
        raise ValueError("candidate_calibration")
    for label in ("date", "place"):
        if not math.isfinite(calibration["thresholds"][label]) or not 0 <= calibration["thresholds"][label] <= 1.000001:
            raise ValueError("candidate_calibration_bounds")
    return header, weights, calibration, manifest


def bundle_manifest(header: dict[str, Any], weights: bytes, calibration: dict[str, Any], unicode: dict[str, Any], source: dict[str, str]) -> dict[str, Any]:
    validate_layout(header, weights)
    dimensions = {key: header["config"][source_key] for key, source_key in (("buckets", "buckets"), ("embedding", "dim"), ("hidden", "hidden"))}
    body = {"format": FORMAT, "featureVersion": FEATURE_VERSION, "canonicalVersion": CANONICAL_VERSION, "dimensions": dimensions,
            "weights": {"dtype": "float32-le", "bytes": len(weights), "sha256": sha(weights), "maxAbsValue": 64,
                        "tensors": [{"name": item["name"], "shape": item["shape"], "offsetFloats": item["offsetBytes"] // 4, "count": item["lengthBytes"] // 4} for item in header["layout"]]},
            "labels": TAGS, "unicode": unicode,
            "calibration": {"temperature": calibration["temperature"], "thresholds": {label: calibration["thresholds"][label] for label in ("date", "place")},
                            "acceptedLabels": ["date", "place"], "abstainedLabels": ["time", "time_of_day", "time_zone", "news_topic"], "confidence": "minimum_predicted_tag_posterior"},
            "source": source, "limits": {"maxTextCodepoints": 512, "maxTokens": 80, "maxWeightBytes": 4 * 1024 * 1024}, "active": False}
    return {**body, "modelId": sha(typed_canonical(body))}


def tokenization(text: str) -> list[dict[str, Any]]:
    if not text.strip() or len(text) > 512 or any(unicodedata.category(char) in ("Cn", "Cs") for char in text):
        raise ValueError("unsupported_input")
    tokens = [{"text": match[0], "startCodepoint": match.start(), "endCodepoint": match.end(),
               "startUtf16": len(text[:match.start()].encode("utf-16-le")) // 2, "endUtf16": len(text[:match.end()].encode("utf-16-le")) // 2}
              for match in re.finditer(r"\w+|[^\w\s]", text, re.UNICODE)]
    if not 1 <= len(tokens) <= 80:
        raise ValueError("token_bounds")
    return tokens


def fold(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    text = re.sub(r"[\u0640\u064b-\u065f\u0670]", "", text)
    text = re.sub(r"[أإآٱ]", "ا", text).replace("ى", "ي").replace("ة", "ه")
    text = text.translate(str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789"))
    return re.sub(r"\s+", " ", text.lower()).strip()


def feature_ids(text: str, buckets: int) -> list[int]:
    marked = f"^{fold(text)}$"
    keys = [f"token:{marked}"]
    keys.extend(f"c{size}:{marked[index:index + size]}" for size in (2, 3, 4) for index in range(max(0, len(marked) - size + 1)))
    return [int(sha(key.encode())[:8], 16) % buckets for key in keys]


def flags(text: str) -> list[float]:
    return [float(any("\u0600" <= char <= "\u06ff" for char in text)), float(any("a" <= char.lower() <= "z" for char in text)),
            float(any(char.isdigit() for char in text)), float(any(char.isupper() for char in text)), float(all(not char.isalnum() for char in text)), min(len(text), 20) / 20]


def infer_logits(manifest: dict[str, Any], weights: bytes, text: str) -> tuple[list[dict[str, Any]], np.ndarray]:
    tokens = tokenization(text)
    arrays = {item["name"]: np.frombuffer(weights, dtype="<f4", count=item["count"], offset=item["offsetFloats"] * 4).reshape(item["shape"]) for item in manifest["weights"]["tensors"]}
    features = [np.concatenate((arrays["embedding.weight"][feature_ids(token["text"], manifest["dimensions"]["buckets"])].mean(0), np.asarray(flags(token["text"]), dtype=np.float32))) for token in tokens]
    hidden = manifest["dimensions"]["hidden"]
    def direction(reverse):
        suffix = "_reverse" if reverse else ""
        state = np.zeros(hidden, dtype=np.float32)
        output = [None] * len(tokens)
        for index in (range(len(tokens) - 1, -1, -1) if reverse else range(len(tokens))):
            incoming = arrays[f"encoder.weight_ih_l0{suffix}"] @ features[index] + arrays[f"encoder.bias_ih_l0{suffix}"]
            recurrent = arrays[f"encoder.weight_hh_l0{suffix}"] @ state + arrays[f"encoder.bias_hh_l0{suffix}"]
            reset = 1 / (1 + np.exp(-np.clip(incoming[:hidden] + recurrent[:hidden], -40, 40)))
            update = 1 / (1 + np.exp(-np.clip(incoming[hidden:2 * hidden] + recurrent[hidden:2 * hidden], -40, 40)))
            candidate = np.tanh(incoming[2 * hidden:] + reset * recurrent[2 * hidden:])
            state = (1 - update) * candidate + update * state
            output[index] = state.copy()
        return output
    forward, reverse = direction(False), direction(True)
    encoded = np.stack([np.concatenate((left, right)) for left, right in zip(forward, reverse)])
    return tokens, encoded @ arrays["classifier.weight"].T + arrays["classifier.bias"]


def decode(logits: np.ndarray) -> list[int]:
    transition = np.zeros((len(TAGS), len(TAGS)), dtype=np.float64)
    for current, tag in enumerate(TAGS):
        if tag.startswith("I-"):
            transition[:, current] = -np.inf
            transition[TAGS.index(f"B-{tag[2:]}"), current] = 0
            transition[current, current] = 0
    state = logits[0].astype(np.float64).copy()
    state[[index for index, tag in enumerate(TAGS) if tag.startswith("I-")]] = -np.inf
    back = []
    for emission in logits[1:]:
        choices = state[:, None] + transition
        previous = choices.argmax(0)
        state = choices[previous, np.arange(len(TAGS))] + emission
        back.append(previous)
    path = [int(state.argmax())]
    for previous in reversed(back):
        path.append(int(previous[path[-1]]))
    return list(reversed(path))


def prediction(manifest: dict[str, Any], weights: bytes, text: str) -> dict[str, Any]:
    tokens, logits = infer_logits(manifest, weights, text)
    tags = decode(logits)
    scaled = logits.astype(np.float64) / manifest["calibration"]["temperature"]
    probabilities = np.exp(scaled - scaled.max(1, keepdims=True))
    probabilities /= probabilities.sum(1, keepdims=True)
    raw, hypotheses = [], []
    index = 0
    while index < len(tags):
        tag = TAGS[tags[index]]
        if tag == "O":
            index += 1
            continue
        start = index
        label = tag[2:]
        index += 1
        while index < len(tags) and TAGS[tags[index]] == f"I-{label}":
            index += 1
        confidence = min(float(probabilities[position, tags[position]]) for position in range(start, index))
        first, last = tokens[start], tokens[index - 1]
        literal = text[first["startCodepoint"]:last["endCodepoint"]]
        threshold = manifest["calibration"]["thresholds"].get(label)
        reason = "label_abstained" if threshold is None or threshold > 1 else "accepted" if confidence >= threshold else "below_threshold"
        span = {"label": label, "text": literal, "startCodepoint": first["startCodepoint"], "endCodepoint": last["endCodepoint"],
                "startUtf16": first["startUtf16"], "endUtf16": last["endUtf16"], "confidence": confidence, "reason": reason}
        raw.append(span)
        if reason == "accepted":
            hypotheses.append({**{key: value for key, value in span.items() if key != "reason"}, "kind": "hypothesis", "threshold": threshold})
    return {"tokens": tokens, "featureIds": [feature_ids(token["text"], manifest["dimensions"]["buckets"]) for token in tokens],
            "flags": [flags(token["text"]) for token in tokens], "logits": logits.tolist(), "tags": tags, "raw": raw, "hypotheses": hypotheses}


def write_exclusive(path: Path, payload: bytes) -> str:
    with path.open("xb") as handle:
        handle.write(payload)
    return sha(payload)


def write_bundle(directory: Path, manifest: dict[str, Any], weights: bytes, texts=PARITY_TEXTS, provenance: dict[str, Any] | None = None, source_code: bytes | None = None) -> dict[str, str]:
    directory.mkdir(parents=True, exist_ok=False)
    sums = {"manifest.json": write_exclusive(directory / "manifest.json", json_bytes(manifest)), "weights.bin": write_exclusive(directory / "weights.bin", weights)}
    parity = {"modelId": manifest["modelId"], "source": "new independent synthetic strings; no training or accuracy labels", "cases": [{"text": text, **prediction(manifest, weights, text)} for text in texts]}
    sums["parity.json"] = write_exclusive(directory / "parity.json", json_bytes(parity))
    if provenance is not None:
        sums["provenance.json"] = write_exclusive(directory / "provenance.json", json_bytes(provenance))
    if source_code is not None:
        sums["source-export_slots_ts.py"] = write_exclusive(directory / "source-export_slots_ts.py", source_code)
    write_exclusive(directory / "checksums.json", json_bytes(sums))
    return sums


def tiny_fixture(unicode: dict[str, Any]) -> tuple[dict[str, Any], bytes]:
    rng = np.random.default_rng(71)
    dimensions = (128, 8, 4)
    tensors, chunks, offset = [], [], 0
    for name, shape in expected_shapes(*dimensions).items():
        array = rng.normal(0, 0.15, shape).astype("<f4")
        if name == "classifier.bias":
            array[:] = -1
            array[TAGS.index("B-date")] = 2
            array[TAGS.index("I-date")] = 1.8
        payload = array.tobytes()
        tensors.append({"name": name, "shape": shape, "offsetBytes": offset, "lengthBytes": len(payload)})
        chunks.append(payload)
        offset += len(payload)
    weights = b"".join(chunks)
    header = {"format": "mohassan-slot-gru-v1", "tags": TAGS, "sha256": sha(weights), "layout": tensors,
              "config": {"buckets": dimensions[0], "dim": dimensions[1], "hidden": dimensions[2]}}
    calibration = {"temperature": 1.0, "thresholds": {"date": 0.1, "place": 0.9}}
    source = {"candidate": "unit-fixture-untrained", "manifestSha256": "0" * 64, "weightsSha256": sha(weights), "calibrationSha256": "0" * 64,
              "assignmentHash": "0" * 64}
    return bundle_manifest(header, weights, calibration, unicode, source), weights


def verify_source_parity(manifest: dict[str, Any], weights: bytes, cases: list[dict[str, Any]]) -> float:
    maximum = 0.0
    if not cases or len(cases) > 32:
        raise ValueError("source_parity_bounds")
    for case in cases:
        _tokens, actual = infer_logits(manifest, weights, case["text"])
        expected = np.asarray(case["logits"], dtype=np.float32)
        if expected.shape != actual.shape or not np.allclose(expected, actual, rtol=1e-5, atol=1e-5):
            raise ValueError("frozen_candidate_parity_mismatch")
        maximum = max(maximum, float(np.max(np.abs(actual - expected))))
    return maximum


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-name", default="typescript-export-v1-20261121-a")
    parser.add_argument("--write-test-fixture", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", args.run_name):
        raise ValueError("invalid_export_name")
    header, weights, calibration, candidate_manifest = verify_candidate()
    unicode = unicode_contract()
    source = {"candidate": CANDIDATE.name, "manifestSha256": sha((CANDIDATE / "manifest.json").read_bytes()), "weightsSha256": sha(weights),
              "calibrationSha256": sha((CANDIDATE / "calibration.json").read_bytes()), "assignmentHash": candidate_manifest["assignmentHash"]}
    manifest = bundle_manifest(header, weights, calibration, unicode, source)
    source_parity = json.loads((CANDIDATE / "parity.json").read_text(encoding="utf-8"))
    maximum_error = verify_source_parity(manifest, weights, source_parity)
    target = OUTPUT / args.run_name
    if target.resolve().parent != OUTPUT.resolve():
        raise ValueError("export_path_escape")
    source_code = Path(__file__).read_bytes()
    provenance = {"derivedWithoutRetraining": True, "thresholdsRefit": False, "source": source,
                  "sourceParityMaximumLogitError": maximum_error, "exportScriptSha256": sha(source_code),
                  "python": sys.version.split()[0], "numpy": np.__version__, "unicode": unicodedata.unidata_version, "active": False}
    sums = write_bundle(target, manifest, weights, provenance=provenance, source_code=source_code)
    if args.write_test_fixture:
        fixture_manifest, fixture_weights = tiny_fixture(unicode)
        write_bundle(FIXTURE, fixture_manifest, fixture_weights)
    print(json.dumps({"directory": str(target.relative_to(ROOT)), "modelId": manifest["modelId"], "weightsBytes": len(weights),
                      "manifestBytes": len(json_bytes(manifest)), "unicodeSha256": unicode["sha256"], "files": len(sums) + 1, "active": False}), flush=True)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    main()
