"""Supervise the remaining size pilot and full foundation with durable status.

This runs one GPU child at a time, preserves all checkpoints, and stops at a
failed gate or at the semantic Gate 3 review. It never accesses the holdout.
"""
from __future__ import annotations

import ctypes
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline import REPOSITORY_ROOT as ROOT
from execution_pipeline.ads_finetune import _atomic_json, _sha256
from execution_pipeline.shape_comparison import CAMPAIGN as SHAPE_CAMPAIGN, RUN as SHAPE_RUN

OUT = ROOT / "artifacts/chat-training/v4/completion-20261118"
FULL = ROOT / "artifacts/chat-training/v4/stage-3-full-20261118"
FULL_RUN = ROOT / "artifacts/execution-model-runs/text-b4-2026-11-18/stage-3-full"
SCRIPTS = ROOT / "packages/execution-pipeline/scripts"
SHAPE_SHA = "6dce3b4b069a5c71006e261ed343409427f106b738f513e0bb658bd3982c68a6"


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def status(phase, **extra):
    value = {"phase": phase, "updated_at": datetime.now(timezone.utc).isoformat(), "pid": os.getpid(),
        "ready_for_chat": False, "phone_activated": False, "holdout_accessed": False, **extra}
    _atomic_json(OUT / "status.json", value)
    print(json.dumps(value), flush=True)


def command(script, *arguments):
    return [sys.executable, "-u", str(SCRIPTS / script), *map(str, arguments)]


