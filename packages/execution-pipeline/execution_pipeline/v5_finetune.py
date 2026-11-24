"""Plan v5 stage V5-3 (docs/CHAT-MODEL-TRAINING-PLAN.md section 8.4): answer-only chat fine-tuning.

v4's Stage 5 runner, re-bound to the v5 foundation. It keeps that runner's trainer, fixed Gate 0 parameters, data and
QA validators and sealed-holdout guard, and changes what the base must be: v5 has no Stage 4 (its foundation is
already half conversation), so training starts from the exact checkpoint that passed Gate 3. Preparing and checking
read pinned evidence only. Running also holds the owner's shared `.data/gpu.lock`. The smoke action runs two CPU
updates on a few rows to prove the code path on a real v5 checkpoint; it is not a training run and unlocks nothing.
No evaluation replies, holdout reads or activation happen here.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
from typing import Any

from . import REPOSITORY_ROOT
from . import stage5_finetune as stage5
from .ads_finetune import finetune
from .chat_diagnostics import GpuJob


PARAMETERS = stage5.PARAMETERS
CODE_PATHS = (
    "packages/execution-pipeline/execution_pipeline/v5_finetune.py",
    "packages/execution-pipeline/scripts/v5_finetune.py",
    *stage5.CODE_PATHS,
)
# v4 sized Stage 5 at under 4 hours for 38M; the 85M shape gets twice that ceiling.
RUNTIME_LIMIT_SECONDS = 8 * 3600
SHARED_GPU_LOCK = Path(".data/gpu.lock")


@contextmanager
def shared_gpu_lock(root: Path, purpose: str):
    """The owner's one-job rule for every GPU user; a held lock stops this run instead of waiting."""
    lock = root / SHARED_GPU_LOCK
    lock.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        raise RuntimeError(f"The GPU is held by another job: {lock.read_text(encoding='utf-8').strip()}") from None
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump({"owner": "Claude Code, own chat model v5 (packages/execution-pipeline)", "purpose": purpose,
                   "pid": os.getpid(), "started": datetime.now(timezone.utc).isoformat()}, handle)
    try:
        yield
    finally:
        lock.unlink(missing_ok=True)


def _gate_evidence(protocol: dict[str, Any], root: Path) -> dict[str, Any]:
    """Refuse an unpassed Gate 3, another base, or unapproved data before any GPU lock is taken."""
    validated = stage5.verify_gate3(Path(protocol["gate3"]["path"]), protocol["gate3"]["sha256"], root=root)
    gate3 = validated["gate3"]
    if gate3.get("candidate_checkpoint_sha256") != protocol["base_checkpoint"]["sha256"]:
        raise ValueError("V5-3 must start from the exact checkpoint that passed Gate 3.")
    verified = stage5.verify_eligibility(Path(protocol["eligibility"]["path"]), protocol["eligibility"]["sha256"],
                                         protocol["qa"], dataset_dir=Path(protocol["dataset_dir"]), root=root)
    if verified["data_dir"] != Path(protocol["dataset_dir"]) or verified["dataset"] != protocol["dataset"]:
        raise ValueError("Gate evidence and training protocol refer to different datasets.")
    if verified["manifest"].get("tokenizer_sha256") != protocol["tokenizer"]["tokenizer.json"]["sha256"]:
        raise ValueError("Dataset eligibility was audited under a different tokenizer SHA-256.")
    return {"gate3": gate3, "generation": validated["generation"], **verified}


