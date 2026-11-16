"""Bounded CPU memorization probe, never a quality/readiness evaluation.

The same eight existing TRAIN examples are used for updates and measurements.
The supervisor kills the worker after 300 seconds; worker uses two CPU threads.
"""
from __future__ import annotations

from collections import Counter
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
RUN = ROOT / "artifacts/execution-model-runs/text-b3-ar-2026-11-15"
SOURCE = RUN / "diagnostic-raw-cpu-20261115T212045Z/best.pt"
TRAIN = ROOT / "artifacts/chat-training/conversation-v3/dataset/train.jsonl"
OUT = ROOT / "artifacts/chat-training/memorization-eight-cpu-20261115"


def worker():
    started = time.perf_counter()
    import torch
    import torch.nn.functional as F
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    sys.path.insert(0, str(ROOT / "packages/execution-pipeline"))
    from execution_pipeline.ads_finetune import _load_payload, _sha256, _atomic_json, encode_pair, _batch, IGNORE
    from execution_model.model import ExecutionModel
    OUT.mkdir(parents=True, exist_ok=False)
    (OUT / "dataset").mkdir()
    (OUT / "run").mkdir()
    source_hash, train_hash = _sha256(SOURCE), _sha256(TRAIN)
    payload, encoder, config = _load_payload(RUN, SOURCE)
    assert payload["step"] == 800
    model = ExecutionModel(config).cpu()
    model.load_state_dict(payload["model_state"], strict=True)
    del payload
    records = [json.loads(line) for line in TRAIN.read_text(encoding="utf-8").splitlines()]
    selected = []
    for language in ("ar", "en"):
        eligible = [row for row in records if row["language"] == language and row["id"].startswith("authored-")
                    and (any("\u0621" <= char <= "\u064a" for char in row["target"]) == (language == "ar"))]
        eligible.sort(key=lambda row: (len(encoder.encode(row["prompt"])) + len(encoder.encode(row["target"])), row["id"]))
        selected.extend(eligible[:4])
    assert len(selected) == 8 and len({row["id"] for row in selected}) == 8
    content = "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in selected)
    for split in ("train", "validation"):
        (OUT / f"dataset/{split}.jsonl").write_text(content, encoding="utf-8")
    metadata = {"diagnostic_only": True, "ready_for_chat": False, "not_a_quality_evaluation": True,
                "train_equals_validation": True, "reason": "Deliberate eight-example memorization probe only.",
                "source_checkpoint": str(SOURCE), "source_checkpoint_sha256": source_hash, "source_checkpoint_step": 800,
                "source_train_file": str(TRAIN), "source_train_sha256": train_hash,
                "selected_ids": [row["id"] for row in selected], "languages": dict(Counter(row["language"] for row in selected)),
                "selection": "Four shortest authored TRAIN rows per prompt language with target text in that language; length then ID order.",
                "selected_train_sha256": _sha256(OUT / "dataset/train.jsonl"),
                "validation_sha256": _sha256(OUT / "dataset/validation.jsonl"),
                "device": "cpu", "threads": 2, "batch": 4, "learning_rate": 5e-4, "max_steps": 200,
                "hard_worker_timeout_seconds": 300, "training_deadline_seconds_from_start": 225,
                "parameters": config.parameter_count(), "tokenizer_identity": encoder.tokenizer.identity,
                "heldout_or_development_files_read": False, "external_weights": False}
    _atomic_json(OUT / "dataset/manifest.json", metadata)
    pairs = [encode_pair(encoder, row) for row in selected]
    pad, eos = encoder.tokenizer.pad_token_id, encoder.tokenizer.eos_token_id
    groups = [list(range(4)), list(range(4, 8))]

    def teacher_metrics():
        model.eval()
        result = {}
        with torch.no_grad():
            for language, indices in zip(("ar", "en"), groups):
                ids, mask, labels = _batch([pairs[i] for i in indices], pad, "cpu")
                output = model(ids, attention_mask=mask, labels=labels)
                target = labels[:, 1:]
                active = target != IGNORE
                correct = (output.logits[:, :-1].argmax(-1) == target) & active
                result[language] = {"answer_loss": float(output.loss), "answer_tokens": int(active.sum()),
                                    "correct_answer_tokens": int(correct.sum()), "accuracy": float(correct.sum() / active.sum())}
        return result

    def greedy():
        model.eval()
        results = []
        with torch.no_grad():
            for indices in groups:
                prompts = {i: encoder.encode(selected[i]["prompt"]) for i in indices}
                generated = {i: [] for i in indices}
                done = set()
                for _ in range(24):
                    active = [i for i in indices if i not in done]
                    if not active:
                        break
                    sequences = [prompts[i] + generated[i] for i in active]
                    width = max(map(len, sequences))
                    ids = torch.full((len(active), width), pad, dtype=torch.long)
                    mask = torch.zeros_like(ids, dtype=torch.bool)
                    for row, sequence in enumerate(sequences):
                        ids[row, -len(sequence):] = torch.tensor(sequence)
                        mask[row, -len(sequence):] = True
                    tokens = model(ids, attention_mask=mask, last_token_only=True).logits[:, -1].argmax(-1).tolist()
                    for i, token in zip(active, tokens):
                        if token == eos:
                            done.add(i)
                        else:
                            generated[i].append(token)
                for i in indices:
                    text = encoder.tokenizer.decode_bytes(generated[i]).decode("utf-8", "replace")
                    results.append({"id": selected[i]["id"], "language": selected[i]["language"],
                                    "messages": selected[i]["messages"], "target": selected[i]["target"],
                                    "generated": text, "finished_eos": i in done,
                                    "exact_match": text == selected[i]["target"], "max_new_tokens": 24})
        return results

    report = {"settings": metadata, "status": "running", "completed_steps": 0,
              "before": {"teacher_forced": teacher_metrics(), "greedy": greedy()}, "trajectory": []}
    _atomic_json(OUT / "run/report.json", report)
    print(json.dumps({"stage": "before", "metrics": report["before"]["teacher_forced"],
                      "exact": sum(row["exact_match"] for row in report["before"]["greedy"]),
                      "seconds": round(time.perf_counter() - started, 1)}), flush=True)
    optimizer = torch.optim.AdamW(model.parameters(), lr=5e-4, betas=(0.9, 0.95), weight_decay=0.1)
    torch.manual_seed(20261115)
    for step in range(1, 201):
        if time.perf_counter() - started >= 225:
            report["status"] = "partial_time_budget"
            break
        model.train()
        indices = groups[(step - 1) % 2]
        ids, mask, labels = _batch([pairs[i] for i in indices], pad, "cpu")
        loss = model(ids, attention_mask=mask, labels=labels).loss
        assert bool(torch.isfinite(loss))
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0, error_if_nonfinite=True)
        optimizer.step()
        optimizer.zero_grad(set_to_none=True)
        report["completed_steps"] = step
        if step % 10 == 0:
            metrics = teacher_metrics()
            point = {"step": step, "teacher_forced": metrics, "seconds": round(time.perf_counter() - started, 1)}
            report["trajectory"].append(point)
            _atomic_json(OUT / "run/report.json", report)
            print(json.dumps(point), flush=True)
            if all(value["accuracy"] == 1.0 and value["answer_loss"] < 0.02 for value in metrics.values()):
                report["status"] = "memorization_loss_threshold"
                break
    else:
        report["status"] = "completed_200_steps"
    report["after"] = {"teacher_forced": teacher_metrics(), "greedy": greedy()}
    report["seconds"] = round(time.perf_counter() - started, 1)
    report["source_checkpoint_unchanged"] = _sha256(SOURCE) == source_hash
    report["source_train_unchanged"] = _sha256(TRAIN) == train_hash
    assert report["source_checkpoint_unchanged"] and report["source_train_unchanged"]
    report["memorized_exact_by_language"] = {language: sum(row["exact_match"] and row["finished_eos"] for row in report["after"]["greedy"] if row["language"] == language) for language in ("ar", "en")}
    _atomic_json(OUT / "run/report.json", report)
    print(json.dumps({"stage": "after", "status": report["status"], "steps": report["completed_steps"],
                      "metrics": report["after"]["teacher_forced"], "exact_with_eos": report["memorized_exact_by_language"],
                      "seconds": report["seconds"]}), flush=True)


if __name__ == "__main__":
    if "--worker" in sys.argv:
        worker()
    else:
        environment = {**os.environ, "CUDA_VISIBLE_DEVICES": "", "OMP_NUM_THREADS": "2", "MKL_NUM_THREADS": "2"}
        try:
            process = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--worker"], env=environment, timeout=300)
            outcome = {"hard_timeout": False, "returncode": process.returncode}
        except subprocess.TimeoutExpired:
            outcome = {"hard_timeout": True, "returncode": None, "note": "Worker killed at five minutes. Any saved trajectory is partial; no quality inference."}
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / "supervisor.json").write_text(json.dumps(outcome, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(outcome), flush=True)
