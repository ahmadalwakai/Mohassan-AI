"""Inactive date/place-only OWN CPU experiment; frozen public groups, no test selection.

Only local public MASSIVE annotations and the frozen first slot manifest are inputs.
No app activation, provider, owner data, assessment fixture, or old router trainer.
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import importlib.util
import json
import math
import os
import random
import re
import subprocess
import sys
import sysconfig
import threading
import time
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
BASELINE = ROOT / "artifacts/brain-slot-development-v1/first-cpu-20261121-a"
OUTPUT = ROOT / "artifacts/brain-slot-date-place-development-v2"
PUBLIC = ROOT / ".data/router/download/1.1/data"
ASSIGNMENT = "33289c6b14a6611535e081c31cb250ee74611cc7303c38f2b660aebd1bde1642"
BASE_MANIFEST = "0799b91a848d1396f89478f56dfc86eb9e33cef700ca61b3d2dd7c72d2e6a50f"
FORMAT = "mohassan-slot-date-place-gru-v2"
TARGETS = ("place", "date")
TAGS = ("O", "B-place", "I-place", "B-date", "I-date")
PARTS = ("train", "dev", "calibration", "test")
TOTAL_SECONDS, CANDIDATE_SECONDS, TRAIN_SECONDS, MEMORY_MIB = 600, 150, 120, 2048
_base = None
_active_child = None


def sha(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def js(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def write(path: Path, value: Any, raw=False) -> str:
    payload = value if raw else js(value)
    with path.open("xb") as handle:
        handle.write(payload)
    return sha(payload)


def read_json(path: Path, maximum=8 * 1024 * 1024) -> Any:
    if path.stat().st_size > maximum:
        raise ValueError("artifact_size_bound")
    return json.loads(path.read_text(encoding="utf-8"))


def base_api():
    global _base
    if _base is None:
        spec = importlib.util.spec_from_file_location("frozen_public_slot_helpers_v2", Path(__file__).with_name("train_slots.py"))
        _base = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = _base
        spec.loader.exec_module(_base)
    return _base


@dataclass(frozen=True)
class Candidate:
    id: str
    hidden: int
    weight_cap: float | None
    seed: int = 53
    epochs: int = 5


CANDIDATES = (Candidate("target32-cap3", 32, 3.0), Candidate("target48-cap3", 48, 3.0), Candidate("target48-uniform", 48, None))


def checked_candidate(identity: str) -> Candidate:
    for candidate in CANDIDATES:
        if identity == candidate.id:
            return candidate
    raise ValueError("unknown_predeclared_candidate")


def frozen_manifest() -> dict[str, Any]:
    manifest_path = BASELINE / "manifest.json"
    if sha(manifest_path.read_bytes()) != BASE_MANIFEST:
        raise ValueError("frozen_manifest_changed")
    manifest = read_json(manifest_path)
    if manifest["assignmentHash"] != ASSIGNMENT or sha(js(manifest["assignments"])) != ASSIGNMENT or len(manifest["assignments"]) != 13302:
        raise ValueError("frozen_assignment_changed")
    source = Path(__file__).with_name("train_slots.py")
    expected = next(item["sha256"] for item in manifest["implementation"] if item["artifact"] == "source-train_slots.py")
    if sha(source.read_bytes()) != expected:
        raise ValueError("frozen_helper_source_changed")
    return manifest


def project_row(row):
    base = base_api()
    spans = tuple(span for span in row.spans if span.label in TARGETS)
    projected = replace(row, spans=spans, tags=base.spans_to_bio(row.text, row.tokens, spans))
    projected.validate()
    if any(tag >= len(TAGS) for tag in projected.tags):
        raise ValueError("target_tag_projection")
    return projected


def load_partition_rows(manifest: dict[str, Any], partitions: tuple[str, ...], directory: Path = PUBLIC) -> dict[str, list[Any]]:
    if not partitions or any(part not in PARTS for part in partitions) or len(set(partitions)) != len(partitions):
        raise ValueError("partition_request")
    base = base_api()
    assignments = {item["rowHash"]: item for item in manifest["assignments"]}
    if len(assignments) != len(manifest["assignments"]):
        raise ValueError("duplicate_assignment")
    selected = {key: value for key, value in assignments.items() if value["partition"] in partitions}
    result = {part: [] for part in partitions}
    found: set[str] = set()
    input_hashes = {item["path"].replace("\\", "/").rsplit("/", 1)[-1]: item["sha256"] for item in manifest["inputs"]}
    for locale in ("ar-SA", "en-US"):
        path = directory / f"{locale}.jsonl"
        if path.stat().st_size > base.MAX_SOURCE_BYTES or sha(path.read_bytes()) != input_hashes[path.name]:
            raise ValueError("public_input_changed")
        with path.open("rb") as handle:
            for line in handle:
                if len(line) > base.MAX_LINE_BYTES:
                    raise ValueError("public_line_bound")
                # Integrity hashing touches all raw bytes. Test utterances/labels
                # are not parsed for training/selection; use the public split key.
                hint = re.search(rb'(?<!\\)"partition"\s*:\s*"(train|dev|test)"', line)
                if not hint:
                    raise ValueError("public_partition_key")
                original_part = hint[1].decode("ascii")
                if original_part == "test" and "test" not in partitions or original_part != "test" and partitions == ("test",):
                    continue
                item = json.loads(line)
                if item["locale"] != locale or item["partition"] != original_part:
                    raise ValueError("public_identity")
                identity = str(item["id"])
                group, row_id = f"massive:{identity}", f"massive:{identity}:{locale}"
                key = base.sha(row_id)
                target = selected.get(key)
                if target is None:
                    continue
                if key in found or target["locale"] != locale or target["groupHash"] != base.sha(group):
                    raise ValueError("public_group_mismatch")
                if original_part == "train" and target["partition"] != "train" or original_part == "test" and target["partition"] != "test" \
                        or original_part == "dev" and target["partition"] not in ("dev", "calibration"):
                    raise ValueError("official_partition_changed")
                text, annotation, intent = item["utt"], item["annot_utt"], item["intent"]
                tokens = base.tokenize(text)
                spans = base.align_annotation(text, annotation, intent)
                if target["textHash"] != base.sha(text) or target["canonicalHash"] != base.sha(base.canonical(text)) \
                        or target["annotationHash"] != sha(js([asdict(span) for span in spans])):
                    raise ValueError("frozen_row_changed")
                original = base.SlotRow(row_id, group, text, locale, target["partition"], intent, tokens, spans, base.spans_to_bio(text, tokens, spans))
                result[target["partition"]].append(project_row(original))
                found.add(key)
    if found != set(selected):
        raise ValueError("frozen_rows_missing")
    for rows in result.values():
        rows.sort(key=lambda row: row.id)
    base.assert_splits(result)
    return result


def class_weights(rows: list[Any], candidate: Candidate) -> list[float]:
    if not rows or any(row.partition != "train" for row in rows):
        raise ValueError("weights_train_only")
    counts = Counter(tag for row in rows for tag in row.tags)
    if any(tag not in range(len(TAGS)) for tag in counts):
        raise ValueError("weights_target_tags")
    return [1.0] * len(TAGS) if candidate.weight_cap is None else [min(candidate.weight_cap, math.sqrt(counts[0] / max(1, counts[tag]))) for tag in range(len(TAGS))]


def config_for(candidate: Candidate):
    return base_api().SlotConfig(seed=candidate.seed, hidden=candidate.hidden, epochs=candidate.epochs, threads=4, max_seconds=TRAIN_SECONDS,
                                 target_precision=.90, min_calibration_spans=20)


def model_for(config):
    import torch.nn as nn
    from torch.nn.utils.rnn import pack_padded_sequence, pad_packed_sequence, pad_sequence
    import torch
    class TargetGRU(nn.Module):
        def __init__(self):
            super().__init__()
            self.embedding = nn.EmbeddingBag(config.buckets, config.dim, mode="mean")
            self.encoder = nn.GRU(config.dim + 6, config.hidden, batch_first=True, bidirectional=True)
            self.classifier = nn.Linear(config.hidden * 2, len(TAGS))

        def forward(self, ids, offsets, flags, lengths):
            sequences = torch.split(self.embedding(ids, offsets), lengths.tolist())
            padded = torch.cat((pad_sequence(sequences, batch_first=True), flags), dim=2)
            packed = pack_padded_sequence(padded, lengths.cpu(), batch_first=True, enforce_sorted=False)
            encoded, _ = pad_packed_sequence(self.encoder(packed)[0], batch_first=True, total_length=flags.shape[1])
            return self.classifier(encoded)
    return TargetGRU()


def expanded(logits: list[Any]) -> list[Any]:
    import numpy as np
    output = []
    for values in logits:
        if values.ndim != 2 or values.shape[1] != len(TAGS) or not np.isfinite(values).all() or np.abs(values).max(initial=0) > 1000:
            raise ValueError("target_logits_invalid")
        # Read-only reuse of the existing exact-span metric/decoder helper. Extra
        # six-label tags receive impossible emissions; no frozen globals change.
        output.append(np.pad(values, ((0, 0), (0, len(base_api().TAGS) - len(TAGS))), constant_values=-10000))
    return output


def metrics(rows, logits, temperature=1.0, thresholds=None):
    result = base_api().metrics(rows, expanded(logits), temperature, thresholds)
    result["perSlot"] = {label: result["perSlot"][label] for label in TARGETS}
    result["perSlotLocale"] = {key: value for key, value in result["perSlotLocale"].items() if key.split(":", 1)[1] in TARGETS}
    result["targetLabels"] = list(TARGETS)
    return result


def brief(value):
    return {key: item for key, item in value.items() if key != "predictions"}


def macro_f1(report):
    return sum(report["perSlot"][label]["exactSpanF1"] for label in TARGETS) / len(TARGETS)


def selection_key(report):
    thresholds = report["calibration"]["thresholds"]
    supported = sum(thresholds[label] <= 1 for label in TARGETS)
    recall = sum(report["calibrationSelective"]["perSlot"][label]["recall"] or 0 for label in TARGETS) / len(TARGETS)
    return (supported, recall, report["developmentMacroF1"], -report["training"]["parameters"], report["candidate"]["id"])


def select_candidate(reports):
    if not reports:
        raise ValueError("no_completed_candidates")
    if len({report["candidate"]["id"] for report in reports}) != len(reports):
        raise ValueError("duplicate_candidate_report")
    return max(reports, key=selection_key)


def train_model(splits, candidate):
    import torch
    import torch.nn.functional as functional
    base, config = base_api(), config_for(candidate)
    if set(splits) != {"train", "dev", "calibration"}:
        raise ValueError("training_partitions_only")
    torch.set_num_threads(4)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass
    torch.use_deterministic_algorithms(True)
    torch.manual_seed(candidate.seed)
    model = model_for(config)
    optimizer = torch.optim.Adagrad(model.parameters(), lr=config.learning_rate)
    weights = torch.tensor(class_weights(splits["train"], candidate))
    rows = list(splits["train"])
    rng = random.Random(candidate.seed)
    history, best, best_score, peak = [], None, -1.0, base.memory_mb()
    start = time.monotonic()
    for epoch in range(candidate.epochs):
        model.train(); rng.shuffle(rows)
        processed = 0
        for index in range(0, len(rows), config.batch_size):
            if time.monotonic() - start >= TRAIN_SECONDS:
                break
            peak = max(peak, base.memory_mb())
            if peak > MEMORY_MIB:
                raise RuntimeError("observed_memory_target_exceeded")
            chunk = rows[index:index + config.batch_size]
            inputs, labels = base.batch(chunk, config)
            loss = functional.cross_entropy(model(*inputs).reshape(-1, len(TAGS)), labels.reshape(-1), weight=weights, ignore_index=-100)
            optimizer.zero_grad(set_to_none=True); loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5)
            optimizer.step(); processed += len(chunk)
        if not processed:
            break
        development = metrics(splits["dev"], base.sequence_logits(model, splits["dev"], config))
        score = macro_f1(development)
        history.append({"epoch": epoch + 1, "processedRows": processed, "fullEpoch": processed == len(rows), "developmentMacroF1": score})
        if score > best_score:
            best_score = score
            best = {name: tensor.detach().clone() for name, tensor in model.state_dict().items()}
            best_epoch = epoch + 1
        print(json.dumps({"candidate": candidate.id, **history[-1]}), flush=True)
        if time.monotonic() - start >= TRAIN_SECONDS:
            break
    if best is None:
        raise RuntimeError("no_checkpoint_within_budget")
    model.load_state_dict(best)
    return model, {"history": history, "bestEpoch": best_epoch, "seconds": time.monotonic() - start,
                   "trainingLimitSeconds": TRAIN_SECONDS, "epochsRequested": candidate.epochs, "epochsObserved": len(history),
                   "timeLimitReached": time.monotonic() - start >= TRAIN_SECONDS, "memoryObservedPeakMiB": max(peak, base.memory_mb()),
                   "parameters": sum(tensor.numel() for tensor in model.parameters()), "classWeights": weights.tolist()}


def export_model(model, config):
    layout, chunks, offset = [], [], 0
    for name, tensor in model.state_dict().items():
        array = tensor.detach().numpy().astype("<f4")
        payload = array.tobytes(); chunks.append(payload)
        layout.append({"name": name, "shape": list(array.shape), "offsetBytes": offset, "lengthBytes": len(payload)})
        offset += len(payload)
    payload = b"".join(chunks)
    return {"format": FORMAT, "active": False, "tags": list(TAGS), "targetLabels": list(TARGETS), "config": asdict(config),
            "assignmentHash": ASSIGNMENT, "sha256": sha(payload), "dtype": "float32-little-endian", "layout": layout,
            "offsetContract": "exact original codepoint and UTF16 half-open spans; no resolved dates or places",
            "runtimeCompatibility": "inactive five-tag experiment; incompatible with the frozen thirteen-tag TypeScript bridge"}, payload


def tensors(header, payload):
    import numpy as np
    if header.get("format") != FORMAT or header.get("tags") != list(TAGS) or header.get("active") is not False or sha(payload) != header.get("sha256") \
            or header.get("dtype") != "float32-little-endian" or header.get("assignmentHash") != ASSIGNMENT or len(payload) > 4 * 1024 * 1024:
        raise ValueError("target_export_identity")
    config = header["config"]
    expected = {
        "embedding.weight": [config["buckets"], config["dim"]],
        **{f"encoder.{name}_l0{suffix}": shape for suffix in ("", "_reverse") for name, shape in {
            "weight_ih": [3 * config["hidden"], config["dim"] + 6], "weight_hh": [3 * config["hidden"], config["hidden"]],
            "bias_ih": [3 * config["hidden"]], "bias_hh": [3 * config["hidden"]]}.items()},
        "classifier.weight": [len(TAGS), 2 * config["hidden"]], "classifier.bias": [len(TAGS)],
    }
    if not 128 <= config["buckets"] <= 32768 or config["buckets"] & (config["buckets"] - 1) or not 4 <= config["dim"] <= 24 or not 4 <= config["hidden"] <= 48:
        raise ValueError("target_export_dimensions")
    if len(header["layout"]) != len(expected):
        raise ValueError("target_export_tensor_count")
    result, total = {}, 0
    for field in header["layout"]:
        if set(field) != {"name", "shape", "offsetBytes", "lengthBytes"}:
            raise ValueError("target_export_layout_metadata")
        name, shape = field["name"], field["shape"]
        if name not in expected or name in result or shape != expected[name] or field["offsetBytes"] != total or field["lengthBytes"] != math.prod(shape) * 4:
            raise ValueError("target_export_layout")
        end = total + field["lengthBytes"]
        array = np.frombuffer(payload[total:end], dtype="<f4")
        if len(array) != math.prod(shape) or not np.isfinite(array).all() or np.abs(array).max(initial=0) > 64:
            raise ValueError("target_export_floats")
        result[name] = array.reshape(shape); total = end
    if total != len(payload):
        raise ValueError("target_export_trailing")
    return result


def numpy_logits(header, payload, row):
    import numpy as np
    base = base_api(); values = tensors(header, payload); config = header["config"]; hidden = config["hidden"]
    features = [np.concatenate((values["embedding.weight"][base.token_features(token, config["buckets"])].mean(0),
                                np.asarray(base.token_flags(token), dtype=np.float32))) for token in row.tokens]
    directions = []
    for reverse in (False, True):
        suffix = "_reverse" if reverse else ""
        wi, wh = values[f"encoder.weight_ih_l0{suffix}"], values[f"encoder.weight_hh_l0{suffix}"]
        bi, bh = values[f"encoder.bias_ih_l0{suffix}"], values[f"encoder.bias_hh_l0{suffix}"]
        state = np.zeros(hidden, dtype=np.float32); output = [None] * len(features)
        for index in (range(len(features) - 1, -1, -1) if reverse else range(len(features))):
            incoming, recurrent = wi @ features[index] + bi, wh @ state + bh
            reset = 1 / (1 + np.exp(-np.clip(incoming[:hidden] + recurrent[:hidden], -40, 40)))
            update = 1 / (1 + np.exp(-np.clip(incoming[hidden:2 * hidden] + recurrent[hidden:2 * hidden], -40, 40)))
            candidate = np.tanh(incoming[2 * hidden:] + reset * recurrent[2 * hidden:])
            state = (1 - update) * candidate + update * state; output[index] = state.copy()
        directions.append(output)
    encoded = np.stack([np.concatenate(pair) for pair in zip(*directions)])
    return encoded @ values["classifier.weight"].T + values["classifier.bias"]


def checksums(directory: Path):
    names = sorted(path for path in directory.iterdir() if path.is_file() and path.name != "checksums.json")
    write(directory / "checksums.json", {path.name: sha(path.read_bytes()) for path in names})


def candidate_worker(directory: Path, identity: str):
    import numpy as np
    if (directory.parent / f"source-{Path(__file__).name}").read_bytes() != Path(__file__).read_bytes():
        raise ValueError("experiment_source_changed")
    candidate, manifest = checked_candidate(identity), frozen_manifest()
    splits = load_partition_rows(manifest, ("train", "dev", "calibration"))
    model, training = train_model(splits, candidate); base = base_api(); config = config_for(candidate)
    dev_logits = base.sequence_logits(model, splits["dev"], config)
    dev = metrics(splits["dev"], dev_logits)
    calibration_logits = base.sequence_logits(model, splits["calibration"], config)
    calibration = base.calibrate(splits["calibration"], expanded(calibration_logits), config)
    calibration["thresholds"] = {label: calibration["thresholds"][label] for label in TARGETS}
    calibration["perSlot"] = {label: calibration["perSlot"][label] for label in TARGETS}
    selective = metrics(splits["calibration"], calibration_logits, calibration["temperature"], calibration["thresholds"])
    header, payload = export_model(model, config)
    parity_rows = splits["dev"][:12]
    expected = base.sequence_logits(model, parity_rows, config)
    errors = []
    for row, reference in zip(parity_rows, expected):
        actual = numpy_logits(header, payload, row)
        if not np.allclose(reference, actual, rtol=1e-5, atol=1e-5) or base.viterbi_decode(expanded([reference])[0]) != base.viterbi_decode(expanded([actual])[0]):
            raise RuntimeError("target_independent_numpy_parity")
        errors.append(float(np.abs(reference - actual).max(initial=0)))
    write(directory / "weights.bin", payload, raw=True); write(directory / "model.json", header); write(directory / "calibration.json", calibration)
    write(directory / "selection-report.json", {"candidate": asdict(candidate), "assignmentHash": ASSIGNMENT, "active": False, "training": training,
          "developmentMacroF1": macro_f1(dev), "developmentRaw": brief(dev), "calibration": calibration, "calibrationSelective": brief(selective),
          "parityMaximumLogitError": max(errors, default=0), "testUsedForSelection": False})
    write(directory / "parity.json", [{"text": row.text, "logits": logits.tolist()} for row, logits in zip(parity_rows, expected)])
    checksums(directory)


def verified_files(directory):
    sums = read_json(directory / "checksums.json", 65536)
    if len(sums) > 16:
        raise ValueError("checksum_count")
    for name, expected in sums.items():
        if Path(name).name != name or "/" in name or "\\" in name or sha((directory / name).read_bytes()) != expected:
            raise ValueError("artifact_checksum_mismatch")
    return sums


def score_counts(tp, fp, fn):
    return {"precision": tp / (tp + fp) if tp + fp else None, "recall": tp / (tp + fn) if tp + fn else None,
            "exactSpanF1": 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else 0}


def prediction_sets(entry, selected):
    return {(item["label"], item["startCodepoint"], item["endCodepoint"]) for item in entry["predictions"]
            if item["label"] in TARGETS and (not selected or item["accepted"])}


def baseline_target_metrics(baseline, rows):
    counts = {label: Counter() for label in TARGETS}; locales = {locale: Counter() for locale in ("ar-SA", "en-US")}
    output, raw_total = [], 0
    for row in rows:
        entry = baseline[base_api().sha(row.id)]
        gold = {base_api().span_key(span) for span in row.spans}
        if gold != {tuple(span) for span in entry["gold"] if span[0] in TARGETS}:
            raise ValueError("baseline_target_gold_mismatch")
        actual = prediction_sets(entry, True); raw_total += len(prediction_sets(entry, False))
        for label in TARGETS:
            truth, guessed = {span for span in gold if span[0] == label}, {span for span in actual if span[0] == label}
            values = {"tp": len(truth & guessed), "fp": len(guessed - truth), "fn": len(truth - guessed), "gold": len(truth), "predicted": len(guessed)}
            counts[label].update(values); locales[row.locale].update(values)
        output.append(entry)
    overall = sum(counts.values(), Counter())
    enrich = lambda values: {**dict(values), **score_counts(values["tp"], values["fp"], values["fn"])}
    return {"overall": enrich(overall), "perSlot": {label: enrich(value) for label, value in counts.items()},
            "perLocale": {locale: enrich(value) for locale, value in locales.items()}, "rawPredictedSpans": raw_total,
            "acceptedSpans": overall["tp"] + overall["fp"], "spanAcceptanceCoverage": (overall["tp"] + overall["fp"]) / max(1, raw_total)}


def paired_comparison(rows, old_entries, new_entries, bootstrap_samples=2000):
    import numpy as np
    old_map, new_map = {entry["rowHash"]: entry for entry in old_entries}, {entry["rowHash"]: entry for entry in new_entries}
    grouped = defaultdict(lambda: [Counter(), Counter()]); paired = Counter()
    for row in rows:
        key = base_api().sha(row.id); gold = {base_api().span_key(span) for span in row.spans}
        correct = []
        for index, entry in enumerate((old_map[key], new_map[key])):
            actual = prediction_sets(entry, True); correct.append(actual == gold)
            grouped[row.group_id][index].update({"tp": len(gold & actual), "fp": len(actual - gold), "fn": len(gold - actual), "raw": len(prediction_sets(entry, False))})
        paired[f"baseline_{int(correct[0])}_candidate_{int(correct[1])}"] += 1
    matrix = np.asarray([[[entry[field] for field in ("tp", "fp", "fn", "raw")] for entry in pair] for _, pair in sorted(grouped.items())], dtype=np.float64)
    def values(counts):
        tp, fp, fn, raw = counts
        return {**score_counts(tp, fp, fn), "coverage": (tp + fp) / raw if raw else None}
    aggregate = matrix.sum(0); before, after = values(aggregate[0]), values(aggregate[1])
    draws = defaultdict(list); rng = np.random.default_rng(127)
    for _ in range(bootstrap_samples):
        sample = matrix[rng.integers(0, len(matrix), len(matrix))].sum(0)
        left, right = values(sample[0]), values(sample[1])
        for metric in before:
            if left[metric] is not None and right[metric] is not None:
                draws[metric].append(right[metric] - left[metric])
    return {"method": f"paired percentile bootstrap of frozen translation groups; {bootstrap_samples} draws; not a new population guarantee",
            "translationGroups": len(matrix), "utteranceExactPairedCounts": dict(paired),
            "deltasCandidateMinusBaseline": {metric: {"observed": after[metric] - before[metric] if after[metric] is not None and before[metric] is not None else None,
              "ci95": np.quantile(draws[metric], [.025, .975]).tolist() if len(draws[metric]) >= bootstrap_samples * .9 else None,
              "validDraws": len(draws[metric])} for metric in before}}


def final_worker(directory: Path):
    import torch
    if (directory / f"source-{Path(__file__).name}").read_bytes() != Path(__file__).read_bytes():
        raise ValueError("experiment_source_changed")
    base, manifest = base_api(), frozen_manifest()
    selection = read_json(directory / "selection.json")
    plan = read_json(directory / "plan.json")
    if selection["planSha256"] != sha((directory / "plan.json").read_bytes()) or plan["assignmentHash"] != ASSIGNMENT or selection["assignmentHash"] != ASSIGNMENT:
        raise ValueError("selection_plan_identity")
    candidate = checked_candidate(selection["candidateId"]); selected = directory / candidate.id
    sums = verified_files(selected)
    if sums["weights.bin"] != selection["weightsSha256"] or sums["calibration.json"] != selection["calibrationSha256"] \
            or sums["model.json"] != selection["modelSha256"] or sums["selection-report.json"] != selection["selectionReportSha256"]:
        raise ValueError("selection_candidate_changed")
    # No test rows or baseline test outcomes are used above this immutable gate.
    write(directory / "final-test-reservation.json", {"selectionSha256": sha((directory / "selection.json").read_bytes()), "testInferenceLimit": 1})
    rows = load_partition_rows(manifest, ("test",))["test"]
    if len(rows) != 2214:
        raise ValueError("frozen_test_count")
    config = config_for(candidate); torch.set_num_threads(4)
    model = model_for(config); header = read_json(selected / "model.json"); payload = (selected / "weights.bin").read_bytes()
    values = tensors(header, payload)
    model.load_state_dict({name: torch.from_numpy(value.copy()) for name, value in values.items()})
    logits = base.sequence_logits(model, rows, config)  # One cached final inference.
    calibration = read_json(selected / "calibration.json")
    raw = metrics(rows, logits, calibration["temperature"])
    selective = metrics(rows, logits, calibration["temperature"], calibration["thresholds"])
    old_sums = read_json(BASELINE / "checksums.json", 65536)
    report_payload = (BASELINE / "report.json").read_bytes()
    if sha(report_payload) != old_sums["report.json"] or old_sums["report.json"] != plan["baselineReportSha256"]:
        raise ValueError("frozen_baseline_report_changed")
    old_report = json.loads(report_payload)
    old_entries = old_report["test"]["selective"]["predictions"]
    old_map = {entry["rowHash"]: entry for entry in old_entries}
    if set(old_map) != {base.sha(row.id) for row in rows}:
        raise ValueError("paired_test_membership")
    baseline = baseline_target_metrics(old_map, rows)
    paired = paired_comparison(rows, old_entries, selective["predictions"])
    write(directory / "final-test.json", {"active": False, "candidateId": candidate.id, "assignmentHash": ASSIGNMENT,
          "selectionSha256": sha((directory / "selection.json").read_bytes()), "testUsedForSelection": False, "testIsSealed": False,
          "targetLabels": list(TARGETS), "rows": len(rows), "raw": brief(raw), "selective": brief(selective), "baselineTargetSelective": baseline,
          "pairedComparison": paired, "predictions": selective["predictions"], "memoryObservedMiB": base.memory_mb(),
          "limitations": ["Public sampled data, one seed and one frozen split; not owner task success or general intelligence.",
                          "Candidate selection reuses calibration metrics; final test is held out from selection but public and previously evaluated for the baseline.",
                          "Target-only recall denominator differs from the original six-label headline recall.",
                          "Span hypotheses can be wrong; no activation or runtime bridge compatibility."]})


def process_rss_mib(pid):
    if os.name != "nt":
        try:
            match = re.search(r"^VmRSS:\s+(\d+)", Path(f"/proc/{pid}/status").read_text(), re.M)
            return int(match[1]) / 1024 if match else None
        except OSError:
            return None
    class Memory(ctypes.Structure):
        _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong)] + [(name, ctypes.c_size_t) for name in
                    ("PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]
    open_process = ctypes.windll.kernel32.OpenProcess; open_process.restype = ctypes.c_void_p
    handle = open_process(0x0400 | 0x0010, False, pid)
    if not handle:
        return None
    try:
        value = Memory(); value.cb = ctypes.sizeof(value)
        query = ctypes.windll.psapi.GetProcessMemoryInfo
        query.argtypes = [ctypes.c_void_p, ctypes.POINTER(Memory), ctypes.c_ulong]
        return value.WorkingSetSize / 1024 / 1024 if query(handle, ctypes.byref(value), value.cb) else None
    finally:
        ctypes.windll.kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        ctypes.windll.kernel32.CloseHandle(handle)


def bounded_child(arguments, seconds):
    global _active_child
    env = dict(os.environ)
    for variable in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        env[variable] = "4"
    start = time.monotonic(); peak = 0; measured = False; reason = None
    # Windows venv python.exe can be a redirector spawning another python.exe.
    # Monitor/kill the actual interpreter, while explicitly reusing this venv's
    # reviewed installed packages. No child launcher or subprocess tree remains.
    bootstrap = "import runpy,sys;sys.path.insert(0,sys.argv[1]);sys.argv=sys.argv[2:];runpy.run_path(sys.argv[0],run_name='__main__')"
    command = [actual_interpreter(), "-I", "-c", bootstrap, sysconfig.get_path("purelib"), str(Path(__file__).resolve()), *arguments]
    child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    _active_child = child
    while child.poll() is None:
        rss = process_rss_mib(child.pid)
        if rss is not None:
            measured = True; peak = max(peak, rss)
        if rss is not None and rss > MEMORY_MIB:
            reason = "rss_target_exceeded"; child.kill(); break
        if time.monotonic() - start > seconds:
            reason = "hard_wall_deadline"; child.kill(); break
        time.sleep(.1)
    stdout, stderr = child.communicate(timeout=5)
    _active_child = None
    if len(stdout) > 65536 or len(stderr) > 65536:
        raise RuntimeError("worker_output_bound")
    result = {"returnCode": child.returncode, "seconds": time.monotonic() - start, "hardWallLimitSeconds": seconds,
              "observedPeakRssMiB": peak if measured else None, "rssMonitorAvailable": measured, "terminationReason": reason,
              "stdout": stdout.decode("utf-8", errors="replace"), "stderr": stderr.decode("utf-8", errors="replace")}
    return result


def actual_interpreter():
    executable = Path(getattr(sys, "_base_executable", sys.executable)).resolve()
    if not executable.is_file():
        raise RuntimeError("actual_interpreter_unavailable")
    return str(executable)


def hard_total_deadline():
    # The orchestrator owns at most one direct child and no worker descendants.
    # This watchdog includes preprocessing, selection, export and test evaluation.
    if _active_child is not None:
        try:
            _active_child.kill()
        except OSError:
            pass
    sys.stderr.write('{"fatal":"hard_total_deadline","limitSeconds":600}\n')
    os._exit(124)


def run_experiment(name: str, prepare_only=False):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", name):
        raise ValueError("invalid_run_name")
    started = time.monotonic(); manifest = frozen_manifest()
    directory = OUTPUT / name
    directory.mkdir(parents=True, exist_ok=False)
    for source in (Path(__file__).resolve(), Path(__file__).with_name("test_train_slots_date_place.py")):
        write(directory / f"source-{source.name}", source.read_bytes(), raw=True)
    old_sums = read_json(BASELINE / "checksums.json", 65536)
    plan = {"format": "public-date-place-experiment-plan-v2", "active": False, "assignmentHash": ASSIGNMENT,
            "frozenManifestSha256": BASE_MANIFEST, "baselineReportSha256": old_sums["report.json"], "candidates": [asdict(candidate) for candidate in CANDIDATES],
            "targetLabels": list(TARGETS), "tags": list(TAGS), "checkpointSelection": "development macro exact-span F1 over date/place",
            "candidateSelection": ["number of calibrated supported labels", "calibration macro recall", "development macro F1", "smaller parameter count", "candidate ID"],
            "calibration": {"partition": "calibration", "temperatureGrid": [.5, .75, 1, 1.5, 2, 3], "perLabelPrecisionLower95": .9, "minimumAccepted": 20},
            "limits": {"totalSeconds": TOTAL_SECONDS, "candidateWallSeconds": CANDIDATE_SECONDS, "trainingSeconds": TRAIN_SECONDS, "threads": 4, "memoryMiB": MEMORY_MIB},
            "dataPolicy": {"ownerData": False, "assessmentFixtures": False, "pretrainedOrExternalModels": False,
                           "publicTestBytesHashedForIntegrity": True, "publicTestMetadataInFrozenManifest": True, "testUsedForSelection": False,
                           "testInference": "chosen candidate once, only after immutable selection; baseline cached predictions only after selection"}}
    plan_hash = write(directory / "plan.json", plan)
    splits = load_partition_rows(manifest, ("train", "dev", "calibration"))
    summary = {part: {"rows": len(rows), "targetGoldSpans": dict(Counter(span.label for row in rows for span in row.spans))} for part, rows in splits.items()}
    del splits
    write(directory / "prepare.json", summary)
    print(json.dumps({"directory": str(directory.relative_to(ROOT)), "assignmentHash": ASSIGNMENT, "prepared": summary}), flush=True)
    if prepare_only:
        checksums(directory); return
    resources, reports = {}, []
    for candidate in CANDIDATES:
        remaining = TOTAL_SECONDS - (time.monotonic() - started)
        if remaining < 10:
            break
        target = directory / candidate.id; target.mkdir(exist_ok=False)
        result = bounded_child(["worker", "--directory", str(target), "--candidate", candidate.id], min(CANDIDATE_SECONDS, remaining))
        resources[candidate.id] = result
        print(json.dumps({"candidate": candidate.id, **{key: value for key, value in result.items() if key not in ("stdout", "stderr")}}), flush=True)
        if result["returnCode"] == 0 and (target / "selection-report.json").exists():
            verified_files(target); reports.append(read_json(target / "selection-report.json"))
    write(directory / "resources.json", resources)
    selected = select_candidate(reports); identity = selected["candidate"]["id"]
    sums = verified_files(directory / identity)
    selection = {"candidateId": identity, "planSha256": plan_hash, "assignmentHash": ASSIGNMENT,
                 "weightsSha256": sums["weights.bin"], "modelSha256": sums["model.json"], "calibrationSha256": sums["calibration.json"], "selectionReportSha256": sums["selection-report.json"],
                 "candidateRanks": {report["candidate"]["id"]: list(selection_key(report)) for report in reports}, "testUsedForSelection": False, "active": False}
    write(directory / "selection.json", selection)
    print(json.dumps({"selected": identity, "selectionWrittenBeforeTest": True}), flush=True)
    remaining = TOTAL_SECONDS - (time.monotonic() - started)
    if remaining <= 0:
        raise RuntimeError("total_budget_before_final_test")
    final = bounded_child(["final", "--directory", str(directory)], remaining)
    write(directory / "final-resources.json", final)
    if final["returnCode"] != 0:
        checksums(directory); raise RuntimeError("final_evaluation_failed")
    write(directory / "completion.json", {"active": False, "seconds": time.monotonic() - started, "limitSeconds": TOTAL_SECONDS,
          "chosenCandidate": identity, "completedCandidates": len(reports), "allPredeclaredCandidatesCompleted": len(reports) == len(CANDIDATES)})
    checksums(directory)
    report = read_json(directory / "final-test.json")
    print(json.dumps({"completed": str(directory.relative_to(ROOT)), "selected": identity, "raw": report["raw"]["overall"], "selective": report["selective"]["overall"],
                      "baselineTargetSelective": report["baselineTargetSelective"]["overall"], "paired": report["pairedComparison"], "active": False}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "run", "worker", "final"))
    parser.add_argument("--run-name"); parser.add_argument("--directory", type=Path); parser.add_argument("--candidate")
    args = parser.parse_args()
    if args.command in ("prepare", "run"):
        watchdog = threading.Timer(TOTAL_SECONDS, hard_total_deadline)
        watchdog.daemon = True; watchdog.start()
        try:
            run_experiment(args.run_name or "date-place-cpu-20261121-a", args.command == "prepare")
        finally:
            watchdog.cancel()
    else:
        directory = args.directory.resolve()
        if OUTPUT.resolve() not in directory.parents:
            raise ValueError("worker_output_path_escape")
        if args.command == "worker":
            candidate_worker(directory, args.candidate)
        else:
            final_worker(directory)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    main()