def prepare(*, run: Path, base_checkpoint: Path, base_sha256: str, out_name: str, campaign: Path,
            dataset_dir: Path, gate3: Path, gate3_sha256: str, eligibility: Path, eligibility_sha256: str,
            qa: list[tuple[Path, str]], root: Path = REPOSITORY_ROOT) -> dict[str, Any]:
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", out_name) or out_name in {".", ".."}:
        raise ValueError("Output name must be a plain new directory name.")
    run, campaign, dataset_dir = (stage5._safe(path, root) for path in (run, campaign, dataset_dir))
    base = stage5._safe(run / base_checkpoint, root)
    if not base.is_relative_to(run) or base.name != "best.pt":
        raise ValueError("The V5-3 base must be a pinned best.pt inside its run.")
    if (run / out_name).exists():
        raise FileExistsError("V5-3 training output already exists; never overwrite it.")
    protocol = {"schemaVersion": 1, "stage": "v5-3", "prepared_at": stage5._now(), "run": str(run),
        "out_name": out_name, "campaign": str(campaign), "dataset_dir": str(dataset_dir),
        "base_checkpoint": stage5._pin(base, root, base_sha256), "base_settings": stage5._pin(base.parent / "settings.json", root),
        "tokenizer": {name: stage5._pin(run / name, root) for name in ("tokenizer.json", "tokenizer-report.json")},
        "dataset": {name: stage5._pin(dataset_dir / filename, root)
                    for name, filename in (("manifest", "manifest.json"), ("train", "train.jsonl"), ("validation", "validation.jsonl"))},
        "gate3": stage5._pin(gate3, root, gate3_sha256), "eligibility": stage5._pin(eligibility, root, eligibility_sha256),
        "qa": [stage5._pin(path, root, digest) for path, digest in qa],
        "code": {name: stage5._pin(root / name, root) for name in CODE_PATHS},
        "parameters": PARAMETERS, "selection_metric": "macro_language_answer_loss", "device": "cuda",
        "runtime_limit_seconds": RUNTIME_LIMIT_SECONDS, "ready_for_chat": False, "phone_activated": False,
        "independent_test": False}
    if stage5._read(base.parent / "settings.json").get("prompt_hint") is not None:
        raise ValueError("The base must use the unchanged chat format with no name hint.")
    _gate_evidence(protocol, root)
    campaign.mkdir(parents=True, exist_ok=False)
    stage5._new_json(campaign / "protocol.json", protocol)
    return {"status": "prepared", "protocol": str(campaign / "protocol.json"),
            "protocol_sha256": stage5.sha256(campaign / "protocol.json"), "gpu_started": False}


def check(protocol_path: Path, protocol_sha256: str, *, root: Path = REPOSITORY_ROOT) -> dict[str, Any]:
    protocol_path = stage5._safe(protocol_path, root)
    stage5._pin(protocol_path, root, protocol_sha256)
    protocol = stage5._read(protocol_path)
    if (protocol.get("schemaVersion") != 1 or protocol.get("stage") != "v5-3"
            or protocol.get("parameters") != PARAMETERS or protocol.get("device") != "cuda"
            or protocol.get("runtime_limit_seconds") != RUNTIME_LIMIT_SECONDS
            or protocol.get("selection_metric") != "macro_language_answer_loss"
            or any(protocol.get(key) is not False for key in ("ready_for_chat", "phone_activated", "independent_test"))
            or stage5._safe(Path(protocol["campaign"]), root) != protocol_path.parent.resolve()):
        raise ValueError("Unexpected or changed V5-3 protocol.")
    run, dataset = Path(protocol["run"]), Path(protocol["dataset_dir"])
    name = protocol["out_name"]
    base = stage5._safe(Path(protocol["base_checkpoint"]["path"]), root)
    if (not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", name) or name in {".", ".."}
            or not base.is_relative_to(run) or base.name != "best.pt"
            or stage5._safe(Path(protocol["base_settings"]["path"]), root) != base.parent / "settings.json"
            or set(protocol["code"]) != set(CODE_PATHS)
            or set(protocol["tokenizer"]) != {"tokenizer.json", "tokenizer-report.json"}):
        raise ValueError("V5-3 checkpoint or source paths changed.")
    for key, filename in (("manifest", "manifest.json"), ("train", "train.jsonl"), ("validation", "validation.jsonl")):
        if stage5._safe(Path(protocol["dataset"][key]["path"]), root) != dataset / filename:
            raise ValueError("Dataset pin points outside the declared split.")
    for filename, pin in protocol["tokenizer"].items():
        if stage5._safe(Path(pin["path"]), root) != run / filename:
            raise ValueError("Tokenizer pin points outside its run.")
    for filename, pin in protocol["code"].items():
        if stage5._safe(Path(pin["path"]), root) != (root / filename).resolve():
            raise ValueError("Source pin points outside its declared file.")
    for pin in [protocol["base_checkpoint"], protocol["base_settings"], *protocol["tokenizer"].values(),
                *protocol["dataset"].values(), *protocol["code"].values(), protocol["gate3"],
                protocol["eligibility"], *protocol["qa"]]:
        stage5._verify_pin(pin, root)
    if stage5._read(base.parent / "settings.json").get("prompt_hint") is not None:
        raise ValueError("The base must not change the chat format with a name hint.")
    _gate_evidence(protocol, root)
    return protocol


