"""Guarded all-token conversational adaptation, followed by the fixed Gate 4.

Uses the existing model, renderer, tokenizer, batching, optimizer and answer-loss
metrics. The warm-started all-token phase needs its own resumable loop because
the foundation pilot only accepts fresh initialization and the SFT masks prompts.
"""
from __future__ import annotations

import ctypes
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import shutil
import tempfile
import time

from . import REPOSITORY_ROOT as ROOT
from .ads_finetune import (_atomic_checkpoint, _atomic_json, _balanced_language_groups,
    _balanced_validation_metrics, _load_payload, _sha256, encode_pair, load_split)
from .chat_diagnostics import GpuJob
from .language_adaptation import _balanced_batches, corpus_manifest
from .pretrain import TextEncoder, _batches, _learning_rate, _optimizer
from .stage5_finetune import verify_eligibility, verify_gate3
from execution_model.model import ExecutionModel

TARGET = 150_000_000
INTERVAL = 25_000_000
MILESTONES = tuple(range(INTERVAL, TARGET + 1, INTERVAL))


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def checked(path, digest):
    if _sha256(path) != digest:
        raise ValueError(f"Pinned conversational adaptation file changed: {path}")


def prepare(*, foundation_run: Path, checkpoint: Path, checkpoint_sha256: str, corpus: Path,
            dataset_dir: Path, gate3: Path, gate3_sha256: str, eligibility: Path,
            eligibility_sha256: str, qa_pins: list[dict], campaign: Path, run: Path) -> dict:
    gate = verify_gate3(gate3, gate3_sha256)
    if gate["gate3"]["candidate_checkpoint_sha256"] != checkpoint_sha256:
        raise ValueError("Stage 4 must start from the single Gate 3 foundation checkpoint.")
    data = verify_eligibility(eligibility, eligibility_sha256, qa_pins, dataset_dir=dataset_dir)
    if data["manifest"].get("tokenizer_sha256") != _sha256(foundation_run / "tokenizer.json"):
        raise ValueError("Stage 4 dataset was audited with a different tokenizer.")
    checked(checkpoint, checkpoint_sha256)
    tokenizer = TextEncoder(foundation_run).tokenizer
    corpus_info = corpus_manifest(corpus, tokenizer.identity, 512)
    checked(foundation_run / "tokenizer.json", corpus_info["tokenizer_sha256"])
    # Pin all modules participating in training, loading, rendering and gate validation.
    code = {path.relative_to(ROOT).as_posix(): _sha256(path) for directory in
        (ROOT / "packages/execution-pipeline/execution_pipeline", ROOT / "packages/execution-model/execution_model")
        for path in directory.glob("*.py")}
    script = ROOT / "packages/execution-pipeline/scripts/adapt_chat_conversations.py"
    code[script.relative_to(ROOT).as_posix()] = _sha256(script)
    config = {"stage": 4, "foundation_run": str(foundation_run.resolve()), "checkpoint": str(checkpoint.resolve()),
        "checkpoint_sha256": checkpoint_sha256, "corpus": str(corpus.resolve()), "dataset_dir": str(dataset_dir.resolve()),
        "gate3": {"path": str(gate3.resolve()), "sha256": gate3_sha256},
        "eligibility": {"path": str(eligibility.resolve()), "sha256": eligibility_sha256}, "qa": qa_pins,
        "campaign": str(campaign.resolve()), "run": str(run.resolve()), "code_sha256": code,
        "input_sha256": {str((corpus / "manifest.json").resolve()): _sha256(corpus / "manifest.json"),
            **{str((foundation_run / name).resolve()): _sha256(foundation_run / name)
                for name in ("tokenizer.json", "tokenizer-report.json")}},
        "validation_sha256": data["dataset"]["validation"]["sha256"],
        "target_positions": TARGET, "milestones": list(MILESTONES), "sequence": 512,
        "microbatch": 2, "accumulation": 8, "peak_lr": 0.00005, "warmup": 100, "seed": 5,
        "maximum_seconds": 12 * 3600, "loss": "all_nonpadding_next_tokens", "language_balance": "exact_input_positions",
        "unique_training_tokens": {lang: corpus_info["files"][f"{lang}.train.bin"]["tokens"] for lang in ("ar", "en")},
        "repeat_factors": {lang: (TARGET / 2) / corpus_info["files"][f"{lang}.train.bin"]["tokens"] for lang in ("ar", "en")},
        "holdout_accessed": False, "ready_for_chat": False, "phone_activated": False}
    campaign.mkdir(parents=True, exist_ok=False)
    run.mkdir(parents=True, exist_ok=False)
    for name in ("tokenizer.json", "tokenizer-report.json"):
        shutil.copyfile(foundation_run / name, run / name)
    _atomic_json(campaign / "protocol.json", config)
    return {"protocol": str(campaign / "protocol.json"), "protocol_sha256": _sha256(campaign / "protocol.json"),
            "status": "prepared", "gpu_started": False}


