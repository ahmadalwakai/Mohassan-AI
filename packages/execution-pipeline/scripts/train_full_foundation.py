"""Prepare and resume the chosen full foundation run after the measured Gate 2."""
from __future__ import annotations

import argparse
import ctypes
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import sys
import tempfile
import threading

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline import REPOSITORY_ROOT as ROOT
from execution_pipeline.ads_finetune import _atomic_json, _sha256
from execution_pipeline.chat_diagnostics import GpuJob
from execution_pipeline.comparison_eval import FrozenEnglishDevelopment
from execution_pipeline.foundation_comparison import APPROVED_PREPARATION, APPROVED_PREPARATION_SHA256, MODEL_RUN
from execution_pipeline.full_foundation import FullFoundationSampler, INTERVAL, MILESTONES, TARGET
from execution_pipeline.language_adaptation import ComparisonSettings, PilotSettings, adapt
from execution_pipeline.pretrain import TextEncoder
from execution_pipeline.shape_comparison import CAMPAIGN as SHAPE_CAMPAIGN, FOUNDATION, BASELINE
from execution_model.config import ModelConfig

CAMPAIGN = ROOT / "artifacts/chat-training/v4/stage-3-full-20261118"
RUN = ROOT / "artifacts/execution-model-runs/text-b4-2026-11-18/stage-3-full"
PREP = ROOT / APPROVED_PREPARATION
SCRIPT = Path(__file__).resolve()


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def checked(path, digest):
    if _sha256(path) != digest:
        raise ValueError(f"Pinned full-run input changed: {path}")


def sampler_for(code, expected=None):
    return FullFoundationSampler(PREP, read(PREP / "budgets/allocation.json"),
        verifier_sha256=code[f"{APPROVED_PREPARATION}/budgets/verify.py"], expected_receipts=expected)


def prepare():
    decision_path = SHAPE_CAMPAIGN / "assessment.json"
    decision = read(decision_path)
    if decision.get("gate2_passed") is not True or decision.get("comparison_completed") is not True:
        raise ValueError("Both the pilot curve and size comparison must pass before Stage 3.")
    shape = decision["selected_shape"]
    if shape not in ("38m", "85m"):
        raise ValueError("Unknown selected shape.")
    shape_config = read(SHAPE_CAMPAIGN / "config.json")
    checked(SHAPE_CAMPAIGN / "config.json", decision["config_sha256"])
    for name, digest in (shape_config["code_sha256"] | shape_config["input_sha256"]).items():
        checked(ROOT / name, digest)
    checked(PREP / "manifest.json", APPROVED_PREPARATION_SHA256)
    preparation = read(PREP / "manifest.json")
    for name, digest in preparation["sha256"].items():
        checked(PREP / name, digest)
    config_dict = shape_config["model_config"] if shape == "85m" else read(BASELINE)["config"]
    model = ModelConfig.from_dict(dict(config_dict, seed=1729))
    code = dict(shape_config["code_sha256"])
    for name in ("packages/execution-pipeline/execution_pipeline/full_foundation.py",
                 SCRIPT.relative_to(ROOT).as_posix()):
        code[name] = _sha256(ROOT / name)
    sampler = sampler_for(code)
    config = {"stage": 3, "shape": shape, "model_config": model.to_dict(), "model_identity": model.identity,
        "target_positions": TARGET, "milestones": list(MILESTONES), "checkpoint_every_tokens": INTERVAL,
        "early_stop_flat_tokens": 150_000_000, "seed": 1729, "sequence": 512,
        "microbatch": 2, "accumulation": 8, "peak_lr": 0.0002, "warmup": 100,
        "learning_rate_decay_tokens": TARGET, "fresh_random_initialization": True,
        "initialization_reason": "The pilot had a 300M cosine horizon; this full experiment uses its own 1B schedule with explicit fresh weights and optimizer.",
        "selection_sha256": _sha256(decision_path), "code_sha256": code,
        "input_sha256": {**shape_config["input_sha256"],
            (SHAPE_CAMPAIGN / "config.json").relative_to(ROOT).as_posix(): _sha256(SHAPE_CAMPAIGN / "config.json"),
            decision_path.relative_to(ROOT).as_posix(): _sha256(decision_path)},
        "prep_sha256": APPROVED_PREPARATION_SHA256, "sampling_receipts": sampler.planned_receipts(),
        "pilot_300m_reference": read(FOUNDATION)["last_validation"],
        "runtime_limit_seconds": 72 * 3600, "external_pretrained_weights": False,
        "holdout_accessed": False, "ready_for_chat": False, "phone_activated": False}
    CAMPAIGN.mkdir(parents=True, exist_ok=False)
    RUN.mkdir(parents=True, exist_ok=False)
    for name in ("tokenizer.json", "tokenizer-report.json"):
        shutil.copyfile(ROOT / MODEL_RUN / name, RUN / name)
    _atomic_json(CAMPAIGN / "config.json", config)
    return {"config": str(CAMPAIGN / "config.json"), "sha256": _sha256(CAMPAIGN / "config.json"),
            "shape": shape, "target_positions": TARGET, "gpu_started": False}


