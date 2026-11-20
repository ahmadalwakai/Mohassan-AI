"""Run one pinned, guarded Stage 2 foundation pilot shape at a time."""
from __future__ import annotations

import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from . import REPOSITORY_ROOT
from .ads_finetune import _atomic_json, _sha256
from .chat_diagnostics import GpuJob
from .language_adaptation import PilotSettings, adapt
from execution_model.config import ModelConfig


def run_pilot(config_path: Path, expected_sha256: str, shape: str, *, resume: bool = False,
              max_minutes: float | None = None) -> dict:
    import torch

    config_path = config_path.resolve()
    if _sha256(config_path) != expected_sha256:
        raise ValueError("Pilot configuration does not match the authorized SHA-256.")
    config = json.loads(config_path.read_text(encoding="utf-8"))
    if config["stage"] != 2 or shape not in config["shapes"]:
        raise ValueError("Choose a shape from the pinned Stage 2 configuration.")
    for filename, sha256 in (config["code_sha256"] | config["input_sha256"]).items():
        if _sha256(REPOSITORY_ROOT / filename) != sha256:
            raise ValueError(f"Pinned pilot file changed: {filename}")

    selected = config["shapes"][shape]
    model = ModelConfig.from_dict(selected["model_config"])
    if model.identity != selected["config_identity"]:
        raise ValueError("Pinned pilot model config identity does not match.")
    run = REPOSITORY_ROOT / config["run"]
    output = run / shape
    if output.exists() != resume:
        raise ValueError("Use resume only for a pilot shape already started in this run.")
    milestones = tuple(selected["token_milestones"])
    attempts = config_path.parent / shape
    attempts.mkdir(exist_ok=True)
    attempt = Path(tempfile.mkdtemp(prefix="attempt-", dir=attempts))
    pilot = PilotSettings(model=model, reference=REPOSITORY_ROOT / config["reference"], milestones=milestones,
                          checkpoint_every_tokens=config["checkpoint_every_tokens"], attempt_output=attempt,
                          config_sha256=expected_sha256, code_sha256=config["code_sha256"],
                          lr_decay_tokens=config["lr_decay_tokens"])
    torch.set_num_threads(4)
    result = None
    failure = None
    try:
        with GpuJob(REPOSITORY_ROOT, attempt, stage="2", max_seconds=config["job_runtime_limit_seconds"]) as guard:
            torch.empty(1, device="cuda")
            guard.start_monitor()
            result = adapt(run, corpus=REPOSITORY_ROOT / config["corpus"], out_name=shape, total_tokens=milestones[-1],
                           sequence=config["sequence"], microbatch=config["microbatch"], accumulation=config["accumulation"],
                           peak_lr=config["peak_lr"], warmup=config["warmup"], arabic_fraction=0.5, seed=model.seed,
                           device="cuda", resume=resume, max_minutes=max_minutes, pilot=pilot, guard=guard)
        return result
    except (Exception, KeyboardInterrupt) as error:
        failure = f"{type(error).__name__}: {error}"
        raise
    finally:
        files = {path.name: _sha256(path) for path in attempt.iterdir() if path.is_file()}
        status = output / "status.json"
        _atomic_json(attempt / "manifest.json", {"stage": 2, "shape": shape, "resumed": resume,
            "end_time": datetime.now(timezone.utc).isoformat(), "config_sha256": expected_sha256,
            "files": files, "result": result, "failure": failure,
            "trainer_status_sha256": _sha256(status) if status.is_file() else None})