def check(protocol_path: Path, protocol_sha256: str):
    checked(protocol_path, protocol_sha256)
    config = read(protocol_path)
    if (config["stage"] != 4 or config["target_positions"] != TARGET or tuple(config["milestones"]) != MILESTONES
            or config["sequence"] != 512 or config["microbatch"] != 2 or config["accumulation"] != 8
            or config["loss"] != "all_nonpadding_next_tokens"):
        raise ValueError("Stage 4 protocol changed its fixed loss, batch or position budget.")
    for name, digest in config["code_sha256"].items():
        checked(ROOT / name, digest)
    for name, digest in config["input_sha256"].items():
        checked(Path(name), digest)
    checked(Path(config["checkpoint"]), config["checkpoint_sha256"])
    gate = verify_gate3(Path(config["gate3"]["path"]), config["gate3"]["sha256"])
    if gate["gate3"]["candidate_checkpoint_sha256"] != config["checkpoint_sha256"]:
        raise ValueError("Gate 3 checkpoint changed.")
    data = verify_eligibility(Path(config["eligibility"]["path"]), config["eligibility"]["sha256"], config["qa"],
                              dataset_dir=Path(config["dataset_dir"]))
    if data["dataset"]["validation"]["sha256"] != config["validation_sha256"]:
        raise ValueError("Stage 4 answer-loss validation changed.")
    run = Path(config["run"])
    if data["manifest"].get("tokenizer_sha256") != _sha256(run / "tokenizer.json"):
        raise ValueError("Stage 4 dataset tokenizer differs from this run.")
    for name in ("tokenizer.json", "tokenizer-report.json"):
        checked(run / name, config["input_sha256"][str((Path(config["foundation_run"]) / name).resolve())])
    corpus_manifest(Path(config["corpus"]), TextEncoder(run).tokenizer.identity, config["sequence"])
    return config


def _checkpoint(directory, state):
    destination = directory / f"tokens-{state['processed_tokens']:012d}"
    if destination.exists():
        raise FileExistsError(f"Conversation checkpoint already committed: {destination}")
    with tempfile.TemporaryDirectory(prefix=".checkpoint-", dir=directory) as temporary:
        pending = Path(temporary) / "saved"
        pending.mkdir()
        digest = _atomic_checkpoint(pending / "checkpoint.pt", state)
        _atomic_json(pending / "manifest.json", {"checkpoint_sha256": digest, "positions": state["processed_tokens"],
            "step": state["step"], "language_tokens": state["language_tokens"], "settings": state["settings"],
            "code_sha256": state["settings"]["code_sha256"]})
        pending.rename(destination)
    return destination


def _losses(model, records, encoder, device, batch):
    rows = [encode_pair(encoder, record, None) for record in records]
    if any(len(ids) > model.config.max_context_length for ids, _ in rows):
        raise ValueError("Stage 4 validation contains an overlong conversation.")
    groups = _balanced_language_groups(records, "validation")
    measured = _balanced_validation_metrics(model, rows, groups, encoder.tokenizer.pad_token_id, device, batch)
    result = {lang: measured["per_language"][lang]["answer_loss"] for lang in ("ar", "en")}
    result["macro"] = sum(result.values()) / 2
    if not all(math.isfinite(value) for value in result.values()):
        raise ValueError("Stage 4 answer loss is nonfinite.")
    return result