def run(protocol_path: Path, protocol_sha256: str, *, root: Path = REPOSITORY_ROOT) -> dict[str, Any]:
    protocol = check(protocol_path, protocol_sha256, root=root)
    campaign = Path(protocol["campaign"])
    output = Path(protocol["run"]) / protocol["out_name"]
    if output.exists() or any((campaign / name).exists() for name in ("started.json", "selection.json", "failure.json")):
        raise FileExistsError("This V5-3 attempt already exists; never overwrite or silently retry it.")
    stage5._new_json(campaign / "started.json", {"started_at": stage5._now(), "protocol_sha256": protocol_sha256})
    awake = False
    try:
        if not stage5._awake(0x80000001):
            raise RuntimeError("Windows could not reserve system wakefulness.")
        awake = True
        with shared_gpu_lock(root, "v5-3 chat fine-tuning"), \
                GpuJob(root, campaign, stage="v5-3-dialogue-finetune", max_seconds=protocol["runtime_limit_seconds"]) as guard:
            stage5._cuda_start(guard)
            guard.start_training("v5-3-dialogue-finetune")
            result = finetune(Path(protocol["run"]), out_name=protocol["out_name"],
                data_dir=Path(protocol["dataset_dir"]), device="cuda",
                base_checkpoint=Path(protocol["base_checkpoint"]["path"]).relative_to(Path(protocol["run"])),
                progress_check=guard.check, training_update=guard.record_training_update, **PARAMETERS)
            guard.check()
        check(protocol_path, protocol_sha256, root=root)
        if result.get("status") not in {"completed", "early_stopped"}:
            raise ValueError("V5-3 did not finish successfully.")
        best = stage5._pin(output / "best.pt", root, result["best_checkpoint_sha256"])
        if result.get("validation_selection_metric") != "macro_language_answer_loss":
            raise ValueError("V5-3 selection must use balanced macro-language answer loss.")
        receipt = {"schemaVersion": 1, "stage": "v5-3", "status": "awaiting_gate5_development_evaluation",
            "completed_at": stage5._now(), "protocol": stage5._pin(protocol_path, root, protocol_sha256),
            "selected_checkpoint": best, "checkpoint_selection": "best_validation_only",
            "best_step": result["best_step"], "best_validation_metrics": result.get("best_validation_metrics"),
            "settings": stage5._pin(output / "settings.json", root), "training_status": stage5._pin(output / "status.json", root),
            "dataset": protocol["dataset"], "gate3": protocol["gate3"], "eligibility": protocol["eligibility"],
            "code": protocol["code"], "result": result, "gate5_passed": None, "ready_for_chat": False,
            "phone_activated": False, "independent_test": False}
        stage5._new_json(campaign / "selection.json", receipt)
        return receipt
    except BaseException as error:
        stage5._new_json(campaign / "failure.json", {"failed_at": stage5._now(), "protocol_sha256": protocol_sha256,
                         "error": f"{type(error).__name__}: {error}"[:600], "ready_for_chat": False})
        raise
    finally:
        if awake:
            stage5._awake(0x80000000)


def smoke(*, run: Path, base_checkpoint: Path, dataset_dir: Path, rows: int = 16, steps: int = 2,
          root: Path = REPOSITORY_ROOT) -> dict[str, Any]:
    """Two CPU updates on a few rows from a real checkpoint, into a new smoke folder; proves the path only."""
    run = stage5._safe(run, root)
    dataset_dir = stage5._safe(dataset_dir, root)
    out_name = "smoke-v5-3-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    smoke_parameters = {**PARAMETERS, "epochs": 1, "eval_every": 1, "warmup": 1}
    result = finetune(run, out_name=out_name, data_dir=dataset_dir, device="cpu", base_checkpoint=base_checkpoint,
                      limit=rows, max_steps=steps, **smoke_parameters)
    return {"status": result.get("status"), "out_name": out_name, "steps": result.get("steps"),
            "best_validation_metrics": result.get("best_validation_metrics"), "gpu_used": False,
            "unlocks_nothing": True}