def check(config_sha):
    checked(CAMPAIGN / "config.json", config_sha)
    config = read(CAMPAIGN / "config.json")
    if (config["target_positions"] != TARGET or tuple(config["milestones"]) != MILESTONES
            or config["checkpoint_every_tokens"] != INTERVAL or config["early_stop_flat_tokens"] != 150_000_000):
        raise ValueError("Full-run token limits or plateau policy changed.")
    checked(SHAPE_CAMPAIGN / "assessment.json", config["selection_sha256"])
    if read(SHAPE_CAMPAIGN / "assessment.json")["gate2_passed"] is not True:
        raise ValueError("Gate 2 no longer passes.")
    for name, digest in config["code_sha256"].items():
        checked(ROOT / name, digest)
    for name, digest in config["input_sha256"].items():
        checked(ROOT / name, digest)
    checked(PREP / "manifest.json", config["prep_sha256"])
    prep = read(PREP / "manifest.json")
    for name, digest in prep["sha256"].items():
        checked(PREP / name, digest)
    for entry in prep["fixed_validation"].values():
        checked(ROOT / entry["path"], entry["sha256"])
    for name in ("tokenizer.json", "tokenizer-report.json"):
        checked(RUN / name, config["input_sha256"][f"{MODEL_RUN}/{name}"])
    model = ModelConfig.from_dict(config["model_config"])
    if model.identity != config["model_identity"]:
        raise ValueError("Full-run model identity changed.")
    return config, prep, sampler_for(config["code_sha256"], config["sampling_receipts"]), model


def publish_candidate(config, config_sha, result):
    output = RUN / config["shape"]
    if result["status"] not in ("completed", "early_stopped"):
        raise ValueError("Only a finished full run may publish a Gate 3 candidate.")
    point = result["best_checkpoint_tokens"]
    source = output / "checkpoints" / f"tokens-{point:012d}"
    manifest = read(source / "manifest.json")
    checked(source / "checkpoint.pt", manifest["checkpoint_sha256"])
    destination = RUN / "selected"
    if not destination.exists():
        with tempfile.TemporaryDirectory(prefix=".candidate-", dir=RUN) as temporary:
            pending = Path(temporary) / "selected"
            pending.mkdir()
            shutil.copyfile(source / "checkpoint.pt", pending / "best.pt")
            shutil.copyfile(output / "settings.json", pending / "settings.json")
            checked(pending / "best.pt", manifest["checkpoint_sha256"])
            _atomic_json(pending / "manifest.json", {"source_manifest_sha256": _sha256(source / "manifest.json"),
                "files": {name: _sha256(pending / name) for name in ("best.pt", "settings.json")},
                "code_sha256": config["code_sha256"], "config_sha256": config_sha})
            pending.rename(destination)
    checked(destination / "best.pt", manifest["checkpoint_sha256"])
    checked(destination / "settings.json", _sha256(output / "settings.json"))
    candidate_manifest = read(destination / "manifest.json")
    if (candidate_manifest["config_sha256"] != config_sha
            or candidate_manifest["source_manifest_sha256"] != _sha256(source / "manifest.json")):
        raise ValueError("Existing selected candidate belongs to a different run.")
    losses = manifest["fixed_reference_validation_loss"]
    passed = bool(losses) and all(losses[lang] < config["pilot_300m_reference"][lang] for lang in ("ar", "en"))
    receipt = {"phase": 3, "status": "awaiting_continuation_probe_review" if passed else "stopped_at_failed_loss_gate",
        "foundation_loss_gate_passed": passed, "candidate_checkpoint_sha256": manifest["checkpoint_sha256"],
        "best_checkpoint_positions": point, "processed_positions": result["processed_tokens"],
        "language_tokens": result["language_tokens"], "selected_shape": config["shape"],
        "validation": losses, "pilot_300m_reference": config["pilot_300m_reference"],
        "raw_continuation_probe_judged": False, "gate3_passed": None,
        "config_sha256": config_sha, "ready_for_chat": False, "phone_activated": False, "holdout_accessed": False}
    if (CAMPAIGN / "assessment.json").exists() and read(CAMPAIGN / "assessment.json") != receipt:
        raise ValueError("Existing full-run assessment differs; never overwrite it.")
    _atomic_json(CAMPAIGN / "assessment.json", receipt)
    return receipt


