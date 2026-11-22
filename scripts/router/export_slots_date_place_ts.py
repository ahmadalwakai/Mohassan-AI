"""Export the already-selected inactive five-tag date/place model; no training or selection.

Only immutable selected artifacts, their cached DEV parity inputs, and the old
exporter's predeclared Unicode parity strings are read. No test cache, owner data,
dataset, provider or network is used. Original weights and thresholds stay exact.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "artifacts/brain-slot-date-place-development-v2/first-three-cpu-20261121-b"
OUTPUT = ROOT / "artifacts/brain-slot-date-place-typescript-v1"
FORMAT = "mohassan-slot-date-place-tagger-ts-v1"
TAGS = ("O", "B-place", "I-place", "B-date", "I-date")
ASSIGNMENT = "33289c6b14a6611535e081c31cb250ee74611cc7303c38f2b660aebd1bde1642"
PINS = {"selection.json": "01adfe04552a4d8543fe042b7fd2c0a6ecf94b7ae35f6f1444058244983423b8",
        "plan.json": "fa9995e24b42ba80993efcfa4ad67618b2268403fc3cbe286c97be90120ff029",
        "target48-cap3/weights.bin": "3b1e0c3a6ec1e4a9f5057aad3358271e592850084e9e23e05fe1828717267e64",
        "target48-cap3/model.json": "13af8ceb3f563e668fbdcd947304ac36a6e4614a8619c201eddb82e153b1d7c8",
        "target48-cap3/calibration.json": "3f7cf51f40882e89ea97c49ab8f299fda9e63aaf9b56554e565e13573ae1e8d6",
        "target48-cap3/selection-report.json": "3da25e603caa2bf0ec3a13e7045ef071fbd9d4d1ed548feac261e69efa3dc36e",
        "target48-cap3/parity.json": "f60406d84e3b761362431613b0fb582d16eb826dc70a51646ab737c7b3817511"}
_shared = None


def shared():
    global _shared
    if _shared is None:
        spec = importlib.util.spec_from_file_location("unchanged_slot_export_contract", Path(__file__).with_name("export_slots_ts.py"))
        _shared = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_shared)
    return _shared


def sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def read_json(path: Path, maximum=1024 * 1024):
    if path.stat().st_size > maximum:
        raise ValueError("source_json_bound")
    return json.loads(path.read_text(encoding="utf-8"))


def expected_shapes(buckets: int, dim: int, hidden: int):
    shapes = shared().expected_shapes(buckets, dim, hidden)
    return {**shapes, "classifier.weight": [5, 2 * hidden], "classifier.bias": [5]}


def validate_layout(header: dict[str, Any], weights: bytes) -> None:
    if header.get("format") != "mohassan-slot-date-place-gru-v2" or header.get("tags") != list(TAGS) or header.get("active") is not False \
            or header.get("dtype") != "float32-little-endian" or header.get("targetLabels") != ["place", "date"] \
            or header.get("assignmentHash") != ASSIGNMENT or not 0 < len(weights) <= 4 * 1024 * 1024 or len(weights) % 4 or sha(weights) != header.get("sha256"):
        raise ValueError("five_tag_weight_identity")
    config = header.get("config", {})
    buckets, dim, hidden = (config.get(key) for key in ("buckets", "dim", "hidden"))
    if any(type(value) is not int for value in (buckets, dim, hidden)) or not 128 <= buckets <= 65536 or buckets & (buckets - 1) \
            or not 4 <= dim <= 32 or not 4 <= hidden <= 64:
        raise ValueError("five_tag_dimensions")
    shapes, layout = expected_shapes(buckets, dim, hidden), header.get("layout")
    if not isinstance(layout, list) or len(layout) != len(shapes) or [item.get("name") for item in layout] != list(shared().NAMES):
        raise ValueError("five_tag_tensor_order")
    offset = 0
    for item in layout:
        if set(item) != {"name", "shape", "offsetBytes", "lengthBytes"} or item["shape"] != shapes[item["name"]] \
                or type(item["offsetBytes"]) is not int or type(item["lengthBytes"]) is not int \
                or item["offsetBytes"] != offset or item["lengthBytes"] != math.prod(item["shape"]) * 4:
            raise ValueError("five_tag_tensor_shape")
        offset += item["lengthBytes"]
    if offset != len(weights):
        raise ValueError("five_tag_tensor_total")
    values = np.frombuffer(weights, dtype="<f4")
    if not np.isfinite(values).all() or np.abs(values).max(initial=0) > 64:
        raise ValueError("five_tag_float_bounds")


def verified_source(directory: Path = SOURCE):
    base = directory.resolve(strict=True)
    for name, expected in PINS.items():
        path = (base / name).resolve(strict=True)
        if base not in path.parents or path.stat().st_size > 4 * 1024 * 1024 or sha(path.read_bytes()) != expected:
            raise ValueError("selected_source_changed")
    selection, plan = read_json(base / "selection.json"), read_json(base / "plan.json")
    if selection.get("active") is not False or selection.get("candidateId") != "target48-cap3" or selection.get("testUsedForSelection") is not False \
            or selection.get("assignmentHash") != ASSIGNMENT or plan.get("assignmentHash") != ASSIGNMENT:
        raise ValueError("frozen_selection_identity")
    selected = base / selection["candidateId"]
    for field, name in (("weightsSha256", "weights.bin"), ("calibrationSha256", "calibration.json"), ("modelSha256", "model.json"),
                        ("selectionReportSha256", "selection-report.json")):
        if selection.get(field) != PINS[f"target48-cap3/{name}"]:
            raise ValueError("selection_candidate_binding")
    if selection.get("planSha256") != PINS["plan.json"]:
        raise ValueError("selection_plan_binding")
    header, weights = read_json(selected / "model.json"), (selected / "weights.bin").read_bytes()
    validate_layout(header, weights)
    calibration = read_json(selected / "calibration.json")
    if calibration.get("active") is not False or calibration.get("partition") != "calibration" or set(calibration.get("thresholds", {})) != {"date", "place"} \
            or type(calibration.get("temperature")) not in (int, float) or not math.isfinite(calibration["temperature"]) or not 0 < calibration["temperature"] <= 100:
        raise ValueError("five_tag_calibration")
    if any(type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1.000001 for value in calibration["thresholds"].values()):
        raise ValueError("five_tag_calibration")
    cached = read_json(selected / "parity.json")
    if not isinstance(cached, list) or len(cached) != 12:
        raise ValueError("frozen_dev_parity_count")
    return header, weights, calibration, cached


def bundle_manifest(header, weights, calibration):
    validate_layout(header, weights)
    source = {"format": header["format"], "run": SOURCE.name, "candidate": "target48-cap3", "selectionSha256": PINS["selection.json"],
              "planSha256": PINS["plan.json"], "modelSha256": PINS["target48-cap3/model.json"], "weightsSha256": sha(weights),
              "calibrationSha256": PINS["target48-cap3/calibration.json"], "selectionReportSha256": PINS["target48-cap3/selection-report.json"],
              "paritySha256": PINS["target48-cap3/parity.json"], "assignmentHash": ASSIGNMENT}
    body = {"format": FORMAT, "featureVersion": shared().FEATURE_VERSION, "canonicalVersion": shared().CANONICAL_VERSION, "active": False,
            "dimensions": {"buckets": header["config"]["buckets"], "embedding": header["config"]["dim"], "hidden": header["config"]["hidden"]},
            "weights": {"dtype": "float32-le", "bytes": len(weights), "sha256": sha(weights), "maxAbsValue": 64,
                        "tensors": [{"name": item["name"], "shape": item["shape"], "offsetFloats": item["offsetBytes"] // 4, "count": item["lengthBytes"] // 4} for item in header["layout"]]},
            "labels": list(TAGS), "unicode": shared().unicode_contract(),
            "calibration": {"temperature": calibration["temperature"], "thresholds": calibration["thresholds"], "acceptedLabels": ["date", "place"],
                            "abstainedLabels": [], "confidence": "minimum_predicted_tag_posterior"},
            "source": source, "limits": {"maxTextCodepoints": 512, "maxTokens": 80, "maxWeightBytes": 4 * 1024 * 1024}}
    return {**body, "modelId": sha(shared().typed_canonical(body))}


def torch_model(header, weights):
    import torch
    import torch.nn as nn
    torch.set_num_threads(1)
    config = header["config"]
    class FrozenReference(nn.Module):
        def __init__(self):
            super().__init__()
            self.embedding = nn.EmbeddingBag(config["buckets"], config["dim"], mode="mean")
            self.encoder = nn.GRU(config["dim"] + 6, config["hidden"], batch_first=True, bidirectional=True)
            self.classifier = nn.Linear(config["hidden"] * 2, 5)

        def forward(self, tokens):
            features = [shared().feature_ids(token["text"], config["buckets"]) for token in tokens]
            offsets, ids = [], []
            for item in features:
                offsets.append(len(ids)); ids.extend(item)
            embedded = self.embedding(torch.tensor(ids, dtype=torch.int64), torch.tensor(offsets, dtype=torch.int64))
            flags = torch.tensor([shared().flags(token["text"]) for token in tokens], dtype=torch.float32)
            encoded, _ = self.encoder(torch.cat((embedded, flags), dim=1).unsqueeze(0))
            return self.classifier(encoded.squeeze(0))
    model = FrozenReference().to(device="cpu", dtype=torch.float32)
    parameters = {item["name"]: torch.from_numpy(np.frombuffer(weights, dtype="<f4", count=item["lengthBytes"] // 4,
                  offset=item["offsetBytes"]).reshape(item["shape"]).copy()) for item in header["layout"]}
    model.load_state_dict(parameters, strict=True); model.eval()
    return model


def decode(logits):
    import torch
    emissions = logits.to(dtype=torch.float64)
    transition = torch.zeros((5, 5), dtype=torch.float64)
    for current in (2, 4):
        transition[:, current] = -torch.inf; transition[current - 1, current] = 0; transition[current, current] = 0
    state = emissions[0].clone(); state[[2, 4]] = -torch.inf
    back = []
    for emission in emissions[1:]:
        values, previous = torch.max(state[:, None] + transition, dim=0)
        state = values + emission; back.append(previous)
    path = [int(state.argmax())]
    for previous in reversed(back):
        path.append(int(previous[path[-1]]))
    return list(reversed(path))


def prediction(model, manifest, weights, text):
    import torch
    tokens = shared().tokenization(text)
    with torch.inference_mode():
        logits = model(tokens)
    if tuple(logits.shape) != (len(tokens), 5) or not bool(torch.isfinite(logits).all()):
        raise ValueError("reference_logits_invalid")
    _, independent = shared().infer_logits(manifest, weights, text)
    error = float(np.abs(independent - logits.numpy()).max(initial=0))
    if not np.allclose(independent, logits.numpy(), rtol=1e-5, atol=1e-5):
        raise ValueError("independent_numpy_parity")
    tags = decode(logits)
    probabilities = torch.softmax(logits.to(dtype=torch.float64) / manifest["calibration"]["temperature"], dim=1)
    raw, hypotheses, index = [], [], 0
    while index < len(tags):
        tag = TAGS[tags[index]]
        if tag == "O":
            index += 1; continue
        if not tag.startswith("B-"):
            raise ValueError("reference_illegal_bio")
        label, start = tag[2:], index
        index += 1
        while index < len(tags) and TAGS[tags[index]] == f"I-{label}":
            index += 1
        confidence = min(float(probabilities[position, tags[position]]) for position in range(start, index))
        first, last = tokens[start], tokens[index - 1]
        threshold = manifest["calibration"]["thresholds"][label]
        reason = "label_abstained" if threshold > 1 else "accepted" if confidence >= threshold else "below_threshold"
        span = {"label": label, "text": text[first["startCodepoint"]:last["endCodepoint"]], "startCodepoint": first["startCodepoint"], "endCodepoint": last["endCodepoint"],
                "startUtf16": first["startUtf16"], "endUtf16": last["endUtf16"], "confidence": confidence}
        raw.append({**span, "reason": reason})
        if reason == "accepted":
            hypotheses.append({**span, "kind": "hypothesis", "threshold": threshold})
    return {"tokens": tokens, "featureIds": [shared().feature_ids(item["text"], manifest["dimensions"]["buckets"]) for item in tokens],
            "flags": [shared().flags(item["text"]) for item in tokens], "logits": logits.tolist(), "tags": tags, "raw": raw, "hypotheses": hypotheses}, error


def export(run_name="typescript-export-v1-20261121-a"):
    import torch
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", run_name):
        raise ValueError("invalid_export_name")
    header, weights, calibration, cached = verified_source()
    manifest = bundle_manifest(header, weights, calibration)
    model, cases, cached_maximum, numpy_maximum = torch_model(header, weights), [], 0.0, 0.0
    for group, inputs in (("frozen_public_dev_parity", cached), ("predeclared_unicode_parity_only", [{"text": item} for item in shared().PARITY_TEXTS])):
        for item in inputs:
            actual, error = prediction(model, manifest, weights, item["text"])
            numpy_maximum = max(numpy_maximum, error)
            if group == "frozen_public_dev_parity":
                expected = np.asarray(item["logits"], dtype=np.float32); observed = np.asarray(actual["logits"], dtype=np.float32)
                if expected.shape != observed.shape or not np.allclose(expected, observed, rtol=1e-5, atol=1e-5):
                    raise ValueError("cached_pytorch_parity_changed")
                cached_maximum = max(cached_maximum, float(np.abs(expected - observed).max(initial=0)))
            cases.append({"source": group, "text": item["text"], **actual})
    # Recheck immutable inputs before writing any derivative artifact.
    verified_source()
    target = OUTPUT / run_name
    if target.resolve().parent != OUTPUT.resolve():
        raise ValueError("export_path_escape")
    parity = {"modelId": manifest["modelId"], "reference": "actual CPU PyTorch raw float32 inference; no accuracy labels or selection", "cases": cases}
    provenance = {"active": False, "derivedWithoutRetraining": True, "thresholdsRefit": False, "testCacheRead": False, "ownerDataUsed": False,
                  "reference": "PyTorch CPU", "torch": torch.__version__, "numpy": np.__version__, "python": sys.version.split()[0],
                  "cachedPytorchMaximumLogitError": cached_maximum, "independentNumpyMaximumLogitError": numpy_maximum,
                  "sourcePins": PINS, "exportScriptSha256": sha(Path(__file__).read_bytes()),
                  "bridgeSha256": sha((ROOT / "apps/server/src/assistant/slot-date-place-tagger.ts").read_bytes()),
                  "sharedMathSha256": sha((ROOT / "apps/server/src/assistant/slot-tagger-math.ts").read_bytes()),
                  "scope": "inactive date/place model parity only; not general intelligence or task success"}
    target.mkdir(parents=True, exist_ok=False)
    sums = {}
    for name, payload in (("manifest.json", shared().json_bytes(manifest)), ("weights.bin", weights), ("parity.json", shared().json_bytes(parity)),
                          ("provenance.json", shared().json_bytes(provenance)), ("source-export_slots_date_place_ts.py", Path(__file__).read_bytes())):
        sums[name] = shared().write_exclusive(target / name, payload)
    shared().write_exclusive(target / "checksums.json", shared().json_bytes(sums))
    return {"directory": str(target.relative_to(ROOT)).replace("\\", "/"), "modelId": manifest["modelId"], "active": False,
            "weightsBytes": len(weights), "manifestBytes": len(shared().json_bytes(manifest)), "parityCases": len(cases),
            "cachedPytorchMaximumLogitError": cached_maximum, "independentNumpyMaximumLogitError": numpy_maximum}


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-name", default="typescript-export-v1-20261121-a")
    print(json.dumps(export(parser.parse_args().run_name)), flush=True)