def train_core(config, protocol_sha256, attempt, *, guard=None, device="cuda", resume=False, max_updates=None):
    """Shared real CPU/GPU path; public execution always uses the CUDA guard."""
    import numpy as np
    import torch
    run, corpus = Path(config["run"]), Path(config["corpus"])
    output = run / "adaptation"
    if output.exists() != resume:
        raise ValueError("Use resume exactly when the adaptation output already exists.")
    payload, encoder, model_config = _load_payload(run, Path(config["checkpoint"]))
    torch.manual_seed(config["seed"])
    model = ExecutionModel(model_config)
    model.load_state_dict(payload["model_state"], strict=True)
    del payload
    model = model.to(device)
    if guard:
        model.register_forward_pre_hook(lambda *_: guard.check())
    optimizer = _optimizer(model, config["peak_lr"], 0.1, device)
    generator = torch.Generator().manual_seed(config["seed"] + 1)
    records = load_split("validation", Path(config["dataset_dir"]))
    checked(Path(config["dataset_dir"]) / "validation.jsonl", config["validation_sha256"])
    arrays = {lang: np.memmap(corpus / f"{lang}.train.bin", dtype="<u2", mode="r") for lang in ("ar", "en")}
    settings = {"task": "conversational_all_token_adaptation", "protocol_sha256": protocol_sha256,
        "tokenizer_identity": encoder.tokenizer.identity, "config_identity": model_config.identity,
        "tokenizer_sha256": _sha256(run / "tokenizer.json"), "tokenizer_report_sha256": _sha256(run / "tokenizer-report.json"),
        "base_checkpoint_sha256": config["checkpoint_sha256"], "prompt_hint": None, "languages": ["ar", "en"],
        "capabilities": ["chat.reply.v1"], "code_sha256": config["code_sha256"], "parameters": model_config.parameter_count()}
    step = processed = prior_seconds = 0
    language_tokens = {"ar": 0, "en": 0}
    before = after = None
    if resume:
        if read(output / "settings.json") != settings:
            raise ValueError("Adaptation resume settings changed.")
        latest = sorted((output / "checkpoints").glob("tokens-*/manifest.json"))[-1]
        checked(latest.parent / "checkpoint.pt", read(latest)["checkpoint_sha256"])
        state = torch.load(latest.parent / "checkpoint.pt", map_location="cpu", weights_only=True)
        if state["settings"] != settings:
            raise ValueError("Adaptation checkpoint settings differ.")
        model.load_state_dict(state["model_state"], strict=True)
        optimizer.load_state_dict(state["optimizer_state"])
        generator.set_state(state["generator_state"])
        torch.set_rng_state(state["torch_rng_state"])
        if device == "cuda":
            torch.cuda.set_rng_state(state["cuda_rng_state"], device)
        step, processed, prior_seconds = state["step"], state["processed_tokens"], state["elapsed_seconds"]
        language_tokens, before, after = state["language_tokens"], state["answer_loss_before"], state.get("answer_loss_after")
        del state
    else:
        output.mkdir()
        (output / "checkpoints").mkdir()
        _atomic_json(output / "settings.json", settings)
        before = _losses(model, records, encoder, device, config["microbatch"])
    started = time.perf_counter()
    checkpoint_directory = output / "checkpoints"
    log = (attempt / "log.jsonl").open("x", encoding="utf-8")

    def report(status, error=None):
        value = {"status": status, "step": step, "processed_tokens": processed, "language_tokens": language_tokens,
            "elapsed_seconds": prior_seconds + time.perf_counter() - started, "answer_loss_before": before,
            "answer_loss_after": after, "updated_at": datetime.now(timezone.utc).isoformat(),
            "protocol_sha256": protocol_sha256, "ready_for_chat": False, "phone_activated": False}
        if error:
            value["error"] = error
        _atomic_json(output / "status.json", value)
        return value

    def save():
        return _checkpoint(checkpoint_directory, {"config": model_config.to_dict(), "settings": settings,
            "step": step, "processed_tokens": processed, "language_tokens": language_tokens,
            "model_state": model.state_dict(), "optimizer_state": optimizer.state_dict(),
            "generator_state": generator.get_state(), "torch_rng_state": torch.get_rng_state(),
            "cuda_rng_state": torch.cuda.get_rng_state(device) if device == "cuda" else None,
            "elapsed_seconds": prior_seconds + time.perf_counter() - started,
            "answer_loss_before": before, "answer_loss_after": after})

    try:
        report("running")
        if not resume:
            save()
        if guard:
            guard.start_training("4-conversation-all-token")
        target, milestones = config["target_positions"], config["milestones"]
        per_update = config["sequence"] * config["microbatch"] * config["accumulation"]
        schedule_steps = math.ceil(target / per_update)
        new_updates = 0
        model.train()
        while processed < target:
            if guard:
                guard.check()
            boundary = next(point for point in milestones if point > processed)
            positions = min(per_update, boundary - processed)
            batches = _balanced_batches(positions, config["sequence"], config["microbatch"])
            targets = sum(batch * (length - 1) for _, batch, length in batches)
            update_started = time.perf_counter()
            learning_rate = _learning_rate(step, schedule_steps, config["peak_lr"], config["warmup"])
            for group in optimizer.param_groups:
                group["lr"] = learning_rate
            loss_sum = 0.0
            for language, batch, length in batches:
                if guard:
                    guard.check()
                ids = _batches(arrays[language], batch=batch, length=length, generator=generator, device=device)
                with torch.autocast("cuda", dtype=torch.bfloat16, enabled=device == "cuda"):
                    loss = model(ids, labels=ids).loss * (batch * (length - 1) / targets)
                if not bool(torch.isfinite(loss)):
                    raise ValueError("Nonfinite conversation loss; optimizer update refused.")
                loss.backward()
                loss_sum += float(loss.detach())
            norm = torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0, error_if_nonfinite=True)
            optimizer.step()
            optimizer.zero_grad(set_to_none=True)
            step += 1
            new_updates += 1
            processed += positions
            for lang in language_tokens:
                language_tokens[lang] += positions // 2
            if guard:
                torch.cuda.synchronize()
                guard.record_training_update(positions, time.perf_counter() - update_started)
            if step % 25 == 0 or max_updates == new_updates:
                log.write(json.dumps({"step": step, "positions": processed, "train_loss": loss_sum,
                    "learning_rate": learning_rate, "grad_norm": float(norm)}) + "\n")
                log.flush()
                report("running")
            if processed == target:
                after = _losses(model, records, encoder, device, config["microbatch"])
            if processed == boundary or max_updates == new_updates:
                save()
            if max_updates == new_updates and processed < target:
                return report("paused_for_smoke")
        return report("completed")
    except BaseException as error:
        report("failed", f"{type(error).__name__}: {error}")
        raise
    finally:
        log.close()


