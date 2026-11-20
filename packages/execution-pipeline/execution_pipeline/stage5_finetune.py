"""Gate-bound Stage 5 fine-tuning using the existing local answer-loss trainer.

Preparing/checking only reads pinned local evidence. Running requires passed
semantic Gate 3, answer-loss Gate 4, final data eligibility and independent QA.
This runner never generates evaluation replies, opens a holdout, or activates.
"""
from __future__ import annotations

from datetime import datetime, timezone
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import re
from typing import Any

from . import REPOSITORY_ROOT
from .ads_finetune import finetune
from .chat_diagnostics import GpuJob


FROZEN_PROBE_MANIFEST = Path("artifacts/chat-training/v4/probes/completion-20261116T015009Z/manifest.json")
FROZEN_PROBE_MANIFEST_SHA256 = "b42b0cd7a72f096ef3accea3408af102e608dc92a72083851ee2e8e873e5b1e6"
FROZEN_PROBES_SHA256 = "8dd8a1cc149b8f91be575ff7cc1a700b8c9aa96a547eb657304cb0ecfe679995"
PARAMETERS = {"epochs": 6, "batch": 2, "accumulation": 8, "peak_lr": 0.00005, "warmup": 100,
              "eval_every": 100, "patience": 6, "seed": 5, "balanced_languages": True,
              "group_by_length": True, "drop_long": False, "hint": None,
              "source_metrics": True, "verify_step_zero": True, "preserve_evaluations": False}
CODE_PATHS = (
    "packages/execution-pipeline/execution_pipeline/stage5_finetune.py",
    "packages/execution-pipeline/scripts/stage5_finetune.py",
    "packages/execution-pipeline/execution_pipeline/__init__.py",
    "packages/execution-pipeline/execution_pipeline/ads_finetune.py",
    "packages/execution-pipeline/execution_pipeline/chat.py",
    "packages/execution-pipeline/execution_pipeline/pretrain.py",
    "packages/execution-pipeline/execution_pipeline/chat_diagnostics.py",
    "packages/execution-model/execution_model/model.py",
    "packages/execution-model/execution_model/config.py",
    "packages/execution-model/execution_model/tokenizer.py",
    "packages/execution-model/execution_model/attention.py",
    "packages/execution-model/execution_model/feed_forward.py",
    "packages/execution-model/execution_model/normalization.py",
    "packages/execution-model/execution_model/positional.py",
    "packages/execution-model/execution_model/initialization.py",
    "packages/execution-model/execution_model/errors.py",
)


def _now():
    return datetime.now(timezone.utc).isoformat()


def _safe(path: Path, root: Path) -> Path:
    path = (root / path).resolve() if not path.is_absolute() else path.resolve()
    sealed = (root / "artifacts/chat-training/conversation-v1/holdout").resolve()
    if path == sealed or path.is_relative_to(sealed):
        raise ValueError("The sealed independent holdout is outside this runner's scope.")
    return path


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _pin(path: Path, root: Path, expected: str | None = None) -> dict[str, Any]:
    path = _safe(path, root)
    digest = sha256(path)
    if expected is not None and digest != expected:
        raise ValueError(f"Pinned evidence changed: {path}")
    return {"path": str(path), "sha256": digest, "bytes": path.stat().st_size}


def _verify_pin(pin: dict[str, Any], root: Path) -> Path:
    path = _safe(Path(pin["path"]), root)
    if not re.fullmatch(r"[0-9a-f]{64}", pin["sha256"]) or sha256(path) != pin["sha256"]:
        raise ValueError(f"Pinned evidence changed: {path}")
    if "bytes" in pin and path.stat().st_size != pin["bytes"]:
        raise ValueError(f"Pinned evidence size changed: {path}")
    return path


def _read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _read_pin(pin, root):
    return _read(_verify_pin(pin, root))


def _new_json(path, value):
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")


