"""Continue the pinned v3 experiment after its active language-training process.

This local runner never evaluates the final holdout or activates a phone backend.
It produces development replies for semantic review after supervised training.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUN = ROOT / "artifacts/execution-model-runs/text-b3-ar-2026-11-15"
OUT = ROOT / "artifacts/chat-training/conversation-v3"
FOUNDATION = RUN / "language-ar-v1"
PINNED = {
    "dataset/train.jsonl": "f638f3c8ec90429cc92dd09d3c90562fc4981c6fe7388b48b3ad17b9d294d4e8",
    "dataset/validation.jsonl": "054d3f42a41d1df4302e0fb5bad638b29372fb06ec769a2bc4be3451c0dec23c",
    "development-cases.jsonl": "627628390b68a435e47a4016780de31c74ebb83487b996daf925b62438c1c293",
}


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def preflight(batch_two: bool = False) -> dict:
    for name, expected in PINNED.items():
        if digest(OUT / name) != expected:
            raise ValueError(f"Pinned development/data file changed: {name}")
    audit = read(OUT / "qa/runtime-audit.json")
    overlap = read(OUT / "qa/independent-holdout-overlap.json")
    if audit.get("passed") is not True or overlap.get("passed") is not True:
        raise ValueError("Data audits have not passed.")
    for split in ("train", "validation"):
        if audit["splits"][split]["sha256"] != PINNED[f"dataset/{split}.jsonl"]:
            raise ValueError("Runtime audit belongs to different data.")
    if overlap["training_sha256"] != PINNED["dataset/train.jsonl"]:
        raise ValueError("Overlap audit belongs to different training data.")
    scripts = ["packages/execution-pipeline/execution_pipeline/ads_finetune.py",
               "packages/execution-pipeline/scripts/ads_finetune.py",
               "packages/execution-pipeline/execution_pipeline/chat.py",
               "packages/execution-pipeline/execution_pipeline/ads_worker.py",
               "packages/execution-pipeline/scripts/chat_model.py"]
    plan = {"data_sha256": PINNED,
            "code_sha256": {name: digest(ROOT / name) for name in scripts},
            "foundation_settings_sha256": digest(FOUNDATION / "settings.json"),
            "supervised": {"epochs": 6, "batch": 4, "lr": 0.0001, "eval_every": 500,
                           "patience": 6, "warmup": 100, "balance_languages": True,
                           "group_by_length": True},
            "development_cases": 108, "final_holdout_used": False,
            "phone_activation": False}
    if batch_two:
        base = RUN / "conversation-v3/best.pt"
        expected = "9a69457f0573bf6ae3050775957e908d9310bc6f17da84400277d68382f76d7c"
        if digest(base) != expected:
            raise ValueError("The retained batch4 checkpoint changed.")
        plan["warm_start"] = {"path": "conversation-v3/best.pt", "sha256": expected,
                              "kind": "weights_only_fresh_optimizer", "source_step": 500}
        plan["supervised"].update(batch=2, lr=0.00005, eval_every=1000, warmup=200)
        plan["reason"] = "Batch4 used3959.5MiB dedicated GPU plus1500MiB shared RAM. Halve batch and learning rate; keep per-row evaluation/warmup spacing."
    return plan


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="Validate inputs without starting or waiting for training.")
    parser.add_argument("--batch-two", action="store_true", help="Warm-start the retained step500 checkpoint in a separate lower-memory run.")
    args = parser.parse_args()
    plan = preflight(args.batch_two)
    name = "conversation-v3-batch2" if args.batch_two else "conversation-v3"
    suffix = ".batch2" if args.batch_two else ""
    if args.check:
        print(json.dumps(plan, indent=2))
        return 0
    if (RUN / name).exists() or (OUT / "development-predictions.jsonl").exists():
        raise FileExistsError("V3 output already exists; this runner never overwrites an experiment.")
    with (OUT / f"pipeline-plan{suffix}.json").open("x", encoding="utf-8") as stream:
        json.dump(plan, stream, indent=2)

    def status(phase: str, **extra):
        value = {"phase": phase, "updated_at": datetime.now(timezone.utc).isoformat(),
                 "ready_for_chat": False, "phone_activated": False, "run_output": name, **extra}
        temporary = OUT / "pipeline-status.tmp"
        temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
        temporary.replace(OUT / "pipeline-status.json")
        print(json.dumps(value), flush=True)

    def check_unchanged():
        if preflight(args.batch_two) != plan:
            raise ValueError("Training code/settings or data changed after this pipeline was started.")

    def execute(name: str, command: list[str]):
        check_unchanged()
        environment = os.environ.copy()
        environment["PYTHONIOENCODING"] = "utf-8"
        with (OUT / f"{name}{suffix}.log").open("x", encoding="utf-8") as stream:
            subprocess.run([sys.executable, "-u", *command], cwd=ROOT, env=environment,
                           stdout=stream, stderr=subprocess.STDOUT, check=True)

    try:
        status("waiting_for_foundation")
        deadline = time.monotonic() + 3 * 3600
        while True:
            foundation = read(FOUNDATION / "status.json")
            if foundation["status"] == "completed":
                break
            if foundation["status"] not in {"running", "starting"}:
                raise RuntimeError(f"Foundation stopped: {foundation['status']}")
            if time.monotonic() > deadline:
                raise TimeoutError("Foundation wait exceeded three hours; no supervised training started.")
            time.sleep(5)
        check_unchanged()
        source_hash = digest(FOUNDATION / "best.pt")
        if source_hash != foundation["best_checkpoint_sha256"]:
            raise ValueError("Completed foundation checkpoint does not match its status.")
        base = plan.get("warm_start", {}).get("path", "language-ar-v1/best.pt")
        supervised = plan["supervised"]
        status("supervised_training", foundation_checkpoint_sha256=source_hash, base_checkpoint=base)
        execute("supervised-training", ["packages/execution-pipeline/scripts/ads_finetune.py", "train",
            "--run", str(RUN), "--out", name, "--base-checkpoint", base,
            "--data-dir", str(OUT / "dataset"), "--epochs", str(supervised["epochs"]),
            "--batch", str(supervised["batch"]), "--lr", str(supervised["lr"]),
            "--eval-every", str(supervised["eval_every"]), "--patience", str(supervised["patience"]),
            "--warmup", str(supervised["warmup"]), "--seed", "5",
            "--group-by-length", "--balance-languages", "--device", "cuda"])
        trained = read(RUN / name / "status.json")
        if trained["status"] not in {"completed", "early_stopped"}:
            raise RuntimeError("Supervised training did not complete successfully.")
        checkpoint_hash = digest(RUN / name / "best.pt")
        if checkpoint_hash != trained["best_checkpoint_sha256"]:
            raise ValueError("Selected conversation checkpoint differs from training evidence.")
        status("generating_development_replies", checkpoint_sha256=checkpoint_hash)
        execute("development-generation", ["packages/execution-pipeline/scripts/chat_model.py", "predict",
            "--run", str(RUN), "--finetune", name, "--checkpoint-sha256", checkpoint_hash,
            "--input", str(OUT / "development-cases.jsonl"),
            "--output", str(OUT / "development-predictions.jsonl"), "--device", "cuda", "--max-tokens", "192"])
        status("awaiting_semantic_review", checkpoint_sha256=checkpoint_hash,
               predictions_sha256=digest(OUT / "development-predictions.jsonl"))
        return 0
    except BaseException as error:
        status("failed", error=f"{type(error).__name__}: {error}"[:600])
        raise


if __name__ == "__main__":
    raise SystemExit(main())
