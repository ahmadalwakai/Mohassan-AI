"""Train the pre-frozen dialogue-focused curriculum and emit development replies."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
RUN = ROOT / "artifacts/execution-model-runs/text-b3-ar-2026-11-15"
OUT = ROOT / "artifacts/chat-training/conversation-v3-dialogue-focus"
CASES = ROOT / "artifacts/chat-training/conversation-v3/development-cases.jsonl"
NAME = "conversation-v3-dialogue-focus"
BASE = "conversation-v3-batch2/best.pt"
EXPECTED_BASE = "f8e31e7953167da63b7a53297e617f52c64577d0557cb59f958c5b6f9efb4de4"
DATA = {"train": "7ff9d57c6ff750a2a74e6d56bfe65131759b3b6c2702ae68241d60c7b752f604",
        "validation": "26b8ffec84a12477b8d37d4fe834941bef5a371a11700f5d4a44fee74de7b285"}


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def preflight():
    if digest(RUN / BASE) != EXPECTED_BASE:
        raise ValueError("Selected source checkpoint changed.")
    for split, expected in DATA.items():
        if digest(OUT / "dataset" / f"{split}.jsonl") != expected:
            raise ValueError("Frozen focus dataset changed.")
    audit = read(OUT / "qa/runtime-audit.json")
    if audit.get("passed") is not True or any(audit["splits"][s]["sha256"] != h for s, h in DATA.items()):
        raise ValueError("Runtime audit does not match the selected data.")
    if digest(CASES) != "627628390b68a435e47a4016780de31c74ebb83487b996daf925b62438c1c293":
        raise ValueError("Development inputs changed.")
    files = ["execution_pipeline/ads_finetune.py", "execution_pipeline/chat.py", "execution_pipeline/ads_worker.py",
             "scripts/ads_finetune.py", "scripts/chat_model.py"]
    return {"base": BASE, "base_checkpoint_sha256": EXPECTED_BASE, "dataset_sha256": DATA,
            "input_sha256": digest(CASES),
            "code_sha256": {name: digest(ROOT / "packages/execution-pipeline" / name) for name in files},
            "epochs": 20, "batch": 2, "peak_lr": 0.0001, "eval_every": 500, "patience": 6,
            "warmup": 100, "seed": 17, "balanced_languages": True, "group_by_length": True,
            "reason": "Broad instruction training failed development conversation; focus curriculum was frozen before predictions.",
            "base_selection": "Lowest broad validation loss; final-step outputs showed no practical conversation advantage.",
            "all108_development_examples_are_checkpoint_selection_data": True,
            "independent_final_holdout_used": False, "phone_activation": False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    plan = preflight()
    if args.check:
        print(json.dumps(plan, indent=2))
        return 0
    if (RUN / NAME).exists():
        raise FileExistsError("Focus experiment already exists.")
    with (OUT / "pipeline-plan.json").open("x", encoding="utf-8") as stream:
        json.dump(plan, stream, indent=2)

    def status(phase, **extra):
        value = {"phase": phase, "updated_at": datetime.now(timezone.utc).isoformat(),
                 "ready_for_chat": False, "phone_activated": False, **extra}
        temporary = OUT / "pipeline-status.tmp"
        temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
        temporary.replace(OUT / "pipeline-status.json")
        print(json.dumps(value), flush=True)

    def execute(name, command):
        if preflight() != plan:
            raise ValueError("Pinned code, source checkpoint, inputs or data changed during this run.")
        environment = os.environ.copy()
        environment["PYTHONIOENCODING"] = "utf-8"
        with (OUT / f"{name}.log").open("x", encoding="utf-8") as stream:
            subprocess.run([sys.executable, "-u", *command], cwd=ROOT, env=environment,
                           stdout=stream, stderr=subprocess.STDOUT, check=True)

    try:
        status("supervised_training")
        execute("supervised-training", ["packages/execution-pipeline/scripts/ads_finetune.py", "train",
            "--run", str(RUN), "--out", NAME, "--base-checkpoint", BASE, "--data-dir", str(OUT / "dataset"),
            "--epochs", "20", "--batch", "2", "--lr", "0.0001", "--eval-every", "500", "--patience", "6",
            "--warmup", "100", "--seed", "17", "--group-by-length", "--balance-languages", "--device", "cuda"])
        trained = read(RUN / NAME / "status.json")
        checkpoint = digest(RUN / NAME / "best.pt")
        if trained["status"] not in {"completed", "early_stopped"} or checkpoint != trained["best_checkpoint_sha256"]:
            raise ValueError("Training did not finish with a pinned selected checkpoint.")
        status("generating_development_replies", checkpoint_sha256=checkpoint)
        execute("development-generation", ["packages/execution-pipeline/scripts/chat_model.py", "predict",
            "--run", str(RUN), "--finetune", NAME, "--checkpoint-sha256", checkpoint,
            "--input", str(CASES), "--output", str(OUT / "development-predictions.jsonl"),
            "--device", "cuda", "--max-tokens", "192"])
        status("awaiting_semantic_review", checkpoint_sha256=checkpoint,
               predictions_sha256=digest(OUT / "development-predictions.jsonl"))
        return 0
    except BaseException as error:
        status("failed", error=f"{type(error).__name__}: {error}"[:600])
        raise


if __name__ == "__main__":
    raise SystemExit(main())