def _finite_loss(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def _dataset_files(report, train_sha, validation_sha):
    files = report.get("files", {})
    if any(files.get(f"{split}.jsonl", {}).get("sha256") != digest
           for split, digest in (("train", train_sha), ("validation", validation_sha))):
        raise ValueError("Dataset evidence does not bind the exact train/validation files.")


def verify_gate3(path: Path, expected_sha256: str, *, root: Path = REPOSITORY_ROOT) -> dict[str, Any]:
    """CPU-only semantic/frozen-probe binding shared by Stages 4 and 5."""
    gate3 = _read_pin(_pin(path, root, expected_sha256), root)
    if (gate3.get("gate3_passed") is not True
            or gate3.get("frozen_probe_manifest_sha256") != FROZEN_PROBE_MANIFEST_SHA256):
        raise ValueError("Passed semantic Gate 3 and its frozen probe manifest are required.")
    _pin(root / FROZEN_PROBE_MANIFEST, root, FROZEN_PROBE_MANIFEST_SHA256)
    for language in ("ar", "en"):
        result = gate3.get("results", {}).get(language, {})
        if (result.get("total") != 20 or type(result.get("passed")) is not int
                or not 16 <= result["passed"] <= 20):
            raise ValueError("Semantic Gate 3 needs at least 16/20 passes in each language.")
    generation = _read_pin(gate3["generation_manifest"], root)
    if (generation.get("checkpoint_sha256") != gate3.get("candidate_checkpoint_sha256")
            or generation.get("input", {}).get("sha256") != FROZEN_PROBES_SHA256
            or generation.get("scheduled") != {"total": 40, "ar": 20, "en": 20}
            or generation.get("generated") != {"total": 40, "ar": 20, "en": 20}
            or generation.get("decoding", {}).get("method") != "greedy_argmax"
            or generation.get("decoding", {}).get("max_new_tokens") != 192
            or generation.get("decoding", {}).get("raw_prompt") is not True):
        raise ValueError("Gate 3 generation does not bind its checkpoint and frozen raw probes.")
    _verify_pin(generation["predictions"], root)
    if any(generation.get("finished", {}).get(lang, -1) < gate3["results"][lang]["passed"]
           for lang in ("ar", "en")):
        raise ValueError("Gate 3 pass counts exceed the EOS-finished generations.")
    return {"gate3": gate3, "generation": generation}


def _gate_evidence(protocol, root):
    """Refuse incomplete or unbound gates before the GPU lock is acquired."""
    validated = verify_gate3(Path(protocol["gate3"]["path"]), protocol["gate3"]["sha256"], root=root)
    gate3, generation = validated["gate3"], validated["generation"]
    gate4 = _read_pin(protocol["gate4"], root)
    validation_sha = protocol["dataset"]["validation"]["sha256"]
    if (gate4.get("gate4_passed") is not True
            or gate4.get("base_checkpoint_sha256") != gate3["candidate_checkpoint_sha256"]
            or gate4.get("candidate_checkpoint_sha256") != protocol["base_checkpoint"]["sha256"]
            or gate4.get("validation_sha256") != validation_sha):
        raise ValueError("Passed Stage 4 must bind the Gate 3 foundation, adapted base and final validation.")
    for name in ("answer_loss_before", "answer_loss_after"):
        losses = gate4.get(name, {})
        if (set(losses) != {"ar", "en", "macro"} or not all(_finite_loss(value) for value in losses.values())
                or not math.isclose(losses["macro"], (losses["ar"] + losses["en"]) / 2, rel_tol=1e-9, abs_tol=1e-9)):
            raise ValueError("Stage 4 requires finite per-language and equal-language macro answer losses.")
    if gate4["answer_loss_after"]["macro"] >= gate4["answer_loss_before"]["macro"]:
        raise ValueError("Stage 4 macro answer loss has not improved.")

    verified = verify_eligibility(Path(protocol["eligibility"]["path"]), protocol["eligibility"]["sha256"],
                                  protocol["qa"], dataset_dir=Path(protocol["dataset_dir"]), root=root)
    if (verified["data_dir"] != Path(protocol["dataset_dir"])
            or verified["dataset"] != protocol["dataset"]):
        raise ValueError("Gate evidence and training protocol refer to different datasets.")
    if verified["manifest"].get("tokenizer_sha256") != protocol["tokenizer"]["tokenizer.json"]["sha256"]:
        raise ValueError("Dataset eligibility was audited under a different tokenizer SHA-256.")
    return {"gate3": gate3, "gate4": gate4, "generation": generation, **verified}


def verify_eligibility(path: Path, expected_sha256: str, qa_pins: list[dict[str, Any]], *,
                       dataset_dir: Path,
                       root: Path = REPOSITORY_ROOT) -> dict[str, Any]:
    """CPU-only shared Stage 4/5 data and QA validation; never reads row text.

    The final eligibility receipt pins the manifest and split hashes, semantic
    QA, and true-carrier/split audits; callers explicitly supply the directory.
    """
    eligibility = _read_pin(_pin(path, root, expected_sha256), root)
    data_dir = _safe(dataset_dir, root)
    if eligibility.get("dataset") and _safe(Path(eligibility["dataset"]), root) != data_dir:
        raise ValueError("Eligibility receipt points at a different dataset directory.")
    dataset = {name: _pin(data_dir / filename, root)
               for name, filename in (("manifest", "manifest.json"), ("train", "train.jsonl"), ("validation", "validation.jsonl"))}
    protocol = {"dataset": dataset, "qa": qa_pins}

    manifest = _read_pin(protocol["dataset"]["manifest"], root)
    train_sha = protocol["dataset"]["train"]["sha256"]
    validation_sha = protocol["dataset"]["validation"]["sha256"]
    if (eligibility.get("eligible_for_training") is not True or eligibility.get("semantic_quality_passed") is not True
            or eligibility.get("dataset_manifest_sha256") != protocol["dataset"]["manifest"]["sha256"]
            or eligibility.get("dataset_sha256") != {"train": train_sha, "validation": validation_sha}):
        raise ValueError("Final dataset eligibility and semantic QA for these exact files are required.")
    _dataset_files(manifest, train_sha, validation_sha)
    if manifest.get("inference_format") != "execution_pipeline.chat.conversation_prompt(messages)":
        raise ValueError("Dataset must use the unchanged inference conversation format.")
    source = manifest.get("source")
    sources = manifest.get("sources", [source] if source else [])
    if not isinstance(sources, list) or not sources or not all(isinstance(item, str) and item for item in sources):
        raise ValueError("Dataset manifest must declare its sources.")
    for language in ("ar", "en"):
        counts = manifest.get("counts", {}).get(language, {})
        for split in ("train", "validation"):
            count = counts.get(split, {})
            rows, multi = count.get("rows"), count.get("multi_turn")
            if (type(rows) is not int or type(multi) is not int or not 0 <= multi <= rows
                    or rows < (20_000 if split == "train" else 1) or multi / rows < 0.25):
                raise ValueError("Dataset needs >=20,000 training rows/language and >=25% multi-turn in both splits.")

    qa_pins = eligibility.get("qa", [])
    def identity(pin):
        return str(_safe(Path(pin["path"]), root)), pin["sha256"]
    if (not qa_pins or len({identity(pin) for pin in qa_pins}) != len(qa_pins)
            or {identity(pin) for pin in qa_pins} != {identity(pin) for pin in protocol["qa"]}):
        raise ValueError("Eligibility QA pins must exactly match the explicit reviewed evidence.")
    reviewed = set()
    for pin in qa_pins:
        report = _read_pin(pin, root)
        if report.get("semantic_quality_passed") is not True or report.get("independent_review") is not True:
            raise ValueError("Independent semantic QA must explicitly pass.")
        _dataset_files(report, train_sha, validation_sha)
        for review in report.get("reviews", []):
            size, bad = review.get("sample_size"), review.get("wrong_or_unnatural")
            if (type(size) is not int or size < 200 or type(bad) is not int or not 0 <= bad <= size
                    or bad / size > 0.03 or review.get("passed") is not True):
                raise ValueError("Each independent QA source/language needs >=200 reads and <=3% bad rows.")
            reviewed.add((review.get("language"), review.get("source")))
    if not {(lang, item) for lang in ("ar", "en") for item in sources}.issubset(reviewed):
        raise ValueError("Independent semantic QA does not cover every source in both languages.")

    carrier = _read_pin(eligibility["carrier_audit"], root)
    split = _read_pin(eligibility["split_audit"], root)
    for report in (carrier, split):
        if report.get("passed") is not True:
            raise ValueError("True carrier and split audits must both pass.")
        _dataset_files(report, train_sha, validation_sha)
    if (split.get("group_overlap_train_validation") != 0
            or split.get("exact_normalized_prompt_target_duplicates") != 0):
        raise ValueError("Dataset split audit found overlapping groups or duplicate pairs.")
    for language in ("ar", "en"):
        counts = carrier.get("counts", {}).get(language, {})
        rows, peak = counts.get("rows"), counts.get("peak_carrier_rows")
        fraction = counts.get("peak_carrier_fraction")
        expected_rows = sum(manifest["counts"][language][name]["rows"] for name in ("train", "validation"))
        if (type(rows) is not int or rows != expected_rows or type(peak) is not int or not 1 <= peak <= rows
                or not _finite_loss(fraction) or fraction > 0.005
                or not math.isclose(fraction, peak / rows, rel_tol=1e-9, abs_tol=1e-9)):
            raise ValueError("True carrier audit needs measured per-language frequencies <=0.5%.")
    return {"eligibility": eligibility, "manifest": manifest, "data_dir": data_dir, "dataset": dataset}


def prepare(*, run: Path, base_checkpoint: Path, base_sha256: str, out_name: str, campaign: Path,
            dataset_dir: Path, gate3: Path, gate3_sha256: str, gate4: Path, gate4_sha256: str,
            eligibility: Path, eligibility_sha256: str, qa: list[tuple[Path, str]],
            root: Path = REPOSITORY_ROOT) -> dict[str, Any]:
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", out_name) or out_name in {".", ".."}:
        raise ValueError("Output name must be a plain new directory name.")
    run, campaign, dataset_dir = (_safe(path, root) for path in (run, campaign, dataset_dir))
    base = _safe(run / base_checkpoint, root)
    if not base.is_relative_to(run) or base.name != "best.pt":
        raise ValueError("Stage 5 base must be a pinned best.pt inside its run.")
    if (run / out_name).exists():
        raise FileExistsError("Stage 5 training output already exists; never overwrite it.")
    protocol = {"schemaVersion": 1, "stage": 5, "prepared_at": _now(), "run": str(run),
        "out_name": out_name, "campaign": str(campaign), "dataset_dir": str(dataset_dir),
        "base_checkpoint": _pin(base, root, base_sha256), "base_settings": _pin(base.parent / "settings.json", root),
        "tokenizer": {name: _pin(run / name, root) for name in ("tokenizer.json", "tokenizer-report.json")},
        "dataset": {name: _pin(dataset_dir / filename, root)
                    for name, filename in (("manifest", "manifest.json"), ("train", "train.jsonl"), ("validation", "validation.jsonl"))},
        "gate3": _pin(gate3, root, gate3_sha256), "gate4": _pin(gate4, root, gate4_sha256),
        "eligibility": _pin(eligibility, root, eligibility_sha256),
        "qa": [_pin(path, root, digest) for path, digest in qa],
        "code": {name: _pin(root / name, root) for name in CODE_PATHS},
        "parameters": PARAMETERS, "selection_metric": "macro_language_answer_loss", "device": "cuda",
        "runtime_limit_seconds": 4 * 3600, "ready_for_chat": False, "phone_activated": False,
        "independent_test": False}
    if _read(base.parent / "settings.json").get("prompt_hint") is not None:
        raise ValueError("The adapted base must use the unchanged chat format with no name hint.")
    _gate_evidence(protocol, root)
    campaign.mkdir(parents=True, exist_ok=False)
    _new_json(campaign / "protocol.json", protocol)
    return {"status": "prepared", "protocol": str(campaign / "protocol.json"),
            "protocol_sha256": sha256(campaign / "protocol.json"), "gpu_started": False}


def check(protocol_path: Path, protocol_sha256: str, *, root: Path = REPOSITORY_ROOT) -> dict[str, Any]:
    protocol_path = _safe(protocol_path, root)
    _pin(protocol_path, root, protocol_sha256)
    protocol = _read(protocol_path)
    if (protocol.get("schemaVersion") != 1 or protocol.get("stage") != 5
            or protocol.get("parameters") != PARAMETERS or protocol.get("device") != "cuda"
            or protocol.get("runtime_limit_seconds") != 4 * 3600
            or protocol.get("selection_metric") != "macro_language_answer_loss"
            or any(protocol.get(key) is not False for key in ("ready_for_chat", "phone_activated", "independent_test"))
            or _safe(Path(protocol["campaign"]), root) != protocol_path.parent.resolve()):
        raise ValueError("Unexpected or changed Stage 5 protocol.")
    run, dataset = Path(protocol["run"]), Path(protocol["dataset_dir"])
    name = protocol["out_name"]
    base = _safe(Path(protocol["base_checkpoint"]["path"]), root)
    if (not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", name) or name in {".", ".."}
            or not base.is_relative_to(run) or base.name != "best.pt"
            or _safe(Path(protocol["base_settings"]["path"]), root) != base.parent / "settings.json"
            or set(protocol["code"]) != set(CODE_PATHS)
            or set(protocol["tokenizer"]) != {"tokenizer.json", "tokenizer-report.json"}):
        raise ValueError("Stage 5 checkpoint or source paths changed.")
    for key, filename in (("manifest", "manifest.json"), ("train", "train.jsonl"), ("validation", "validation.jsonl")):
        if _safe(Path(protocol["dataset"][key]["path"]), root) != dataset / filename:
            raise ValueError("Dataset pin points outside the declared split.")
    for filename, pin in protocol["tokenizer"].items():
        if _safe(Path(pin["path"]), root) != run / filename:
            raise ValueError("Tokenizer pin points outside its run.")
    for filename, pin in protocol["code"].items():
        if _safe(Path(pin["path"]), root) != (root / filename).resolve():
            raise ValueError("Source pin points outside its declared file.")
    for pin in [protocol["base_checkpoint"], protocol["base_settings"], *protocol["tokenizer"].values(),
                *protocol["dataset"].values(), *protocol["code"].values(), protocol["gate3"],
                protocol["gate4"], protocol["eligibility"], *protocol["qa"]]:
        _verify_pin(pin, root)
    if _read(base.parent / "settings.json").get("prompt_hint") is not None:
        raise ValueError("The adapted base must not change the chat format with a name hint.")
    _gate_evidence(protocol, root)
    return protocol


def _awake(flags):
    return ctypes.windll.kernel32.SetThreadExecutionState(flags) if os.name == "nt" else 1


def _cuda_start(guard):
    import torch
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise RuntimeError("CUDA BF16 is required; no device fallback is permitted.")
    torch.set_num_threads(4)
    torch.empty(1, device="cuda")
    guard.start_monitor()


def run(protocol_path: Path, protocol_sha256: str, *, root: Path = REPOSITORY_ROOT) -> dict[str, Any]:
    protocol = check(protocol_path, protocol_sha256, root=root)
    campaign = Path(protocol["campaign"])
    output = Path(protocol["run"]) / protocol["out_name"]
    if output.exists() or any((campaign / name).exists() for name in ("started.json", "selection.json", "failure.json")):
        raise FileExistsError("This Stage 5 attempt already exists; never overwrite or silently retry it.")
    _new_json(campaign / "started.json", {"started_at": _now(), "protocol_sha256": protocol_sha256})
    awake = False
    try:
        if not _awake(0x80000001):
            raise RuntimeError("Windows could not reserve system wakefulness.")
        awake = True
        with GpuJob(root, campaign, stage="5-dialogue-finetune", max_seconds=protocol["runtime_limit_seconds"]) as guard:
            _cuda_start(guard)
            guard.start_training("stage5-dialogue-finetune")
            result = finetune(Path(protocol["run"]), out_name=protocol["out_name"],
                data_dir=Path(protocol["dataset_dir"]), device="cuda",
                base_checkpoint=Path(protocol["base_checkpoint"]["path"]).relative_to(Path(protocol["run"])),
                progress_check=guard.check, training_update=guard.record_training_update, **PARAMETERS)
            guard.check()
        check(protocol_path, protocol_sha256, root=root)
        if result.get("status") not in {"completed", "early_stopped"}:
            raise ValueError("Stage 5 did not finish successfully.")
        best = _pin(output / "best.pt", root, result["best_checkpoint_sha256"])
        if result.get("validation_selection_metric") != "macro_language_answer_loss":
            raise ValueError("Stage 5 selection must use balanced macro-language answer loss.")
        settings = _pin(output / "settings.json", root)
        receipt = {"schemaVersion": 1, "stage": 5, "status": "awaiting_gate5_development_evaluation",
            "completed_at": _now(), "protocol": _pin(protocol_path, root, protocol_sha256),
            "selected_checkpoint": best, "checkpoint_selection": "best_validation_only",
            "best_step": result["best_step"], "best_validation_metrics": result.get("best_validation_metrics"),
            "settings": settings, "training_status": _pin(output / "status.json", root),
            "dataset": protocol["dataset"], "gate3": protocol["gate3"], "gate4": protocol["gate4"],
            "eligibility": protocol["eligibility"], "code": protocol["code"], "result": result,
            "gate5_passed": None, "ready_for_chat": False, "phone_activated": False, "independent_test": False}
        _new_json(campaign / "selection.json", receipt)
        return receipt
    except BaseException as error:
        _new_json(campaign / "failure.json", {"failed_at": _now(), "protocol_sha256": protocol_sha256,
                  "error": f"{type(error).__name__}: {error}"[:600], "ready_for_chat": False})
        raise
    finally:
        if awake:
            _awake(0x80000000)