def export(config, protocol_sha256):
    run = Path(config["run"])
    status = read(run / "adaptation/status.json")
    if status["status"] != "completed" or status["processed_tokens"] != config["target_positions"]:
        raise ValueError("Stage 4 must finish before candidate export.")
    if status.get("protocol_sha256") != protocol_sha256:
        raise ValueError("Stage 4 status belongs to a different protocol.")
    checked(Path(config["checkpoint"]), config["checkpoint_sha256"])
    checked(Path(config["dataset_dir"]) / "validation.jsonl", config["validation_sha256"])
    source = run / "adaptation/checkpoints" / f"tokens-{status['processed_tokens']:012d}"
    manifest = read(source / "manifest.json")
    if (manifest["settings"].get("protocol_sha256") != protocol_sha256
            or manifest["code_sha256"] != config["code_sha256"]
            or manifest["positions"] != status["processed_tokens"] or manifest["step"] != status["step"]
            or manifest["language_tokens"] != status["language_tokens"]
            or status["language_tokens"] != dict.fromkeys(("ar", "en"), config["target_positions"] // 2)):
        raise ValueError("Stage 4 checkpoint provenance or language counters differ from its completed status.")
    digest = manifest["checkpoint_sha256"]
    checked(source / "checkpoint.pt", digest)
    selected = run / "selected"
    if not selected.exists():
        with tempfile.TemporaryDirectory(prefix=".candidate-", dir=run) as temporary:
            pending = Path(temporary) / "selected"
            pending.mkdir()
            shutil.copyfile(source / "checkpoint.pt", pending / "best.pt")
            shutil.copyfile(run / "adaptation/settings.json", pending / "settings.json")
            _atomic_json(pending / "manifest.json", {"files": {name: _sha256(pending / name)
                for name in ("best.pt", "settings.json")}, "source_manifest_sha256": _sha256(source / "manifest.json"),
                "protocol_sha256": protocol_sha256})
            pending.rename(selected)
    checked(selected / "best.pt", digest)
    checked(selected / "settings.json", _sha256(run / "adaptation/settings.json"))
    selected_manifest = read(selected / "manifest.json")
    if (selected_manifest.get("protocol_sha256") != protocol_sha256
            or selected_manifest.get("source_manifest_sha256") != _sha256(source / "manifest.json")):
        raise ValueError("Selected Stage 4 candidate belongs to different provenance.")
    before, after = status["answer_loss_before"], status["answer_loss_after"]
    if not before or not after or any(not math.isfinite(value) for data in (before, after) for value in data.values()):
        raise ValueError("Stage 4 requires finite before/after answer losses.")
    receipt = {"stage": 4, "gate4_passed": after["macro"] < before["macro"],
        "base_checkpoint_sha256": config["checkpoint_sha256"], "candidate_checkpoint_sha256": digest,
        "validation_sha256": config["validation_sha256"], "answer_loss_before": before, "answer_loss_after": after,
        "processed_positions": status["processed_tokens"], "language_tokens": status["language_tokens"],
        "protocol_sha256": protocol_sha256, "holdout_accessed": False, "ready_for_chat": False, "phone_activated": False}
    destination = Path(config["campaign"]) / "assessment.json"
    if destination.exists() and read(destination) != receipt:
        raise ValueError("Existing Stage 4 assessment differs; it will not be overwritten.")
    _atomic_json(destination, receipt)
    return receipt


def execute(protocol_path, protocol_sha256, *, resume=False, smoke=False):
    import torch
    config = check(protocol_path, protocol_sha256)
    campaign = Path(config["campaign"])
    output = Path(config["run"]) / "adaptation"
    if resume and read(output / "status.json")["status"] == "completed":
        raise ValueError("Stage 4 has finished; use export to recover its selected candidate.")
    attempt = Path(tempfile.mkdtemp(prefix="attempt-", dir=campaign))
    torch.set_num_threads(4)
    awake = ctypes.windll.kernel32.SetThreadExecutionState
    result = failure = None
    if not awake(0x80000001):
        raise RuntimeError("Windows could not reserve wakefulness for Stage 4.")
    try:
        previous = read(output / "status.json")["elapsed_seconds"] if resume else 0
        remaining = config["maximum_seconds"] - previous
        if remaining <= 0:
            raise RuntimeError("Stage 4 cumulative runtime budget is exhausted.")
        with GpuJob(ROOT, attempt, stage="4-conversation-adaptation", max_seconds=remaining) as guard:
            torch.empty(1, device="cuda")
            guard.start_monitor()
            result = train_core(config, protocol_sha256, attempt, guard=guard, resume=resume,
                                max_updates=1 if smoke else None)
        if result["status"] == "completed":
            export(check(protocol_path, protocol_sha256), protocol_sha256)
        return result
    except BaseException as error:
        failure = f"{type(error).__name__}: {error}"
        raise
    finally:
        awake(0x80000000)
        _atomic_json(attempt / "manifest.json", {"protocol_sha256": protocol_sha256, "resumed": resume,
            "files": {path.relative_to(attempt).as_posix(): _sha256(path) for path in attempt.rglob("*") if path.is_file()},
            "result": result, "failure": failure})
