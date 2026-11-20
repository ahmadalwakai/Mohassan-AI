"""Train our own language model on pinned Arabic and English text.

Adaptation warm-starts our existing weights. Pilots start from a fresh model
and evaluate against a fixed reference. Resume restores optimizer and RNG state.
No external weights, network, chat holdout, or production route are involved.
"""
from __future__ import annotations

import json
import math
import random
import tempfile
import time
from bisect import bisect_right
from dataclasses import dataclass, field
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any

from . import REPOSITORY_ROOT
from .ads_finetune import _atomic_checkpoint, _atomic_json, _base_path, _load_payload, _output_path, _sha256
from .pretrain import TextEncoder, _batches, _evaluate, _learning_rate
from execution_model.config import ModelConfig


LANGUAGES = ("ar", "en")
LEGACY_ADAPTATION_SHA256 = "c8546302fd2a417fb20bed0c6138bdb53d22b3d2c50e4ae8075aa63c30540b1e"
PRE_COMPARISON_ADAPTATION_SHA256 = "610bb0a00e468c2a25f3b3ca940fd838520a29a124f2dc5b9b07effb1de33a67"


@dataclass(frozen=True)
class ComparisonRecovery:
    previous_config_sha256: str
    previous_code_sha256: dict[str, str]
    checkpoint_positions: int
    checkpoint_sha256: str


@dataclass(frozen=True)
class ComparisonAnchor:
    checkpoint: Path
    sha256: str
    positions: int


@dataclass(frozen=True)
class ComparisonSettings:
    sampler: Any
    development: Any
    identity: dict
    recovery: ComparisonRecovery | None = None
    anchor: ComparisonAnchor | None = None


@dataclass(frozen=True)
class PilotSettings:
    model: ModelConfig
    reference: Path
    milestones: tuple[int, ...]
    checkpoint_every_tokens: int
    attempt_output: Path
    config_sha256: str
    code_sha256: dict[str, str] = field(default_factory=dict)
    lr_decay_tokens: int | None = None
    comparison: ComparisonSettings | None = None


def corpus_manifest(directory: Path, tokenizer_identity: str, sequence: int,
                    *, splits: tuple[str, ...] = ("train", "validation"),
                    languages: tuple[str, ...] = LANGUAGES) -> dict:
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("tokenizer_identity") != tokenizer_identity:
        raise ValueError("Foundation corpus uses a different tokenizer.")
    for language in languages:
        for split in splits:
            name = f"{language}.{split}.bin"
            file = directory / name
            record = manifest["files"][name]
            if (file.stat().st_size != record["tokens"] * 2 or record["tokens"] <= sequence
                    or _sha256(file) != record["sha256"]):
                raise ValueError(f"Foundation corpus size or hash mismatch: {name}")
    return manifest