def execute(config_sha, *, resume=False, smoke=False, hold_after_smoke=False):
    import torch
    config, prep, sampler, model = check(config_sha)
    output = RUN / config["shape"]
    if output.exists() != resume:
        raise ValueError("Resume is required exactly when the full-run output already exists.")
    if resume and read(output / "status.json")["status"] in ("completed", "early_stopped"):
        raise ValueError("Full foundation run has already finished.")
    attempt = Path(tempfile.mkdtemp(prefix="attempt-", dir=CAMPAIGN))
    tokenizer = TextEncoder(RUN).tokenizer
    development = FrozenEnglishDevelopment(PREP / "splits/frozen-v4", prep["sha256"]["splits/frozen-v4/manifest.json"],
        pad_token_id=tokenizer.pad_token_id, eos_token_id=tokenizer.eos_token_id)
    packed = read(PREP / "packed/streams/manifest.json")
    pilot = PilotSettings(model, (ROOT / prep["fixed_validation"]["ar"]["path"]).parent, MILESTONES, INTERVAL,
        attempt, config_sha, config["code_sha256"], lr_decay_tokens=TARGET,
        comparison=ComparisonSettings(sampler, development, {"stage": 3, "view": "existing",
            "mix": "simplewiki_enriched", "seed": 1729, "prep_sha256": config["prep_sha256"],
            "full_sampling_receipts": config["sampling_receipts"]}))
    result = failure = None
    torch.set_num_threads(4)
    awake = ctypes.windll.kernel32.SetThreadExecutionState
    if not awake(0x80000001):
        raise RuntimeError("Windows could not reserve system wakefulness.")
    try:
        # Trainer minutes include previous attempts and are rounded to two decimals.
        prior_seconds = read(output / "status.json")["minutes"] * 60 + 1 if resume else 0
        remaining_seconds = config["runtime_limit_seconds"] - prior_seconds
        if remaining_seconds <= 0:
            raise RuntimeError("The cumulative 72-hour full-run budget is exhausted.")
        with GpuJob(ROOT, attempt, stage="3-full-foundation", max_seconds=remaining_seconds) as guard:
            torch.empty(1, device="cuda")
            guard.start_monitor()
            result = adapt(RUN, corpus=(ROOT / packed["arabic_training"]["path"]).parent,
                out_name=config["shape"], total_tokens=TARGET, sequence=512, microbatch=2, accumulation=8,
                peak_lr=config["peak_lr"], warmup=config["warmup"], arabic_fraction=0.5, seed=1729,
                device="cuda", resume=resume, max_minutes=1e-12 if smoke else None, pilot=pilot, guard=guard,
                early_stop_flat_tokens=config["early_stop_flat_tokens"])
        if result["status"] in ("completed", "early_stopped"):
            publish_candidate(config, config_sha, result)
        return result
    except BaseException as error:
        failure = f"{type(error).__name__}: {error}"
        raise
    finally:
        awake(0x80000000)
        _atomic_json(attempt / "manifest.json", {"stage": 3, "resumed": resume, "smoke": smoke,
            "config_sha256": config_sha, "end_time": datetime.now(timezone.utc).isoformat(),
            "files": {path.relative_to(attempt).as_posix(): _sha256(path) for path in attempt.rglob("*") if path.is_file()},
            "result": result, "failure": failure})
        if hold_after_smoke and result and result["status"] == "paused_time_limit":
            _atomic_json(CAMPAIGN / "smoke-committed.json", {"positions": result["processed_tokens"],
                "step": result["step"], "config_sha256": config_sha, "gpu_lock_released": True})
            # Parent terminates this live process after checking its committed checkpoint.
            threading.Event().wait()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "check", "run", "export"))
    parser.add_argument("--config-sha256")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--hold-after-smoke", action="store_true")
    args = parser.parse_args()
    if args.action == "prepare":
        result = prepare()
    elif not args.config_sha256:
        parser.error("check/run require --config-sha256")
    elif args.action == "check":
        config, _, _, _ = check(args.config_sha256)
        result = {"passed": True, "shape": config["shape"], "target_positions": TARGET, "gpu_started": False}
    elif args.action == "export":
        config, _, _, _ = check(args.config_sha256)
        result = publish_candidate(config, args.config_sha256, read(RUN / config["shape"] / "status.json"))
    else:
        result = execute(args.config_sha256, resume=args.resume, smoke=args.smoke, hold_after_smoke=args.hold_after_smoke)
    print(json.dumps(result, indent=2, ensure_ascii=False))