def start_child(name, args):
    stdout = (OUT / f"{name}.stdout.log").open("x", encoding="utf-8")
    stderr = (OUT / f"{name}.stderr.log").open("x", encoding="utf-8")
    try:
        child = subprocess.Popen(args, cwd=ROOT, stdout=stdout, stderr=stderr,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    finally:
        stdout.close()
        stderr.close()
    return child


def wait_child(child, phase, trainer_status=None):
    last_emit = 0
    while child.poll() is None:
        if time.monotonic() - last_emit >= 60:
            progress = {}
            if trainer_status and trainer_status.is_file():
                recorded = read(trainer_status)
                progress = {key: recorded.get(key) for key in ("status", "step", "processed_tokens", "minutes", "last_validation")}
            status(phase, child_pid=child.pid, progress=progress)
            last_emit = time.monotonic()
        time.sleep(2)
    if child.returncode:
        raise RuntimeError(f"{phase} exited with code {child.returncode}; inspect its stderr log.")


def run_child(name, args, phase, trainer_status=None):
    child = start_child(name, args)
    wait_child(child, phase, trainer_status)


def smoke_checkpoint(shape):
    import torch
    output = FULL_RUN / shape
    entries = sorted((output / "checkpoints").glob("tokens-*/manifest.json"))
    if not entries:
        raise ValueError("No committed optimizer checkpoint was found.")
    manifest = read(entries[-1])
    checkpoint = entries[-1].parent / "checkpoint.pt"
    if _sha256(checkpoint) != manifest["checkpoint_sha256"]:
        raise ValueError("Smoke checkpoint differs from its committed manifest.")
    state = torch.load(checkpoint, map_location="cpu", weights_only=True)
    if (state["processed_tokens"] <= 0 or not state["optimizer_state"]["state"]
            or state["language_tokens"]["ar"] != state["language_tokens"]["en"]):
        raise ValueError("Smoke did not commit a balanced optimizer update.")
    return {"path": checkpoint.relative_to(ROOT).as_posix(), "sha256": manifest["checkpoint_sha256"],
        "positions": state["processed_tokens"], "step": state["step"],
        "optimizer_steps": sorted({int(item["step"].item()) for item in state["optimizer_state"]["state"].values()}),
        "model_digest": _model_digest(state["model_state"])}


def _model_digest(state):
    import hashlib
    digest = hashlib.sha256()
    for name, tensor in sorted(state.items()):
        digest.update(name.encode())
        digest.update(tensor.contiguous().numpy().tobytes())
    return digest.hexdigest()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    if (OUT / "supervisor.lock").exists():
        raise RuntimeError("Completion supervisor lock already exists.")
    with (OUT / "supervisor.lock").open("x", encoding="utf-8") as stream:
        json.dump({"pid": os.getpid(), "started": datetime.now(timezone.utc).isoformat()}, stream)
    awake = ctypes.windll.kernel32.SetThreadExecutionState
    awake(0x80000001)
    try:
        # Root started the short size-pilot smoke before this supervisor.
        status("waiting_for_size_pilot_smoke")
        deadline = time.monotonic() + 1200
        while True:
            output = SHAPE_RUN / "85m/status.json"
            state = read(output) if output.is_file() else {}
            locked = (ROOT / "artifacts/chat-training/v4/gpu.lock").exists()
            if state.get("status") == "paused_time_limit" and not locked:
                break
            if state.get("status") in ("failed", "interrupted"):
                raise RuntimeError(f"Size pilot smoke stopped: {state.get('error')}")
            if time.monotonic() > deadline:
                raise TimeoutError("Size pilot smoke did not finish within 20 minutes.")
            time.sleep(2)
        _atomic_json(OUT / "size-smoke-evidence.json", {"status": state["status"], "step": state["step"],
            "positions": state["processed_tokens"], "config_sha256": SHAPE_SHA})
        run_child("size-pilot", command("compare_chat_shape.py", "run", "--config-sha256", SHAPE_SHA, "--resume"),
            "size_pilot_running", output)
        decision = read(SHAPE_CAMPAIGN / "assessment.json")
        if not decision["gate2_passed"]:
            status("stopped_at_failed_gate2", assessment=str(SHAPE_CAMPAIGN / "assessment.json"))
            return
        status("preparing_full_foundation", selected_shape=decision["selected_shape"])
        run_child("full-prepare", command("train_full_foundation.py", "prepare"), "preparing_full_foundation")
        full_sha = _sha256(FULL / "config.json")
        shape = read(FULL / "config.json")["shape"]
        trainer_status = FULL_RUN / shape / "status.json"
        child = start_child("full-smoke-before-kill", command("train_full_foundation.py", "run", "--config-sha256",
            full_sha, "--smoke", "--hold-after-smoke"))
        status("testing_checkpoint_restart", child_pid=child.pid)
        deadline = time.monotonic() + 1800
        while not (FULL / "smoke-committed.json").exists():
            if child.poll() is not None:
                raise RuntimeError("Full-run smoke exited before committing its checkpoint.")
            if time.monotonic() > deadline:
                raise TimeoutError("Full-run smoke did not commit within 30 minutes.")
            time.sleep(2)
        before = smoke_checkpoint(shape)
        # Only terminate our own smoke process tree, after its GPU lock is released.
        if (ROOT / "artifacts/chat-training/v4/gpu.lock").exists():
            raise RuntimeError("Smoke process still owns the GPU; restart test refused.")
        subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"], check=True,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW)
        child.wait(timeout=30)
        run_child("full-smoke-resumed", command("train_full_foundation.py", "run", "--config-sha256", full_sha,
            "--resume", "--smoke"), "testing_checkpoint_restart", trainer_status)
        after = smoke_checkpoint(shape)
        if (after["step"] != before["step"] + 1 or after["positions"] != before["positions"] + 8192
                or after["model_digest"] == before["model_digest"]
                or after["optimizer_steps"] != [after["step"]]):
            raise ValueError("Live optimizer/RNG restart smoke did not continue exactly one update.")
        _atomic_json(OUT / "restart-verification.json", {"process_killed_after_committed_checkpoint": True,
            "gpu_released_before_kill": True, "before": before, "after": after,
            "full_config_sha256": full_sha, "finite_loss_after_resume": None})
        run_child("full-training", command("train_full_foundation.py", "run", "--config-sha256", full_sha, "--resume"),
            "full_foundation_running", trainer_status)
        losses = []
        for log_path in FULL.glob("attempt-*/log.jsonl"):
            for line in log_path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    point = json.loads(line)
                    if "train_loss" in point and point["step"] >= 25:
                        losses.append(point)
        if not losses or not all(math.isfinite(point["train_loss"]) for point in losses):
            raise ValueError("No finite training loss after the checkpoint restart.")
        verification = read(OUT / "restart-verification.json")
        verification.update(finite_loss_after_resume=True, first_recorded_resumed_training_loss=losses[0]["train_loss"])
        _atomic_json(OUT / "restart-verification.json", verification)
        assessment = read(FULL / "assessment.json")
        if not assessment["foundation_loss_gate_passed"]:
            status("stopped_at_failed_gate3_loss", assessment=str(FULL / "assessment.json"))
            return
        status("preparing_gate3_probes")
        probe_output = ROOT / "artifacts/chat-training/v4/probes/gate3-generation-20261118"
        run_child("probes-prepare", command("gate3_probes.py", "prepare", "--run", FULL_RUN,
            "--finetune", "selected", "--checkpoint-sha256", assessment["candidate_checkpoint_sha256"],
            "--output", probe_output, "--device", "cuda"), "preparing_gate3_probes")
        protocol = probe_output / "protocol.json"
        run_child("probes-generate", command("gate3_probes.py", "predict", "--protocol", protocol,
            "--protocol-sha256", _sha256(protocol)), "generating_gate3_probes")
        status("awaiting_gate3_semantic_review", predictions=str(probe_output / "predictions.jsonl"),
            foundation_assessment=str(FULL / "assessment.json"),
            next_step="Role C judges the 20 frozen raw continuations per language before adaptation or fine-tuning.")
    except BaseException as error:
        status("stopped_with_error", error=f"{type(error).__name__}: {error}")
        raise
    finally:
        awake(0x80000000)
        lock = OUT / "supervisor.lock"
        if lock.exists() and read(lock).get("pid") == os.getpid():
            lock.unlink()


if __name__ == "__main__":
    main()