def _balanced_batches(positions: int, sequence: int, microbatch: int) -> list[tuple[str, int, int]]:
    if positions % 2:
        raise ValueError("A balanced update needs even token positions.")
    rows, short_length = divmod(positions // 2, sequence)
    full, short_batch = divmod(rows, microbatch)
    batches = [(microbatch, sequence)] * full
    if short_batch:
        batches.append((short_batch, sequence))
    if short_length == 1:
        if not batches or sequence < 3:
            raise ValueError("A balanced update needs at least two tokens per sequence.")
        batch, length = batches.pop()
        if batch > 1:
            batches.append((batch - 1, length))
        batches.extend(((1, length - 1), (1, 2)))
    elif short_length:
        batches.append((1, short_length))
    return [(language, batch, length) for batch, length in batches for language in LANGUAGES]


def _publish_pilot_checkpoint(directory: Path, state: dict, *, validation: dict, milestone: bool) -> str:
    processed = state["processed_tokens"]
    destination = directory / f"tokens-{processed:012d}"
    if destination.exists():
        raise FileExistsError(f"Checkpoint already committed: {destination}")
    stop_recovery = state.get("stop_recovery")
    if stop_recovery is not None and (milestone or validation):
        raise ValueError("An interrupted comparison checkpoint cannot publish a milestone evaluation.")
    # A complete checkpoint and manifest appear together on the same filesystem.
    with tempfile.TemporaryDirectory(prefix=".checkpoint-", dir=directory) as temporary:
        pending = Path(temporary)
        checkpoint_sha256 = _atomic_checkpoint(pending / "checkpoint.pt", state)
        manifest = {"checkpoint_sha256": checkpoint_sha256,
            "checkpoint_kind": "optimizer_resume", "step": state["step"], "tokens": processed,
            "tokens_by_language": state["language_tokens"], "exact_evaluation_milestone": milestone,
            "fixed_reference_validation_loss": validation,
            "code_sha256": state["settings"]["pilot_code_sha256"],
            "settings": state["settings"], "config": state["config"]}
        if state.get("initial_weights_sha256") is not None:
            manifest.update(initial_weights_sha256=state["initial_weights_sha256"])
            if milestone:
                manifest.update(development=state["last_development"],
                                comparison_sampling_receipt=state["comparison_sampling_receipt"])
        if stop_recovery is not None:
            manifest["stop_recovery"] = stop_recovery
        _atomic_json(pending / "manifest.json", manifest)
        pending.rename(destination)
    return checkpoint_sha256


def _latest_pilot_checkpoint(directory: Path):
    candidates = sorted(path for path in directory.glob("tokens-*") if path.is_dir())
    if not candidates:
        return None
    latest = candidates[-1]
    manifest = json.loads((latest / "manifest.json").read_text(encoding="utf-8"))
    checkpoint = latest / "checkpoint.pt"
    if (latest.name != f"tokens-{manifest['tokens']:012d}" or _sha256(checkpoint) != manifest["checkpoint_sha256"]):
        raise ValueError("Latest pilot checkpoint failed its manifest integrity check.")
    return checkpoint


def _weights_digest(model) -> str:
    digest = sha256()
    for name, parameter in sorted(model.state_dict().items()):
        tensor = parameter.detach().cpu().contiguous()
        digest.update(json.dumps([name, str(tensor.dtype), list(tensor.shape)]).encode("utf-8") + b"\0")
        digest.update(tensor.numpy().tobytes())
    return digest.hexdigest()


def _original_comparison_settings(settings: dict, recovery: ComparisonRecovery) -> dict:
    comparison = {key: value for key, value in settings["comparison"].items()
                  if key not in ("execution_microbatch_rows", "recovery")}
    return {**settings, "comparison": comparison,
            "pilot_config_sha256": recovery.previous_config_sha256,
            "pilot_code_sha256": recovery.previous_code_sha256,
            "trainer_sha256": recovery.previous_code_sha256[
                "packages/execution-pipeline/execution_pipeline/language_adaptation.py"]}


def _anchored_comparison_settings(anchor: ComparisonAnchor, settings: dict) -> dict:
    checkpoint = anchor.checkpoint.resolve()
    if _sha256(checkpoint) != anchor.sha256:
        raise ValueError("Comparison continuation checkpoint does not match the pinned input.")
    manifest = json.loads((checkpoint.parent / "manifest.json").read_text(encoding="utf-8"))
    previous = manifest["settings"]
    if (manifest["checkpoint_sha256"] != anchor.sha256 or manifest["tokens"] != anchor.positions
            or not manifest["exact_evaluation_milestone"]
            or previous["total_tokens"] != anchor.positions
            or previous["exact_token_milestones"] != settings["exact_token_milestones"][:-1]
            or previous["total_steps"] >= settings["total_steps"]):
        raise ValueError("Comparison continuation needs the original final milestone and a later target.")
    allowed_changes = {"total_tokens", "total_steps", "exact_token_milestones", "pilot_config_sha256",
                       "pilot_code_sha256", "trainer_sha256", "comparison"}
    if ({k: v for k, v in previous.items() if k not in allowed_changes}
            != {k: v for k, v in settings.items() if k not in allowed_changes}
            or settings["comparison"].get("prefix") != previous["comparison"]):
        raise ValueError("Comparison continuation changed settings that belong to the original run.")
    return previous


def adapt(run: Path, *, corpus: Path, out_name: str, base_checkpoint: Path | None = None,
          total_tokens: int = 32_000_000, sequence: int = 512, microbatch: int = 8,
          accumulation: int = 2, peak_lr: float = 2e-4, warmup: int = 100,
          eval_every: int = 200, arabic_fraction: float = 0.75,
          seed: int = 719, device: str = "cuda", resume: bool = False,
          max_minutes: float | None = None, pilot: PilotSettings | None = None, guard: Any = None,
          early_stop_flat_tokens: int | None = None) -> dict[str, Any]:
    import numpy as np
    import torch
    from execution_model.model import ExecutionModel

    if device not in ("cuda", "cpu") or not 0 < arabic_fraction < 1:
        raise ValueError("Choose CPU/CUDA and a language mixture strictly between zero and one.")
    for name, value in (("total_tokens", total_tokens), ("sequence", sequence), ("microbatch", microbatch),
                        ("accumulation", accumulation), ("eval_every", eval_every)):
        if type(value) is not int or value < 1:
            raise ValueError(f"{name} must be a positive integer.")
    if microbatch > 64 or type(seed) is not int or seed < 0 or type(warmup) is not int or warmup < 0:
        raise ValueError("Invalid batch, seed or warmup.")
    if not math.isfinite(peak_lr) or peak_lr <= 0 or (
            max_minutes is not None and (not math.isfinite(max_minutes) or max_minutes <= 0)):
        raise ValueError("Invalid learning rate or duration.")
    if device == "cuda" and (not torch.cuda.is_available() or not torch.cuda.is_bf16_supported()):
        raise ValueError("Requested CUDA BF16 training is not available.")
    run, corpus = run.resolve(), corpus.resolve()
    comparison = pilot.comparison if pilot else None
    if early_stop_flat_tokens is not None and (
            pilot is None or type(early_stop_flat_tokens) is not int or early_stop_flat_tokens <= 0):
        raise ValueError("Foundation plateau stopping requires a pinned pilot and a positive token window.")
    recovery = comparison.recovery if comparison else None
    anchor = comparison.anchor if comparison else None
    if recovery and anchor:
        raise ValueError("Choose one kind of comparison checkpoint migration.")
    if recovery and not resume:
        raise ValueError("Rule 4 comparison recovery must resume its pinned existing checkpoint.")
    tokens_per_step = sequence * microbatch * accumulation
    if pilot:
        if (base_checkpoint is not None or arabic_fraction != 0.5 or accumulation % 2 or sequence < 2
                or type(pilot.checkpoint_every_tokens) is not int or pilot.checkpoint_every_tokens <= 0):
            raise ValueError("Pilot requires fresh weights, balanced batches and a positive checkpoint interval.")
        lr_decay_tokens = total_tokens if pilot.lr_decay_tokens is None else pilot.lr_decay_tokens
        if type(lr_decay_tokens) is not int or lr_decay_tokens < total_tokens:
            raise ValueError("Pilot learning-rate decay must span at least the training token target.")
        if (not pilot.milestones or pilot.milestones[-1] != total_tokens
                or any(type(point) is not int for point in pilot.milestones)
                or tuple(sorted(set(pilot.milestones))) != pilot.milestones):
            raise ValueError("Pilot milestones must be increasing integer token counts ending at the target.")
        prior_count = total_steps = 0
        for point in pilot.milestones:
            if point <= prior_count:
                raise ValueError("Pilot milestones must be positive.")
            segment = point - prior_count
            ordinary_updates, tail = divmod(segment, tokens_per_step)
            if tail:
                _balanced_batches(tail, sequence, microbatch)
            total_steps += ordinary_updates + int(bool(tail))
            prior_count = point
        source = source_hash = payload = None
        encoder, config = TextEncoder(run), pilot.model
        if config.vocab_size != encoder.tokenizer.vocab_size or config.seed != seed:
            raise ValueError("Pilot model must use the pinned tokenizer vocabulary and seed.")
    else:
        if guard is not None:
            raise ValueError("This adaptation entry point accepts a GPU guard for a pinned pilot only.")
        source = _base_path(run, base_checkpoint)
        source_hash = _sha256(source)
        payload, encoder, config = _load_payload(run, source)
        total_steps = math.ceil(total_tokens / tokens_per_step)
    if sequence > config.max_context_length:
        raise ValueError("Training windows exceed model context.")
    train_languages = ("ar",) if comparison else LANGUAGES
    manifest = corpus_manifest(corpus, encoder.tokenizer.identity, sequence,
                               splits=("train",) if pilot else ("train", "validation"), languages=train_languages)
    reference = pilot.reference.resolve() if pilot else corpus
    reference_manifest = (corpus_manifest(reference, encoder.tokenizer.identity, sequence, splits=("validation",))
                          if pilot else manifest)
    train_files = {f"{lang}.train.bin": corpus for lang in train_languages}
    validation_files = {f"{lang}.validation.bin": reference for lang in LANGUAGES}
    out = _output_path(run, out_name)
    settings = {"task": "bilingual_language_adaptation", "base": source.relative_to(run).as_posix() if source else None,
                "base_checkpoint_sha256": source_hash, "external_pretrained_weights": False,
                "parameters": config.parameter_count(), "config_identity": config.identity,
                "tokenizer_identity": encoder.tokenizer.identity, "tokenizer_sha256": _sha256(run / "tokenizer.json"),
                "tokenizer_report_sha256": _sha256(run / "tokenizer-report.json"),
                "corpus": str(corpus), "corpus_manifest_sha256": _sha256(corpus / "manifest.json"),
                "corpus_files": {name: info["sha256"] for name, info in manifest["files"].items()},
                "sequence": sequence, "microbatch": microbatch, "accumulation": accumulation,
                "total_tokens": total_tokens, "tokens_per_step": tokens_per_step, "total_steps": total_steps,
                "peak_lr": peak_lr, "warmup": warmup, "eval_every": eval_every,
                "arabic_fraction": arabic_fraction, "seed": seed, "device": device,
                "precision": "bf16-autocast" if device == "cuda" else "float32",
                "languages": ["ar", "en"], "capabilities": ["language.modeling.ar-en.v1"],
                "prompt_hint": None, "trainer_sha256": _sha256(Path(__file__)),
                "continuation": "weights_only_new_optimizer", "torch_version": str(torch.__version__)}
    evaluation_batch = 4 if pilot else microbatch
    if pilot:
        if (manifest.get("tokenizer_sha256") != settings["tokenizer_sha256"]
                or reference_manifest.get("tokenizer_sha256") != settings["tokenizer_sha256"]):
            raise ValueError("Pilot corpus and reference must pin the same tokenizer bytes.")
        settings.update({"task": "bilingual_foundation_pilot", "continuation": "fresh_random_initialization",
            "corpus_files": {name: manifest["files"][name]["sha256"] for name in train_files},
            "reference_corpus": str(reference), "reference_corpus_manifest_sha256": _sha256(reference / "manifest.json"),
            "reference_files": {name: reference_manifest["files"][name]["sha256"] for name in validation_files},
            "reference_eval_batches": 20, "reference_eval_batch_size": evaluation_batch,
            "reference_eval_positions_per_language": 20 * evaluation_batch * sequence,
            "exact_token_milestones": list(pilot.milestones), "checkpoint_every_tokens": pilot.checkpoint_every_tokens,
            "pilot_config_sha256": pilot.config_sha256, "pilot_code_sha256": pilot.code_sha256,
            "learning_rate_decay_tokens": lr_decay_tokens})
    if comparison:
        settings.update({"task": "bilingual_frozen_comparison", "comparison": comparison.identity})
    if early_stop_flat_tokens is not None:
        settings["early_stop_flat_tokens"] = early_stop_flat_tokens
    anchor_settings = _anchored_comparison_settings(anchor, settings) if anchor else None
    recovery_settings_path = None
    original_comparison_settings = None
    if resume:
        previous = json.loads((out / "settings.json").read_text(encoding="utf-8"))
        if recovery:
            original_comparison_settings = _original_comparison_settings(settings, recovery)
            if previous != original_comparison_settings:
                raise ValueError("Rule 4 recovery may change only pinned code provenance and execution microbatch grouping.")
            recovery_settings_path = out / f"settings-recovery-{pilot.config_sha256}.json"
            if recovery_settings_path.exists():
                if json.loads(recovery_settings_path.read_text(encoding="utf-8")) != settings:
                    raise ValueError("Existing comparison recovery settings receipt changed.")
                recovery_settings_path = None
        elif not pilot and previous.get("trainer_sha256") in (LEGACY_ADAPTATION_SHA256, PRE_COMPARISON_ADAPTATION_SHA256):
            # The prior warm-start path uses the same optimizer, batches and RNG state.
            settings["trainer_sha256"] = previous["trainer_sha256"]
        if not recovery and previous != settings:
            raise ValueError("Resume settings/data/trainer differ from the original run.")
    else:
        out.mkdir(parents=True, exist_ok=False)
        _atomic_json(out / "settings.json", settings)
    torch.manual_seed(seed)
    model = ExecutionModel(config)
    initialization_sha256 = _weights_digest(model) if comparison else None
    model = model.to(device)
    if payload is not None:
        model.load_state_dict(payload["model_state"], strict=True)
    del payload
    if guard is not None:
        model.register_forward_pre_hook(lambda *_: guard.check())
    optimizer = torch.optim.AdamW([
        {"params": [p for p in model.parameters() if p.ndim >= 2], "weight_decay": 0.1},
        {"params": [p for p in model.parameters() if p.ndim < 2], "weight_decay": 0.0}],
        lr=peak_lr, betas=(0.9, 0.95), fused=device == "cuda")
    generator = torch.Generator().manual_seed(seed + 1)
    language_rng = random.Random(seed + 2)
    arrays = {name: np.memmap(directory / name, dtype="<u2", mode="r")
              for name, directory in (train_files | validation_files).items()}
    step, processed, best, best_step, best_hash, best_tokens = 0, 0, None, None, None, None
    language_tokens = {"ar": 0, "en": 0}
    prior_seconds = last_checkpoint_tokens = 0
    last_eval: dict[str, float] = {}
    last_development = None
    checkpoint_directory = out / "checkpoints"
    if pilot:
        checkpoint_directory.mkdir(exist_ok=True)
    resume_checkpoint = (_latest_pilot_checkpoint(checkpoint_directory) if pilot else out / "last.pt") if resume else None
    restoring_anchor = resume_checkpoint is None and anchor is not None
    if restoring_anchor:
        resume_checkpoint = anchor.checkpoint
    if recovery and resume_checkpoint is None:
        raise ValueError("Rule 4 recovery has no immutable optimizer checkpoint.")
    if resume_checkpoint is not None:
        state = torch.load(resume_checkpoint, map_location="cpu", weights_only=True)
        if restoring_anchor:
            if (state["settings"] != anchor_settings or state["processed_tokens"] != anchor.positions
                    or state["language_tokens"] != dict.fromkeys(LANGUAGES, anchor.positions // 2)):
                raise ValueError("Comparison continuation checkpoint payload differs from its pinned manifest.")
        elif state["settings"] != settings:
            if (not recovery or state["settings"] != original_comparison_settings
                    or state["processed_tokens"] != recovery.checkpoint_positions
                    or _sha256(resume_checkpoint) != recovery.checkpoint_sha256):
                raise ValueError("Resume checkpoint belongs to another run or is not the pinned Rule 4 recovery anchor.")
        if recovery and state["processed_tokens"] < recovery.checkpoint_positions:
            raise ValueError("Recovery checkpoint precedes the authorized recovery anchor.")
        if comparison and state.get("initial_weights_sha256") != initialization_sha256:
            raise ValueError("Resume checkpoint has different comparison initialization.")
        model.load_state_dict(state["model_state"], strict=True)
        optimizer.load_state_dict(state["optimizer_state"])
        generator.set_state(state["generator_state"])
        language_rng.setstate(state["language_rng_state"])
        torch.set_rng_state(state["torch_rng_state"])
        if device == "cuda" and state.get("cuda_rng_state") is not None:
            torch.cuda.set_rng_state(state["cuda_rng_state"], device)
        step, processed, best, best_step = state["step"], state["processed_tokens"], state["best"], state["best_step"]
        best_hash, language_tokens = state["best_checkpoint_sha256"], state["language_tokens"]
        best_tokens = state.get("best_checkpoint_tokens")
        if pilot and best_tokens is not None:
            best_manifest = checkpoint_directory / f"tokens-{best_tokens:012d}" / "manifest.json"
            if anchor and best_tokens <= anchor.positions:
                best_manifest = anchor.checkpoint.parent.parent / best_manifest.parent.name / "manifest.json"
            best_hash = json.loads(best_manifest.read_text(encoding="utf-8"))["checkpoint_sha256"]
        prior_seconds = state.get("elapsed_seconds", 0.0)
        last_eval = state.get("last_validation", {})
        last_development = state.get("last_development")
        last_checkpoint_tokens = processed
        del state
    if comparison:
        comparison.sampler.seek(processed, step)
    if recovery_settings_path is not None:
        _atomic_json(recovery_settings_path, settings)
    started = time.perf_counter()
    log_directory = pilot.attempt_output if pilot else out
    log = (log_directory / "log.jsonl").open("a" if resume and not pilot else "x", encoding="utf-8")

    def report(status: str, error: str | None = None):
        result = {"status": status, "step": step, "processed_tokens": processed, "language_tokens": language_tokens,
                  "best_weighted_validation_loss": best, "best_step": best_step,
                  "best_checkpoint_sha256": best_hash, "last_validation": last_eval,
                  "minutes": round((prior_seconds + time.perf_counter() - started) / 60, 2),
                  "updated_at": datetime.now(timezone.utc).isoformat(), "settings": settings,
                  "ready_for_chat": False}
        if error:
            result["error"] = error
        if pilot:
            result.update({"last_checkpoint_tokens": last_checkpoint_tokens, "best_checkpoint_tokens": best_tokens,
                           "attempt": str(log_directory)})
        if comparison:
            result.update({"initial_weights_sha256": initialization_sha256, "last_development": last_development})
        _atomic_json(out / "status.json", result)
        return result

    def save_resume(validation: dict | None = None, sampling_receipt: dict | None = None,
                    stop_recovery: dict | None = None):
        nonlocal last_checkpoint_tokens, best_hash
        state = {"model_state": model.state_dict(), "config": config.to_dict(),
            "settings": settings, "optimizer_state": optimizer.state_dict(), "generator_state": generator.get_state(),
            "language_rng_state": language_rng.getstate(), "torch_rng_state": torch.get_rng_state(),
            "cuda_rng_state": torch.cuda.get_rng_state(device) if device == "cuda" else None,
            "step": step, "processed_tokens": processed, "language_tokens": language_tokens,
            "best": best, "best_step": best_step, "best_checkpoint_sha256": best_hash,
            "elapsed_seconds": prior_seconds + time.perf_counter() - started}
        if pilot:
            state.update({"best_checkpoint_tokens": best_tokens, "last_validation": last_eval})
            if comparison:
                state.update({"initial_weights_sha256": initialization_sha256, "last_development": last_development,
                              "comparison_sampling_receipt": sampling_receipt})
            if stop_recovery is not None:
                state["stop_recovery"] = stop_recovery
            digest = _publish_pilot_checkpoint(checkpoint_directory, state, validation=validation or {},
                                               milestone=processed in pilot.milestones)
            last_checkpoint_tokens = processed
            if processed == best_tokens:
                best_hash = digest
        else:
            _atomic_checkpoint(out / "last.pt", state)

    def evaluate_and_save():
        nonlocal best, best_step, best_hash, best_tokens, last_eval, last_development
        last_eval = {lang: _evaluate(model, arrays[f"{lang}.validation.bin"], batches=20,
                                    batch=evaluation_batch, length=sequence, device=device) for lang in LANGUAGES}
        if not all(math.isfinite(value) for value in last_eval.values()):
            raise ValueError("Nonfinite validation loss.")
        combined = arabic_fraction * last_eval["ar"] + (1 - arabic_fraction) * last_eval["en"]
        record = {"step": step, "tokens": processed, "validation": last_eval, "weighted_validation": combined}
        sampling_receipt = None
        if comparison:
            sampling_receipt = comparison.sampler.receipt(processed)
            output = log_directory / f"development-{processed:012d}"
            scored = comparison.development.evaluate(model, device=device, output=output, batch_size=microbatch,
                                                     progress_check=guard.check if guard is not None else None)
            last_development = {"output": output.relative_to(REPOSITORY_ROOT).as_posix(),
                                "manifest_sha256": _sha256(output / "manifest.json"),
                                "strata": scored["strata"], "equal_weight_prose_loss": scored["equal_weight_prose_loss"]}
            record.update(development=last_development, comparison_sampling_receipt=sampling_receipt,
                          initial_weights_sha256=initialization_sha256)
        if best is None or combined < best:
            best, best_step = combined, step
            if pilot:
                best_tokens = processed
            else:
                best_hash = _atomic_checkpoint(out / "best.pt", {"model_state": model.state_dict(), "config": config.to_dict(),
                    "settings": settings, "step": step, "validation_loss": combined,
                    "checkpoint_kind": "weights_only_warm_start", "schema_version": 2})
            record["best"] = True
        if pilot:
            save_resume(last_eval, sampling_receipt)
        log.write(json.dumps(record) + "\n")
        log.flush()
        if not pilot:
            save_resume()
        report("running")

    status = "running"
    schedule_steps = math.ceil(lr_decay_tokens / tokens_per_step) if pilot else total_steps
    try:
        report(status)
        if pilot:
            event = "continuation" if restoring_anchor else "resume" if resume else "start"
            log.write(json.dumps({"event": event, "checkpoint_tokens": processed,
                                  "checkpoint_step": step}) + "\n")
            log.flush()
        if resume_checkpoint is None:
            if comparison:
                save_resume()
            else:
                evaluate_and_save()
        if guard is not None:
            guard.start_training(out_name)
        model.train()
        while step < total_steps:
            if (out / "STOP").exists():
                status = "paused_by_stop_file"
                break
            if guard is not None:
                guard.check()
            update_started = time.perf_counter()
            schedule_step = processed // tokens_per_step if pilot else step
            learning_rate = _learning_rate(schedule_step, schedule_steps, peak_lr, warmup)
            for group in optimizer.param_groups:
                group["lr"] = learning_rate
            loss_sum = 0.0
            step_language_tokens = {"ar": 0, "en": 0}
            next_milestone = pilot.milestones[bisect_right(pilot.milestones, processed)] if pilot else total_tokens
            positions = min(tokens_per_step, next_milestone - processed) if pilot else tokens_per_step
            if comparison:
                supervised = comparison.sampler.targets(positions)
                input_batches = comparison.sampler.update(positions, device)
            else:
                if pilot:
                    batches = _balanced_batches(positions, sequence, microbatch)
                    supervised = sum(batch * (length - 1) for _, batch, length in batches)
                else:
                    batches = (("ar" if language_rng.random() < arabic_fraction else "en", microbatch, sequence)
                               for _ in range(accumulation))
                    supervised = accumulation * microbatch * (sequence - 1)
                input_batches = ((language, _batches(arrays[f"{language}.train.bin"], batch=batch, length=length,
                                                     generator=generator, device=device))
                                 for language, batch, length in batches)
            for language, ids in input_batches:
                batch, length = ids.shape
                with torch.autocast("cuda", dtype=torch.bfloat16, enabled=device == "cuda"):
                    loss = model(ids, labels=ids).loss
                    if comparison or (pilot and positions != tokens_per_step):
                        loss = loss * (batch * (length - 1) / supervised)
                    else:
                        loss = loss / accumulation
                if not bool(torch.isfinite(loss)):
                    raise ValueError("Nonfinite training loss; optimizer update refused.")
                loss.backward()
                loss_sum += float(loss.detach())
                step_language_tokens[language] += length * batch
            if comparison and any(value != positions // 2 for value in step_language_tokens.values()):
                raise ValueError("Comparison optimizer update did not receive equal Arabic and English positions.")
            norm = torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0, error_if_nonfinite=True)
            optimizer.step()
            optimizer.zero_grad(set_to_none=True)
            step += 1
            processed += positions
            for language, count in step_language_tokens.items():
                language_tokens[language] += count
            if guard is not None:
                if device == "cuda":
                    torch.cuda.synchronize()
                try:
                    guard.record_training_update(positions, time.perf_counter() - update_started)
                except RuntimeError as error:
                    problem = str(error)
                    if (comparison and positions == tokens_per_step and 0 < processed < total_tokens
                            and processed not in pilot.milestones and problem.startswith("GPU speed stop:")
                            and problem == getattr(guard, "problem", None)):
                        # Optimizer, window cursor and counters all advanced before this guard call.
                        try:
                            save_resume(stop_recovery={"trigger": "rule4_speed_stop", "problem": problem,
                                       "step": step, "tokens": processed, "committed_optimizer_update": True})
                        except Exception as checkpoint_error:
                            error.add_note(f"Rule 4 recovery checkpoint could not be saved: {checkpoint_error}")
                    raise
            if step % 25 == 0:
                log.write(json.dumps({"step": step, "tokens": processed, "train_loss": loss_sum,
                    "lr": learning_rate, "grad_norm": float(norm),
                    "tokens_per_second": round(processed / max(1, prior_seconds + time.perf_counter() - started)),
                    "minutes": round((prior_seconds + time.perf_counter() - started) / 60, 2)}) + "\n")
                log.flush()
                report("running")
            if pilot:
                if processed == next_milestone:
                    evaluate_and_save()
                    if (early_stop_flat_tokens is not None and best_tokens is not None
                            and processed - best_tokens >= early_stop_flat_tokens):
                        status = "early_stopped"
                        break
                elif processed // pilot.checkpoint_every_tokens > last_checkpoint_tokens // pilot.checkpoint_every_tokens:
                    save_resume()
            elif step % eval_every == 0 or step == total_steps:
                evaluate_and_save()
            if max_minutes is not None and time.perf_counter() - started >= max_minutes * 60:
                status = "paused_time_limit"
                break
        else:
            status = "completed"
        if guard is not None:
            guard.check()
        if not pilot or processed > last_checkpoint_tokens:
            save_resume()
        return report(status)
    except (Exception, KeyboardInterrupt) as error:
        status = "interrupted" if isinstance(error, KeyboardInterrupt) else "failed"
        report(status, f"{type(error).__name__}: {error}"[:500])
        # Last saved optimizer checkpoint remains intact. Never publish a partial gradient window.
        raise
    finally:
        log.close()

