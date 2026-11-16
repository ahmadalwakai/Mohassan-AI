"""Continue our own language model on pinned Arabic text and English replay.

The tokenizer and architecture stay unchanged. Fresh runs warm-start model
weights only; resume restores this run's optimizer and sampling RNG exactly.
No external weights, network, chat holdout, or production route are involved.
"""
from __future__ import annotations

import json
import math
import random
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ads_finetune import _atomic_checkpoint, _atomic_json, _base_path, _load_payload, _output_path, _sha256
from .pretrain import _batches, _evaluate, _learning_rate


def corpus_manifest(directory: Path, tokenizer_identity: str, sequence: int) -> dict:
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("tokenizer_identity") != tokenizer_identity:
        raise ValueError("Foundation corpus uses a different tokenizer.")
    for language in ("ar", "en"):
        for split in ("train", "validation"):
            name = f"{language}.{split}.bin"
            file = directory / name
            record = manifest["files"][name]
            if (file.stat().st_size != record["tokens"] * 2 or record["tokens"] <= sequence
                    or _sha256(file) != record["sha256"]):
                raise ValueError(f"Foundation corpus size or hash mismatch: {name}")
    return manifest


def adapt(run: Path, *, corpus: Path, out_name: str, base_checkpoint: Path,
          total_tokens: int = 32_000_000, sequence: int = 512, microbatch: int = 8,
          accumulation: int = 2, peak_lr: float = 2e-4, warmup: int = 100,
          eval_every: int = 200, arabic_fraction: float = 0.75,
          seed: int = 719, device: str = "cuda", resume: bool = False,
          max_minutes: float | None = None) -> dict[str, Any]:
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
    if not math.isfinite(peak_lr) or peak_lr <= 0 or (max_minutes is not None and max_minutes <= 0):
        raise ValueError("Invalid learning rate or duration.")
    if device == "cuda" and (not torch.cuda.is_available() or not torch.cuda.is_bf16_supported()):
        raise ValueError("Requested CUDA BF16 training is not available.")
    run, corpus = run.resolve(), corpus.resolve()
    source = _base_path(run, base_checkpoint)
    source_hash = _sha256(source)
    payload, encoder, config = _load_payload(run, source)
    if sequence > config.max_context_length:
        raise ValueError("Training windows exceed model context.")
    manifest = corpus_manifest(corpus, encoder.tokenizer.identity, sequence)
    tokens_per_step = sequence * microbatch * accumulation
    total_steps = math.ceil(total_tokens / tokens_per_step)
    out = _output_path(run, out_name)
    settings = {"task": "bilingual_language_adaptation", "base": source.relative_to(run).as_posix(),
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
    if resume:
        previous = json.loads((out / "settings.json").read_text(encoding="utf-8"))
        if previous != settings:
            raise ValueError("Resume settings/data/trainer differ from the original run.")
    else:
        out.mkdir(parents=True, exist_ok=False)
        _atomic_json(out / "settings.json", settings)
    torch.manual_seed(seed)
    model = ExecutionModel(config).to(device)
    model.load_state_dict(payload["model_state"], strict=True)
    del payload
    optimizer = torch.optim.AdamW([
        {"params": [p for p in model.parameters() if p.ndim >= 2], "weight_decay": 0.1},
        {"params": [p for p in model.parameters() if p.ndim < 2], "weight_decay": 0.0}],
        lr=peak_lr, betas=(0.9, 0.95), fused=device == "cuda")
    generator = torch.Generator().manual_seed(seed + 1)
    language_rng = random.Random(seed + 2)
    arrays = {name: np.memmap(corpus / name, dtype=np.uint16, mode="r") for name in manifest["files"]
              if name in {f"{lang}.{split}.bin" for lang in ("ar", "en") for split in ("train", "validation")}}
    step, processed, best, best_step, best_hash = 0, 0, None, None, None
    language_tokens = {"ar": 0, "en": 0}
    prior_seconds = 0.0
    if resume:
        state = torch.load(out / "last.pt", map_location="cpu", weights_only=True)
        if state["settings"] != settings:
            raise ValueError("Resume checkpoint belongs to another run.")
        model.load_state_dict(state["model_state"], strict=True)
        optimizer.load_state_dict(state["optimizer_state"])
        generator.set_state(state["generator_state"])
        language_rng.setstate(state["language_rng_state"])
        torch.set_rng_state(state["torch_rng_state"])
        if device == "cuda" and state.get("cuda_rng_state") is not None:
            torch.cuda.set_rng_state(state["cuda_rng_state"], device)
        step, processed, best, best_step = state["step"], state["processed_tokens"], state["best"], state["best_step"]
        best_hash, language_tokens = state["best_checkpoint_sha256"], state["language_tokens"]
        prior_seconds = state.get("elapsed_seconds", 0.0)
        del state
    started = time.perf_counter()
    log = (out / "log.jsonl").open("a" if resume else "x", encoding="utf-8")
    last_eval: dict[str, float] = {}

    def report(status: str, error: str | None = None):
        result = {"status": status, "step": step, "processed_tokens": processed, "language_tokens": language_tokens,
                  "best_weighted_validation_loss": best, "best_step": best_step,
                  "best_checkpoint_sha256": best_hash, "last_validation": last_eval,
                  "minutes": round((prior_seconds + time.perf_counter() - started) / 60, 2),
                  "updated_at": datetime.now(timezone.utc).isoformat(), "settings": settings,
                  "ready_for_chat": False}
        if error:
            result["error"] = error
        _atomic_json(out / "status.json", result)
        return result

    def save_resume():
        _atomic_checkpoint(out / "last.pt", {"model_state": model.state_dict(), "config": config.to_dict(),
            "settings": settings, "optimizer_state": optimizer.state_dict(), "generator_state": generator.get_state(),
            "language_rng_state": language_rng.getstate(), "torch_rng_state": torch.get_rng_state(),
            "cuda_rng_state": torch.cuda.get_rng_state(device) if device == "cuda" else None,
            "step": step, "processed_tokens": processed, "language_tokens": language_tokens,
            "best": best, "best_step": best_step, "best_checkpoint_sha256": best_hash,
            "elapsed_seconds": prior_seconds + time.perf_counter() - started})

    def evaluate_and_save():
        nonlocal best, best_step, best_hash, last_eval
        last_eval = {lang: _evaluate(model, arrays[f"{lang}.validation.bin"], batches=20,
                                    batch=microbatch, length=sequence, device=device) for lang in ("ar", "en")}
        if not all(math.isfinite(value) for value in last_eval.values()):
            raise ValueError("Nonfinite validation loss.")
        combined = arabic_fraction * last_eval["ar"] + (1 - arabic_fraction) * last_eval["en"]
        record = {"step": step, "tokens": processed, "validation": last_eval, "weighted_validation": combined}
        if best is None or combined < best:
            best, best_step = combined, step
            best_hash = _atomic_checkpoint(out / "best.pt", {"model_state": model.state_dict(), "config": config.to_dict(),
                "settings": settings, "step": step, "validation_loss": combined,
                "checkpoint_kind": "weights_only_warm_start", "schema_version": 2})
            record["best"] = True
        log.write(json.dumps(record) + "\n")
        log.flush()
        save_resume()
        report("running")

    status = "running"
    try:
        report(status)
        if not resume:
            evaluate_and_save()
        model.train()
        while step < total_steps:
            if (out / "STOP").exists():
                status = "paused_by_stop_file"
                break
            learning_rate = _learning_rate(step, total_steps, peak_lr, warmup)
            for group in optimizer.param_groups:
                group["lr"] = learning_rate
            loss_sum = 0.0
            step_language_tokens = {"ar": 0, "en": 0}
            for _ in range(accumulation):
                language = "ar" if language_rng.random() < arabic_fraction else "en"
                ids = _batches(arrays[f"{language}.train.bin"], batch=microbatch,
                               length=sequence, generator=generator, device=device)
                with torch.autocast("cuda", dtype=torch.bfloat16, enabled=device == "cuda"):
                    loss = model(ids, labels=ids).loss / accumulation
                if not bool(torch.isfinite(loss)):
                    raise ValueError("Nonfinite training loss; optimizer update refused.")
                loss.backward()
                loss_sum += float(loss.detach())
                step_language_tokens[language] += sequence * microbatch
            norm = torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0, error_if_nonfinite=True)
            optimizer.step()
            optimizer.zero_grad(set_to_none=True)
            step += 1
            processed += tokens_per_step
            for language, count in step_language_tokens.items():
                language_tokens[language] += count
            if step % 25 == 0:
                log.write(json.dumps({"step": step, "tokens": processed, "train_loss": loss_sum,
                    "lr": learning_rate, "grad_norm": float(norm),
                    "tokens_per_second": round(processed / max(1, prior_seconds + time.perf_counter() - started)),
                    "minutes": round((prior_seconds + time.perf_counter() - started) / 60, 2)}) + "\n")
                log.flush()
                report("running")
            if step % eval_every == 0 or step == total_steps:
                evaluate_and_save()
            if max_minutes is not None and time.perf_counter() - started >= max_minutes * 60:
                status = "paused_time_limit"
                break
        else:
            status = "completed"
        save_resume()
        return report(status)
    except (Exception, KeyboardInterrupt) as error:
        status = "interrupted" if isinstance(error, KeyboardInterrupt) else "failed"
        report(status, f"{type(error).__name__}: {error}"[:500])
        # Last saved optimizer checkpoint remains intact. Never publish a partial gradient window.
        raise
    finally:
        log.close()

