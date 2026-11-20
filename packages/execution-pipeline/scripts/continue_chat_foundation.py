"""Continue the selected v4 comparison checkpoint as a separate 300M experiment."""
from __future__ import annotations

import argparse
import ctypes
import json
from pathlib import Path
import shutil
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline import REPOSITORY_ROOT as ROOT
from execution_pipeline.ads_finetune import _atomic_json, _sha256
from execution_pipeline.chat_diagnostics import GpuJob
from execution_pipeline.comparison_continuation import (
    ANCHOR_POSITIONS, MILESTONES, TARGET_POSITIONS, TARGET_UPDATES, FoundationContinuationSampler,
)
from execution_pipeline.comparison_eval import FrozenEnglishDevelopment
from execution_pipeline.foundation_comparison import APPROVED_PREPARATION, APPROVED_PREPARATION_SHA256, MODEL_RUN
from execution_pipeline.language_adaptation import ComparisonAnchor, ComparisonSettings, PilotSettings, adapt
from execution_pipeline.pretrain import TextEncoder
from execution_model.config import ModelConfig


PREP = ROOT / APPROVED_PREPARATION
COMPARISON_RUN = ROOT / MODEL_RUN
CAMPAIGN = ROOT / "artifacts/chat-training/v4/gate2-continuation-20261118"
RUN = COMPARISON_RUN.parent / "gate2-continuation-20261118"
OUT_NAME = "38m"
ANCHOR = COMPARISON_RUN / "existing-simplewiki_enriched-1729/checkpoints/tokens-000100000000/checkpoint.pt"
ANCHOR_SHA = "c5c30f7aa66ff1ab34988f5ecaef5675b0fb959dbd259dd04785a9916724391e"
HISTORICAL = {"ar": 3.26357, "en": 3.20447}


def read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def checked(path: Path, expected: str) -> None:
    if _sha256(path) != expected:
        raise ValueError(f"SHA-256 mismatch: {path}")


def inputs(receipt: dict | None):
    checked(PREP / "manifest.json", APPROVED_PREPARATION_SHA256)
    preparation = read(PREP / "manifest.json")
    for path, digest in preparation["sha256"].items():
        checked(PREP / path, digest)
    for item in preparation["fixed_validation"].values():
        checked(ROOT / item["path"], item["sha256"])
    checked(ANCHOR, ANCHOR_SHA)
    anchor = read(ANCHOR.parent / "manifest.json")
    prefix = anchor["settings"]
    if (anchor["checkpoint_sha256"] != ANCHOR_SHA or anchor["tokens"] != ANCHOR_POSITIONS
            or not anchor["exact_evaluation_milestone"] or prefix["comparison"]["prep_sha256"] != APPROVED_PREPARATION_SHA256
            or prefix["learning_rate_decay_tokens"] != TARGET_POSITIONS):
        raise ValueError("Selected checkpoint is not the completed, scheduled 100M anchor.")
    checked(COMPARISON_RUN / "tokenizer.json", prefix["tokenizer_sha256"])
    checked(COMPARISON_RUN / "tokenizer-report.json", prefix["tokenizer_report_sha256"])
    checked(Path(prefix["corpus"]) / "manifest.json", prefix["corpus_manifest_sha256"])
    checked(Path(prefix["reference_corpus"]) / "manifest.json", prefix["reference_corpus_manifest_sha256"])
    allocation = read(PREP / "budgets/allocation.json")
    sampler = FoundationContinuationSampler(PREP, allocation,
        verifier_sha256=anchor["code_sha256"][f"{APPROVED_PREPARATION}/budgets/verify.py"], expected_receipt=receipt)
    if sampler.planned_receipt(ANCHOR_POSITIONS) != anchor["comparison_sampling_receipt"]:
        raise ValueError("Continuation schedule does not match the original checkpoint's sampling receipt.")
    sampler.seek(ANCHOR_POSITIONS, anchor["step"])
    return preparation, anchor, sampler


def prepare() -> None:
    _, anchor, sampler = inputs(None)
    files = set(anchor["code_sha256"]) | {
        Path(__file__).resolve().relative_to(ROOT).as_posix(),
        "packages/execution-pipeline/execution_pipeline/comparison_continuation.py",
    }
    code = {file: _sha256(ROOT / file) for file in sorted(files) if not file.startswith("artifacts/")}
    CAMPAIGN.mkdir()
    RUN.mkdir()
    for filename in ("tokenizer.json", "tokenizer-report.json"):
        shutil.copyfile(COMPARISON_RUN / filename, RUN / filename)
    config = CAMPAIGN / "config.json"
    _atomic_json(config, {"code_sha256": code, "prep_sha256": APPROVED_PREPARATION_SHA256,
        "anchor_sha256": ANCHOR_SHA, "anchor_manifest_sha256": _sha256(ANCHOR.parent / "manifest.json"),
        "target_positions": TARGET_POSITIONS, "target_updates": TARGET_UPDATES,
        "target_sampling_receipt": sampler.planned_receipt(TARGET_POSITIONS), "historical_reference": HISTORICAL})
    print(json.dumps({"config": str(config), "sha256": _sha256(config), "anchor_step": anchor["step"],
                      "start_validation": anchor["fixed_reference_validation_loss"], "target_updates": TARGET_UPDATES}, indent=2))


