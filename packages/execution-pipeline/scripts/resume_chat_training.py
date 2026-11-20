"""Resume the full foundation from its committed checkpoint, then generate Gate 3 probes.

Same steps as complete_chat_training.py after its restart smoke; settings unchanged.
Each call writes new child logs (resume-N) and the shared completion status.
"""
from __future__ import annotations

import ctypes
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import complete_chat_training as base  # noqa: E402
from execution_pipeline.ads_finetune import _sha256  # noqa: E402

OUT, FULL, FULL_RUN, ROOT = base.OUT, base.FULL, base.FULL_RUN, base.ROOT


def main():
    if (OUT / "supervisor.lock").exists() or (ROOT / "artifacts/chat-training/v4/gpu.lock").exists():
        raise RuntimeError("A supervisor or GPU job is already active.")
    with (OUT / "supervisor.lock").open("x", encoding="utf-8") as stream:
        json.dump({"pid": os.getpid(), "started": datetime.now(timezone.utc).isoformat(), "resume": True}, stream)
    attempt = 1
    while (OUT / f"full-training-resume{attempt}.stdout.log").exists():
        attempt += 1
    awake = ctypes.windll.kernel32.SetThreadExecutionState
    awake(0x80000001)
    try:
        full_sha = _sha256(FULL / "config.json")
        shape = base.read(FULL / "config.json")["shape"]
        trainer_status = FULL_RUN / shape / "status.json"
        if base.read(trainer_status)["status"] not in ("completed", "early_stopped"):
            base.run_child(f"full-training-resume{attempt}", base.command("train_full_foundation.py", "run",
                "--config-sha256", full_sha, "--resume"), "full_foundation_running", trainer_status)
        losses = []
        for log_path in FULL.glob("attempt-*/log.jsonl"):
            for line in log_path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    point = json.loads(line)
                    if "train_loss" in point:
                        losses.append(point["train_loss"])
        if not losses or not all(math.isfinite(value) for value in losses):
            raise ValueError("Non-finite or missing training loss in the full foundation logs.")
        assessment = base.read(FULL / "assessment.json")
        if not assessment["foundation_loss_gate_passed"]:
            base.status("stopped_at_failed_gate3_loss", assessment=str(FULL / "assessment.json"))
            return
        base.status("preparing_gate3_probes")
        probe_output = ROOT / "artifacts/chat-training/v4/probes/gate3-generation-20261118"
        protocol = probe_output / "protocol.json"
        if not protocol.exists():
            base.run_child(f"probes-prepare-r{attempt}", base.command("gate3_probes.py", "prepare", "--run", FULL_RUN,
                "--finetune", "selected", "--checkpoint-sha256", assessment["candidate_checkpoint_sha256"],
                "--output", probe_output, "--device", "cuda"), "preparing_gate3_probes")
        base.run_child(f"probes-generate-r{attempt}", base.command("gate3_probes.py", "predict", "--protocol", protocol,
            "--protocol-sha256", _sha256(protocol)), "generating_gate3_probes")
        base.status("awaiting_gate3_semantic_review", predictions=str(probe_output / "predictions.jsonl"),
            foundation_assessment=str(FULL / "assessment.json"),
            next_step="Role C judges the 20 frozen raw continuations per language before adaptation or fine-tuning.")
    except BaseException as error:
        base.status("stopped_with_error", error=f"{type(error).__name__}: {error}")
        raise
    finally:
        awake(0x80000000)
        lock = OUT / "supervisor.lock"
        if lock.exists() and base.read(lock).get("pid") == os.getpid():
            lock.unlink()


if __name__ == "__main__":
    main()