def execute(config_sha: str, *, resume: bool) -> None:
    import torch

    config_path = CAMPAIGN / "config.json"
    checked(config_path, config_sha)
    config = read(config_path)
    for filename, digest in config["code_sha256"].items():
        checked(ROOT / filename, digest)
    checked(ANCHOR.parent / "manifest.json", config["anchor_manifest_sha256"])
    preparation, anchor, sampler = inputs(config["target_sampling_receipt"])
    if (RUN / OUT_NAME).exists() != resume:
        raise ValueError("Resume requires the existing continuation output directory.")
    status_path = RUN / OUT_NAME / "status.json"
    if resume and status_path.is_file() and read(status_path)["status"] == "completed":
        raise ValueError("Continuation is already complete.")
    attempt = Path(tempfile.mkdtemp(prefix="attempt-", dir=CAMPAIGN))
    prefix = anchor["settings"]
    checked(RUN / "tokenizer.json", prefix["tokenizer_sha256"])
    checked(RUN / "tokenizer-report.json", prefix["tokenizer_report_sha256"])
    tokenizer = TextEncoder(RUN).tokenizer
    development = FrozenEnglishDevelopment(PREP / "splits/frozen-v4",
        preparation["sha256"]["splits/frozen-v4/manifest.json"], pad_token_id=tokenizer.pad_token_id,
        eos_token_id=tokenizer.eos_token_id)
    comparison = ComparisonSettings(sampler, development, {"prefix": prefix["comparison"],
        "anchor_sha256": ANCHOR_SHA, "target_sampling_receipt": config["target_sampling_receipt"]},
        anchor=ComparisonAnchor(ANCHOR, ANCHOR_SHA, ANCHOR_POSITIONS))
    pilot = PilotSettings(ModelConfig.from_dict(anchor["config"]), Path(prefix["reference_corpus"]), MILESTONES,
        prefix["checkpoint_every_tokens"], attempt, config_sha, config["code_sha256"],
        lr_decay_tokens=prefix["learning_rate_decay_tokens"], comparison=comparison)
    result = None
    failure = None
    torch.set_num_threads(4)
    awake = ctypes.windll.kernel32.SetThreadExecutionState
    if not awake(0x80000001):
        raise RuntimeError("Windows could not reserve system wakefulness for this training process.")
    try:
        with GpuJob(ROOT, attempt, stage="2-enriched-continuation", max_seconds=72 * 3600) as guard:
            torch.empty(1, device="cuda")
            guard.start_monitor()
            result = adapt(RUN, corpus=Path(prefix["corpus"]), out_name=OUT_NAME, total_tokens=TARGET_POSITIONS,
                sequence=prefix["sequence"], microbatch=prefix["microbatch"], accumulation=prefix["accumulation"],
                peak_lr=prefix["peak_lr"], warmup=prefix["warmup"], arabic_fraction=prefix["arabic_fraction"],
                seed=prefix["seed"], device="cuda", resume=resume, pilot=pilot, guard=guard)
        if result["status"] == "completed":
            if result["processed_tokens"] != TARGET_POSITIONS or result["step"] != TARGET_UPDATES:
                raise ValueError("Continuation missed the pinned position or optimizer update count.")
            start = anchor["fixed_reference_validation_loss"]
            end = result["last_validation"]
            passed = all(end[language] < min(start[language], HISTORICAL[language]) for language in HISTORICAL)
            _atomic_json(CAMPAIGN / "assessment.json", {"phase": 2, "passed_fixed_reference_check": passed,
                "selected_arm_only": True, "reference_100m": start, "reference_300m": end,
                "historical_reference": HISTORICAL, "larger_shape_comparison_completed": False,
                "chat_readiness_tested": False, "authorization_for_stage_3": False})
        print(json.dumps(result, indent=2))
    except BaseException as error:
        failure = f"{type(error).__name__}: {error}"
        raise
    finally:
        awake(0x80000000)
        files = {path.relative_to(attempt).as_posix(): _sha256(path) for path in attempt.rglob("*") if path.is_file()}
        _atomic_json(attempt / "manifest.json", {"config_sha256": config_sha, "resume": resume, "files": files,
            "failure": failure, "result": result})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "run"))
    parser.add_argument("--config-sha256")
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    if args.action == "prepare":
        prepare()
    elif args.config_sha256:
        execute(args.config_sha256, resume=args.resume)
    else:
        parser.error("run requires --config-sha256")
