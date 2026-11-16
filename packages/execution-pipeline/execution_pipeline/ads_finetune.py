"""Stage 2: teach the pretrained scratch model the four Ads tasks, then generate held-out answers.

Loss covers only the answer tokens (the prompt is masked). Training stops early on
the Ads validation loss. Prompt and answer are tokenized separately, exactly as
generation sees them. Generation is greedy and local; scoring is done by the Ads
checker in TypeScript (scripts/ads-training/score.ts), not here.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import random
import re
import tempfile
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import REPOSITORY_ROOT  # noqa: F401  (extends sys.path)

from execution_model.config import ModelConfig
from execution_model.tokenizer import ByteBPETokenizer

from .pretrain import TextEncoder

ADS_DIR = REPOSITORY_ROOT / "artifacts" / "ads-training" / "dataset"
IGNORE = -100


class FinetuneError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _atomic_write(path: Path, writer: Any) -> None:
    """Publish only a fully written/fsynced file; a failed save leaves the old one intact."""
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            writer(stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _atomic_json(path: Path, value: Any) -> None:
    encoded = (json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")
    _atomic_write(path, lambda stream: stream.write(encoded))


def _atomic_checkpoint(path: Path, payload: dict[str, Any]) -> str:
    import torch
    _atomic_write(path, lambda stream: torch.save(payload, stream))
    return _sha256(path)


def _output_path(run: Path, out_name: str) -> Path:
    if not isinstance(out_name, str) or not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}", out_name):
        raise ValueError("out_name must be one plain folder name inside the run.")
    out = (run / out_name).resolve()
    if not out.is_relative_to(run.resolve()):
        raise ValueError("The output directory must stay inside the run.")
    return out


def _base_path(run: Path, base_checkpoint: Path | None = None) -> Path:
    candidate = Path(base_checkpoint) if base_checkpoint is not None else Path("pretrain/best.pt")
    path = (candidate if candidate.is_absolute() else run / candidate).resolve()
    if not path.is_relative_to(run.resolve()) or path.suffix != ".pt":
        raise FinetuneError("checkpoint_incompatible", "The base checkpoint must be a .pt file inside this run.")
    return path


def load_split(name: str, directory: Path | None = None) -> list[dict[str, Any]]:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", name):
        raise ValueError("Split names must be plain names.")
    with open((directory or ADS_DIR) / f"{name}.jsonl", encoding="utf-8") as stream:
        records = []
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise FinetuneError("invalid_data", f"Invalid JSON in {name}, line {line_number}.") from error
            if (not isinstance(row, dict) or not isinstance(row.get("prompt"), str) or not row["prompt"].strip()
                    or not isinstance(row.get("target"), str) or not row["target"].strip()):
                raise FinetuneError("invalid_data", f"{name}, line {line_number} needs nonempty prompt and target strings.")
            records.append(row)
        return records


NAME_HINT = "names-v1"
OUTPUT_MARK = "\nOutput:\n"


def prompt_text(record: dict[str, Any], hint: str | None = None) -> str:
    """The prompt the model sees. With names-v1, the brief's names are repeated after a space, as
    answers write them ("Wigan" -> " Wigan wigan"), so a whole-word tokenizer can copy unseen names."""
    prompt = record["prompt"]
    if hint != NAME_HINT or not prompt.endswith(OUTPUT_MARK):
        return prompt
    given = record.get("input") or {}
    parts = []
    for field, lower in (("city", True), ("business", False), ("service", True)):
        value = str(given.get(field) or "").strip()
        if value:
            parts.append(f"{value} {value.lower()}" if lower and value.lower() != value else value)
    if not parts:
        return prompt
    return prompt[:-len(OUTPUT_MARK)] + "\nNames: " + " | ".join(parts) + OUTPUT_MARK


def _run_hint(run: Path, out_name: str = "ads-finetune") -> str | None:
    settings = run / out_name / "settings.json"
    return json.loads(settings.read_text(encoding="utf-8")).get("prompt_hint") if settings.exists() else None


def encode_pair(encoder: TextEncoder, record: dict[str, Any], hint: str | None = None) -> tuple[list[int], list[int]]:
    prompt = encoder.encode(prompt_text(record, hint))
    answer = encoder.encode(record["target"]) + [encoder.tokenizer.eos_token_id]
    return prompt + answer, [IGNORE] * len(prompt) + answer


def _batch(rows: list[tuple[list[int], list[int]]], pad: int, device: str) -> tuple[Any, Any, Any]:
    import torch
    width = max(len(ids) for ids, _ in rows)
    ids = torch.full((len(rows), width), pad, dtype=torch.long)
    labels = torch.full((len(rows), width), IGNORE, dtype=torch.long)
    mask = torch.zeros((len(rows), width), dtype=torch.bool)
    for index, (row_ids, row_labels) in enumerate(rows):
        ids[index, :len(row_ids)] = torch.tensor(row_ids)
        labels[index, :len(row_labels)] = torch.tensor(row_labels)
        mask[index, :len(row_ids)] = True
    return ids.to(device), mask.to(device), labels.to(device)


def _validation_loss(model: Any, rows: list, pad: int, device: str, batch: int) -> float:
    import torch
    if not rows:
        raise FinetuneError("invalid_data", "Validation requires at least one example.")
    was_training = model.training
    model.eval()
    total, count = 0.0, 0
    try:
        with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16, enabled=device == "cuda"):
            for start in range(0, len(rows), batch):
                chunk = rows[start:start + batch]
                ids, mask, labels = _batch(chunk, pad, device)
                answer_tokens = int((labels[:, 1:] != IGNORE).sum())
                loss = float(model(ids, attention_mask=mask, labels=labels).loss)
                if answer_tokens <= 0 or not math.isfinite(loss):
                    raise FinetuneError("nonfinite_loss", "Validation loss is not finite or has no answer tokens.")
                total += loss * answer_tokens
                count += answer_tokens
    finally:
        model.train(was_training)
    return total / count


def _balanced_language_groups(records: list[dict[str, Any]], split: str) -> dict[str, list[int]]:
    """Use source row positions, never copied records or invented unique examples."""
    groups: dict[str, list[int]] = {"ar": [], "en": []}
    for index, record in enumerate(records):
        nested = record.get("input")
        nested_language = nested.get("language") if isinstance(nested, dict) else None
        language = record.get("language")
        if language is None:
            language = nested_language
        if (not isinstance(language, str) or language not in groups or (nested_language is not None and nested_language != language)
                or record.get("split", split) != split):
            raise FinetuneError("invalid_data", f"Balanced {split} requires ar/en language metadata and matching split metadata on every row.")
        groups[language].append(index)
    if not all(groups.values()):
        raise FinetuneError("invalid_data", f"Balanced {split} requires retained examples in both ar and en.")
    return groups


def _balanced_epoch_batches(groups: dict[str, list[int]], rng: random.Random, batch: int,
                            lengths: list[int] | None = None, full_batches: bool = False) -> list[list[int]]:
    """Equal row/update exposure with homogeneous-language batches, including tails."""
    size = max(len(pool) for pool in groups.values())
    if full_batches:
        size = math.ceil(size / batch) * batch
    batches = []
    for language in sorted(groups):
        pool, selected = groups[language], []
        while len(selected) < size:
            cycle = list(pool)
            rng.shuffle(cycle)
            selected.extend(cycle[:size - len(selected)])
        if lengths is not None:
            window = batch * 50
            selected = [index for begin in range(0, len(selected), window)
                        for index in sorted(selected[begin:begin + window], key=lambda index: lengths[index])]
        batches.extend(selected[begin:begin + batch] for begin in range(0, size, batch))
    rng.shuffle(batches)
    return batches


def _balanced_validation_metrics(model: Any, rows: list, groups: dict[str, list[int]],
                                 pad: int, device: str, batch: int) -> dict[str, Any]:
    metrics = {}
    for language, indices in sorted(groups.items()):
        subset = [rows[index] for index in indices]
        tokens = sum(sum(label != IGNORE for label in labels[1:]) for _, labels in subset)
        metrics[language] = {"answer_loss": _validation_loss(model, subset, pad, device, batch),
                             "answer_tokens": tokens, "examples": len(subset)}
    return {"selection_metric": "macro_language_answer_loss",
            "macro_language_answer_loss": sum(item["answer_loss"] for item in metrics.values()) / len(metrics),
            "pooled_answer_loss": sum(item["answer_loss"] * item["answer_tokens"] for item in metrics.values())
                                  / sum(item["answer_tokens"] for item in metrics.values()),
            "per_language": metrics}


def _source_validation_metrics(model: Any, rows: list, records: list[dict[str, Any]],
                               pad: int, device: str, batch: int) -> dict[str, Any]:
    """Report each source/language cell without changing the selection metric."""
    groups: dict[str, list[int]] = {}
    for index, record in enumerate(records):
        key = str(record.get("source", "unspecified")) + ":" + str(record.get("language", "unspecified"))
        groups.setdefault(key, []).append(index)
    result = {}
    for key, indices in sorted(groups.items()):
        subset = [rows[index] for index in indices]
        result[key] = {"answer_loss": _validation_loss(model, subset, pad, device, batch),
                       "examples": len(subset),
                       "answer_tokens": sum(sum(label != IGNORE for label in labels[1:]) for _, labels in subset)}
    return result


def _load_payload(run: Path, path: Path) -> tuple[dict[str, Any], TextEncoder, ModelConfig]:
    import torch
    payload = torch.load(path, map_location="cpu", weights_only=True)
    config = ModelConfig.from_dict(payload["config"])
    encoder = TextEncoder(run)
    metadata = payload.get("settings")
    if not isinstance(metadata, dict):
        # Legacy fine-tunes kept identities in the adjacent settings file.
        settings_path = path.parent / "settings.json"
        metadata = json.loads(settings_path.read_text(encoding="utf-8")) if settings_path.exists() else {}
    if (metadata.get("tokenizer_identity") != encoder.tokenizer.identity
            or metadata.get("config_identity") != config.identity
            or config.vocab_size != encoder.tokenizer.vocab_size):
        raise FinetuneError("checkpoint_incompatible", "Checkpoint model/tokenizer identity does not match this run.")
    for key, filename in (("tokenizer_sha256", "tokenizer.json"), ("tokenizer_report_sha256", "tokenizer-report.json")):
        if metadata.get(key) is not None and (not (run / filename).exists() or _sha256(run / filename) != metadata[key]):
            raise FinetuneError("checkpoint_incompatible", "The tokenizer or pre-tokenization settings changed after this checkpoint.")
    base_settings = run / "pretrain" / "settings.json"
    if base_settings.exists():
        expected = json.loads(base_settings.read_text(encoding="utf-8"))
        if expected.get("config_identity") != config.identity or expected.get("tokenizer_identity") != encoder.tokenizer.identity:
            raise FinetuneError("checkpoint_incompatible", "Checkpoint architecture differs from this run's scratch base.")
    return payload, encoder, config


def _load_pretrained(run: Path, device: str, base_checkpoint: Path | None = None) -> tuple[Any, ByteBPETokenizer, ModelConfig]:
    from execution_model.model import ExecutionModel
    payload, encoder, config = _load_payload(run, _base_path(run, base_checkpoint))
    model = ExecutionModel(config)
    model.load_state_dict(payload["model_state"], strict=True)
    return model.to(device), encoder.tokenizer, config


def finetune(run: Path, *, epochs: int = 3, batch: int = 32, peak_lr: float = 2e-4, warmup: int = 100,
             eval_every: int = 150, patience: int = 4, limit: int | None = None, data_dir: Path | None = None,
             device: str = "cuda", seed: int = 5, hint: str | None = None, out_name: str = "ads-finetune",
             drop_long: bool = False, group_by_length: bool = False, base_checkpoint: Path | None = None,
             balanced_languages: bool = False, accumulation: int = 1, max_steps: int | None = None,
             source_metrics: bool = False, verify_step_zero: bool = False,
             progress_check: Any = None, preserve_evaluations: bool = False,
             training_update: Any = None) -> dict[str, Any]:
    """With drop_long, examples above the context are left out (and counted) instead of stopping the run.
    With group_by_length, each batch holds examples of similar length, so short ones are not padded to long ones.
    An explicit base_checkpoint warm-starts weights within this scratch run; it is NOT an exact optimizer resume.
    Existing output directories are never overwritten. Choose a new out_name for each experiment.
    With balanced_languages, homogeneous-language batches give ar/en equal row exposure and
    equal optimizer-update counts per epoch. Validation uses the mean language answer loss.
    training_update receives processed token positions and active seconds per optimizer update.
    """
    import torch
    for name, value in {"epochs": epochs, "batch": batch, "eval_every": eval_every, "patience": patience,
                        "accumulation": accumulation}.items():
        if type(value) is not int or value < 1:
            raise ValueError(f"{name} must be a positive integer.")
    if type(warmup) is not int or warmup < 0 or type(seed) is not int or not 0 <= seed < 2**63:
        raise ValueError("warmup and seed must be nonnegative integers (seed < 2**63).")
    if type(peak_lr) not in (int, float) or not math.isfinite(peak_lr) or peak_lr <= 0:
        raise ValueError("peak_lr must be finite and positive.")
    if limit is not None and (type(limit) is not int or limit < 1):
        raise ValueError("limit must be a positive integer or None.")
    if max_steps is not None and (type(max_steps) is not int or max_steps < 1):
        raise ValueError("max_steps must be a positive integer or None.")
    if accumulation > 1 and not balanced_languages:
        raise ValueError("Accumulation currently requires balanced_languages for a defined language objective.")
    if device not in {"cpu", "cuda"} or hint not in {None, NAME_HINT}:
        raise ValueError("Unsupported device or prompt hint.")
    if type(balanced_languages) is not bool:
        raise ValueError("balanced_languages must be a boolean.")
    run = run.resolve()
    out = _output_path(run, out_name)
    # Exclusive creation also prevents a second trainer from clobbering a running experiment.
    out.mkdir(parents=True, exist_ok=False)
    started, step, stale, best, best_step = time.perf_counter(), 0, 0, None, None
    best_hash, last_hash, log = None, None, None
    exposures = {"ar": 0, "en": 0}
    language_updates = {"ar": 0, "en": 0}
    seen: dict[str, set[int]] = {"ar": set(), "en": set()}
    validation_metrics, best_validation_metrics = None, None
    settings: dict[str, Any] = {"epochs": epochs, "batch": batch, "peak_lr": peak_lr, "warmup": warmup,
                               "eval_every": eval_every, "patience": patience, "seed": seed, "limit": limit,
                               "device": device, "prompt_hint": hint, "drop_long": drop_long, "group_by_length": group_by_length,
                               "balanced_languages": balanced_languages,
                               "accumulation": accumulation, "effective_batch": batch * accumulation,
                               "max_steps": max_steps, "source_metrics": source_metrics,
                               "preserve_evaluations": preserve_evaluations,
                               "validation_selection_metric": "macro_language_answer_loss" if balanced_languages else "pooled_answer_loss"}

    def training_progress() -> dict[str, Any]:
        return {"row_exposures_by_language": dict(exposures), "row_exposures": sum(exposures.values()),
                "optimizer_updates_by_language": dict(language_updates), "optimizer_updates": sum(language_updates.values()),
                "unique_train_rows_seen_by_language": {language: len(indices) for language, indices in seen.items()},
                "unique_train_rows_seen": sum(len(indices) for indices in seen.values()),
                "unique_row_definition": "Distinct retained source row positions; repeated sampling is exposure, not a new example."}

    def report(status: str, error: BaseException | None = None) -> dict[str, Any]:
        value = {"status": status, "steps": step, "best_validation_loss": round(best, 4) if best is not None else None,
                 "best_step": best_step, "best_checkpoint_sha256": best_hash, "last_checkpoint_sha256": last_hash,
                 "minutes": round((time.perf_counter() - started) / 60, 1),
                 "updated_at": datetime.now(timezone.utc).isoformat()}
        if balanced_languages:
            value.update({"training_progress": training_progress(), "last_validation_metrics": validation_metrics,
                          "best_validation_metrics": best_validation_metrics,
                          "validation_selection_metric": settings["validation_selection_metric"]})
        if error is not None:
            code = ("interrupted" if isinstance(error, KeyboardInterrupt) else
                    "cuda_out_of_memory" if isinstance(error, torch.cuda.OutOfMemoryError) else
                    getattr(error, "code", "io_error" if isinstance(error, OSError) else "training_error"))
            value["error"] = {"code": code, "type": type(error).__name__, "message": str(error)[:600]}
        _atomic_json(out / "status.json", value | {"settings": settings})
        return value

    try:
        report("starting")
        if device == "cuda" and (not torch.cuda.is_available() or not torch.cuda.is_bf16_supported()):
            raise FinetuneError("device_unavailable", "CUDA with BF16 support is required for device='cuda'.")
        random.seed(seed)
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
        source = _base_path(run, base_checkpoint)
        base_hash = _sha256(source)
        tokenizer_hash = _sha256(run / "tokenizer.json")
        tokenizer_report_hash = _sha256(run / "tokenizer-report.json") if (run / "tokenizer-report.json").exists() else None
        dataset = (data_dir or ADS_DIR).resolve()
        data_hashes = {name: _sha256(dataset / f"{name}.jsonl") for name in ("train", "validation")}
        model, tokenizer, config = _load_pretrained(run, device, source)
        if progress_check is not None:
            model.register_forward_pre_hook(lambda *_: progress_check())
        encoder = TextEncoder(run)
        if _sha256(source) != base_hash:
            raise FinetuneError("checkpoint_changed", "The base checkpoint changed during loading.")
        train_records = load_split("train", dataset)[:limit]
        validation_records = load_split("validation", dataset)[:limit]
        if balanced_languages:
            _balanced_language_groups(train_records, "train")
            _balanced_language_groups(validation_records, "validation")
        train_rows = [encode_pair(encoder, row, hint) for row in train_records]
        validation_rows = [encode_pair(encoder, row, hint) for row in validation_records]
        if any(_sha256(dataset / f"{name}.jsonl") != digest for name, digest in data_hashes.items()):
            raise FinetuneError("data_changed", "Dataset files changed while being encoded.")
        current_report_hash = _sha256(run / "tokenizer-report.json") if (run / "tokenizer-report.json").exists() else None
        if (_sha256(run / "tokenizer.json") != tokenizer_hash or current_report_hash != tokenizer_report_hash
                or encoder.tokenizer.identity != tokenizer.identity):
            raise FinetuneError("tokenizer_changed", "Tokenizer files changed while training examples were encoded.")
        fits = lambda row: len(row[0]) <= config.max_context_length  # noqa: E731
        dropped = {"train": sum(not fits(row) for row in train_rows), "validation": sum(not fits(row) for row in validation_rows)}
        def tag(record: dict[str, Any], name: str) -> str:
            value = record.get(name)
            if name == "language" and value is None and isinstance(record.get("input"), dict):
                value = record["input"].get("language")
            return value if isinstance(value, str) and value else "unspecified"

        over_context_detail = {
            split: {name: dict(sorted(Counter(tag(record, name) for record, row in zip(records, rows) if not fits(row)).items()))
                    for name in ("language", "capability")}
            for split, records, rows in (("train", train_records, train_rows), ("validation", validation_records, validation_rows))
        }
        if drop_long:
            train_records = [record for record, row in zip(train_records, train_rows) if fits(row)]
            validation_records = [record for record, row in zip(validation_records, validation_rows) if fits(row)]
            train_rows, validation_rows = [row for row in train_rows if fits(row)], [row for row in validation_rows if fits(row)]
        if not train_rows or not validation_rows:
            raise FinetuneError("invalid_data", "Training and validation must both contain examples that fit the context.")
        longest = max(len(ids) for ids, _ in train_rows + validation_rows)
        if longest > config.max_context_length:
            raise FinetuneError("context_overflow", f"An example has {longest} tokens, above the context limit.")
        train_groups = _balanced_language_groups(train_records, "train") if balanced_languages else None
        validation_groups = _balanced_language_groups(validation_records, "validation") if balanced_languages else None
        effective_batch = batch * accumulation
        epoch_exposures = 2 * max(map(len, train_groups.values())) if train_groups else len(train_rows)
        if train_groups and accumulation > 1:
            epoch_exposures = 2 * math.ceil((epoch_exposures // 2) / effective_batch) * effective_batch
        steps_per_epoch = 2 * math.ceil((epoch_exposures // 2) / effective_batch) if train_groups else math.ceil(epoch_exposures / batch)
        total_steps = steps_per_epoch * epochs
        if max_steps is not None:
            total_steps = min(total_steps, max_steps)
        settings.update({"base": source.relative_to(run).as_posix(), "base_checkpoint_sha256": base_hash,
                         "continuation": "weights_only_new_optimizer", "train_examples": len(train_rows),
                         "validation_examples": len(validation_rows), "longest_tokens": longest, "total_steps": total_steps,
                         "loss": "answer tokens only", "tokenizer_identity": tokenizer.identity, "config_identity": config.identity,
                         "tokenizer_sha256": tokenizer_hash, "tokenizer_report_sha256": tokenizer_report_hash,
                         "trainer_sha256": _sha256(Path(__file__)), "torch_version": str(torch.__version__),
                         "data_dir": str(dataset), "dataset_sha256": data_hashes, "over_context": dropped,
                         "tokens_by_split": {name: {"sequence_tokens": sum(len(ids) for ids, _ in rows),
                            "answer_tokens": sum(sum(label != IGNORE for label in labels[1:]) for _, labels in rows)}
                            for name, rows in (("train", train_rows), ("validation", validation_rows))},
                         "over_context_by_metadata": over_context_detail,
                         "languages": sorted({tag(row, "language") for row in train_records} - {"unspecified"}),
                         "capabilities": sorted({tag(row, "capability") for row in train_records} - {"unspecified"}),
                         "examples_by_metadata": {
                             split: {name: dict(sorted(Counter(tag(row, name) for row in records).items()))
                                     for name in ("language", "capability")}
                             for split, records in (("train", train_records), ("validation", validation_records))}})
        if train_groups:
            settings.update({"training_row_exposures_per_epoch": epoch_exposures,
                             "training_row_exposures_per_language_per_epoch": epoch_exposures // 2,
                             "optimizer_updates_per_language_per_epoch": steps_per_epoch // 2,
                             "language_balance_method": "Shuffle/cycle each source pool to majority size, optionally group lengths within each language, then shuffle homogeneous-language batches including separate partial tails.",
                             "balanced_language_objective": "Equal ar/en optimizer-update frequency; each batch loss is its own language's mean answer-token loss."})
        _atomic_json(out / "settings.json", settings)
        pad = tokenizer.pad_token_id
        optimizer = torch.optim.AdamW([{"params": [p for p in model.parameters() if p.ndim >= 2], "weight_decay": 0.1},
                                       {"params": [p for p in model.parameters() if p.ndim < 2], "weight_decay": 0.0}],
                                      lr=peak_lr, betas=(0.9, 0.95), fused=device == "cuda")
        # Model construction may seed its own initialization; reset before stochastic training.
        torch.manual_seed(seed)
        order_rng = random.Random(seed)

        def save(name: str, validation: float) -> str:
            details = {"training_progress": training_progress(), "validation_metrics": validation_metrics} if balanced_languages else {}
            payload = {"model_state": model.state_dict(), "config": config.to_dict(),
                                      "step": step, "validation_loss": validation, "settings": settings,
                                      "checkpoint_kind": "weights_only_warm_start", "schema_version": 2, **details}
            if preserve_evaluations:
                snapshot = out / "checkpoints" / f"step-{step:06d}"
                if not snapshot.exists():
                    snapshot.mkdir(parents=True, exist_ok=False)
                    digest = _atomic_checkpoint(snapshot / "checkpoint.pt", payload)
                    _atomic_json(snapshot / "manifest.json", {
                        "checkpoint_sha256": digest, "step": step, "validation_loss": validation,
                        "validation_metrics": validation_metrics, "rows": {"train": len(train_rows), "validation": len(validation_rows)},
                        "tokens": settings["tokens_by_split"], "data_sha256": data_hashes,
                        "tokenizer_sha256": tokenizer_hash, "code_sha256": {"ads_finetune.py": settings["trainer_sha256"]},
                        "checkpoint_kind": "weights_only_warm_start"})
            return _atomic_checkpoint(out / name, payload)

        def validate() -> float:
            nonlocal validation_metrics
            if progress_check is not None:
                progress_check()
            if balanced_languages:
                validation_metrics = _balanced_validation_metrics(model, validation_rows, validation_groups, pad, device, batch)
                if source_metrics:
                    validation_metrics["per_source_language"] = _source_validation_metrics(
                        model, validation_rows, validation_records, pad, device, batch)
                return validation_metrics["macro_language_answer_loss"]
            return _validation_loss(model, validation_rows, pad, device, batch)

        best = validate()
        if verify_step_zero:
            first_metrics = validation_metrics
            model.train()
            repeated = validate()
            _atomic_json(out / "step-zero-equivalence.json", {
                "same_callable": "validate -> _balanced_validation_metrics -> _validation_loss",
                "initial": best, "repeated_from_train_mode": repeated,
                "absolute_difference": abs(best - repeated), "exact_match": best == repeated,
                "initial_metrics": first_metrics, "repeated_metrics": validation_metrics,
                "model_training_mode_restored": model.training})
            if best != repeated:
                raise FinetuneError("step_zero_mismatch", "Identical step-zero validation did not reproduce exactly.")
        best_step = 0
        best_hash = save("best.pt", best)
        best_validation_metrics = validation_metrics
        log = open(out / "log.jsonl", "w", encoding="utf-8")
        log.write(json.dumps({"step": 0, "validation_loss": round(best, 4),
                             **({"validation_metrics": validation_metrics} if balanced_languages else {})}) + "\n")
        log.flush()
        report("running")
        status = "completed"
        interval_loss_sum, interval_updates = 0.0, 0
        model.train()
        for epoch in range(epochs):
            if train_groups:
                batches = _balanced_epoch_batches(train_groups, order_rng, effective_batch,
                            [len(row[0]) for row in train_rows] if group_by_length else None,
                            full_batches=accumulation > 1)
            else:
                order = list(range(len(train_rows)))
                order_rng.shuffle(order)
                if group_by_length:
                    window = batch * 50
                    order = [index for begin in range(0, len(order), window)
                             for index in sorted(order[begin:begin + window], key=lambda index: len(train_rows[index][0]))]
                    chunks = [order[begin:begin + batch] for begin in range(0, len(order), batch)]
                    order_rng.shuffle(chunks)
                    order = [index for chunk in chunks for index in chunk]
                batches = [order[begin:begin + batch] for begin in range(0, len(order), batch)]
            for indices in batches:
                update_started = time.perf_counter() if training_update is not None else None
                update_tokens = 0
                ratio = (step + 1) / warmup if step < warmup else 0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * (step - warmup) / max(1, total_steps - warmup)))
                for group in optimizer.param_groups:
                    group["lr"] = peak_lr * ratio
                answer_count = sum(sum(label != IGNORE for label in train_rows[index][1][1:]) for index in indices)
                update_loss = 0.0
                for begin in range(0, len(indices), batch):
                    if progress_check is not None:
                        progress_check()
                    micro_indices = indices[begin:begin + batch]
                    ids, mask, labels = _batch([train_rows[index] for index in micro_indices], pad, device)
                    if training_update is not None:
                        update_tokens += ids.numel()
                    with torch.autocast("cuda", dtype=torch.bfloat16, enabled=device == "cuda"):
                        loss = model(ids, attention_mask=mask, labels=labels).loss
                    if not bool(torch.isfinite(loss)):
                        raise FinetuneError("nonfinite_loss", "Training loss is not finite; optimizer update was skipped.")
                    weight = sum(sum(label != IGNORE for label in train_rows[index][1][1:]) for index in micro_indices) / answer_count
                    (loss * weight).backward()
                    update_loss += float(loss.detach()) * weight
                    del loss, ids, mask, labels
                try:
                    torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0, error_if_nonfinite=True)
                except RuntimeError as error:
                    raise FinetuneError("nonfinite_gradients", "Gradient norm is not finite; optimizer update was skipped.") from error
                optimizer.step()
                optimizer.zero_grad(set_to_none=True)
                step += 1
                if update_started is not None:
                    training_update(update_tokens, time.perf_counter() - update_started)
                interval_loss_sum += update_loss
                interval_updates += 1
                if train_groups:
                    language_updates[tag(train_records[indices[0]], "language")] += 1
                    for index in indices:
                        language = tag(train_records[index], "language")
                        exposures[language] += 1
                        seen[language].add(index)
                if step % eval_every == 0 or step == total_steps or step == max_steps:
                    validation = validate()
                    record = {"step": step, "epoch": epoch, "train_loss": round(update_loss, 4),
                              "interval_train_loss": interval_loss_sum / interval_updates,
                              "interval_optimizer_updates": interval_updates,
                              "validation_loss": round(validation, 4), "minutes": round((time.perf_counter() - started) / 60, 1)}
                    if balanced_languages:
                        record.update({"validation_metrics": validation_metrics, "training_progress": training_progress()})
                    last_hash = save("last.pt", validation)
                    if validation < best:
                        candidate_hash = save("best.pt", validation)
                        best, best_step, best_hash, stale = validation, step, candidate_hash, 0
                        best_validation_metrics = validation_metrics
                        record["best"] = True
                    else:
                        stale += 1
                    log.write(json.dumps(record, allow_nan=False) + "\n")
                    log.flush()
                    report("running")
                    interval_loss_sum, interval_updates = 0.0, 0
                    if stale >= patience:
                        status = "early_stopped"
                        break
                if step == max_steps:
                    break
            if status == "early_stopped" or step == max_steps:
                break
        return report(status)
    except (Exception, KeyboardInterrupt) as error:
        try:
            report("interrupted" if isinstance(error, KeyboardInterrupt) else "failed", error)
        except OSError:
            # Disk errors may prevent reporting, but must never replace the original failure.
            pass
        raise
    finally:
        if log is not None:
            log.close()


def generate_answers(run: Path, splits: tuple[str, ...] = ("test", "test_unseen_vertical", "gold"), *,
                     batch: int = 32, max_new_tokens: int = 256, limit: int | None = None,
                     data_dir: Path | None = None, device: str = "cuda", out_name: str = "ads-finetune") -> dict[str, Any]:
    """Greedy answers for held-out briefs, written as JSONL for the TypeScript checker."""
    import torch
    from execution_model.model import ExecutionModel
    checkpoint = _output_path(run, out_name) / "best.pt"
    payload, encoder, config = _load_payload(run, checkpoint)
    tokenizer = encoder.tokenizer
    model = ExecutionModel(config)
    model.load_state_dict(payload["model_state"], strict=True)
    model = model.to(device).eval()
    pad, eos = tokenizer.pad_token_id, tokenizer.eos_token_id
    hint = _run_hint(run, out_name)
    out = run / out_name / "answers"
    out.mkdir(parents=True, exist_ok=True)
    summary: dict[str, Any] = {"checkpoint_step": payload["step"], "checkpoint_sha256": _sha256(checkpoint),
                               "tokenizer_identity": tokenizer.identity, "config_identity": config.identity,
                               "decoding": "greedy", "max_new_tokens": max_new_tokens}
    for split in splits:
        records = load_split(split, data_dir)[:limit]
        started = time.perf_counter()
        lines = []
        for start in range(0, len(records), batch):
            chunk = records[start:start + batch]
            prompts = [encoder.encode(prompt_text(record, hint)) for record in chunk]
            generated: list[list[int]] = [[] for _ in chunk]
            done = [False] * len(chunk)
            # A row stops on EOS, or unfinished once it would pass the context. Only that row
            # stops: one long prompt must not end the batch for the others.
            stopped = [False] * len(chunk)
            for _ in range(max_new_tokens):
                active = [index for index in range(len(chunk)) if not done[index] and not stopped[index]
                          and len(prompts[index]) + len(generated[index]) <= config.max_context_length]
                for index in range(len(chunk)):
                    if not done[index] and index not in active:
                        stopped[index] = True
                if not active:
                    break
                sequences = [prompts[index] + generated[index] for index in active]
                width = max(len(sequence) for sequence in sequences)
                # Left padding: the model numbers positions from the first valid token.
                ids = torch.full((len(active), width), pad, dtype=torch.long)
                mask = torch.zeros((len(active), width), dtype=torch.bool)
                for row, sequence in enumerate(sequences):
                    ids[row, width - len(sequence):] = torch.tensor(sequence)
                    mask[row, width - len(sequence):] = True
                with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16, enabled=device == "cuda"):
                    logits = model(ids.to(device), attention_mask=mask.to(device), last_token_only=True).logits[:, -1]
                for index, token in zip(active, logits.argmax(dim=-1).tolist()):
                    if token == eos:
                        done[index] = True
                    else:
                        generated[index].append(token)
            for record, answer, finished in zip(chunk, generated, done):
                text = tokenizer.decode_bytes(answer).decode("utf-8", "replace")
                lines.append(json.dumps({"id": record["id"], "split": split, "source": record.get("source"),
                                         "capability": record["capability"], "vertical": record.get("vertical"),
                                         "input": record["input"], "expected": record["output"],
                                         "answer_text": text, "finished": finished}, ensure_ascii=False))
        (out / f"{split}.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
        summary[split] = {"examples": len(records), "seconds": round(time.perf_counter() - started, 1),
                          "dataset_sha256": _sha256((data_dir or ADS_DIR) / f"{split}.jsonl")}
    _atomic_json(out / "summary.json", summary)
    return summary


def generate_candidates(run: Path, splits: tuple[str, ...] = ("test", "test_unseen_vertical", "gold"), *,
                        candidates: int = 8, temperature: float = 0.7, top_k: int = 20, batch: int = 96,
                        max_new_tokens: int = 110, limit: int | None = None, data_dir: Path | None = None,
                        device: str = "cuda", seed: int = 21, out_name: str = "ads-finetune") -> dict[str, Any]:
    """Several answers per brief for the checker gate: candidate 0 is greedy, the rest are sampled.

    Rows leave the batch as soon as they emit EOS, so finished answers cost nothing further.
    The gate (scripts/ads-training/gate.ts) decides which candidate, if any, may be shown.
    """
    import torch
    from execution_model.model import ExecutionModel
    checkpoint = _output_path(run, out_name) / "best.pt"
    payload, encoder, config = _load_payload(run, checkpoint)
    tokenizer = encoder.tokenizer
    model = ExecutionModel(config)
    model.load_state_dict(payload["model_state"], strict=True)
    model = model.to(device).eval()
    pad, eos = tokenizer.pad_token_id, tokenizer.eos_token_id
    generator = torch.Generator(device=device).manual_seed(seed)
    hint = _run_hint(run, out_name)
    out = run / out_name / "candidates"
    out.mkdir(parents=True, exist_ok=True)
    summary: dict[str, Any] = {"checkpoint_step": payload["step"], "checkpoint_sha256": _sha256(checkpoint),
                               "tokenizer_identity": tokenizer.identity, "config_identity": config.identity,
                               "prompt_hint": hint, "candidates": candidates, "temperature": temperature,
                               "top_k": top_k, "max_new_tokens": max_new_tokens}
    for split in splits:
        records = load_split(split, data_dir)[:limit]
        started = time.perf_counter()
        jobs = [(index, slot) for index in range(len(records)) for slot in range(candidates)]
        prompts = {index: encoder.encode(prompt_text(record, hint)) for index, record in enumerate(records)}
        answers: dict[tuple[int, int], tuple[list[int], bool]] = {}
        for start in range(0, len(jobs), batch):
            active = jobs[start:start + batch]
            generated = {job: [] for job in active}
            for _ in range(max_new_tokens):
                if not active:
                    break
                sequences = [prompts[job[0]] + generated[job] for job in active]
                width = max(len(sequence) for sequence in sequences)
                ids = torch.full((len(active), width), pad, dtype=torch.long)
                mask = torch.zeros((len(active), width), dtype=torch.bool)
                for row, sequence in enumerate(sequences):
                    ids[row, width - len(sequence):] = torch.tensor(sequence)
                    mask[row, width - len(sequence):] = True
                with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16, enabled=device == "cuda"):
                    logits = model(ids.to(device), attention_mask=mask.to(device), last_token_only=True).logits[:, -1].float()
                greedy = logits.argmax(dim=-1)
                values, indices = logits.topk(top_k, dim=-1)
                sampled = indices.gather(1, torch.multinomial(torch.softmax(values / temperature, dim=-1), 1, generator=generator)).squeeze(1)
                choice = torch.tensor([job[1] == 0 for job in active], device=device)
                tokens = torch.where(choice, greedy, sampled).tolist()
                still = []
                for job, token in zip(active, tokens):
                    if token == eos:
                        answers[job] = (generated[job], True)
                    else:
                        generated[job].append(token)
                        still.append(job)
                active = still
            for job in active:
                answers[job] = (generated[job], False)
        lines = []
        for index, record in enumerate(records):
            texts = []
            for slot in range(candidates):
                ids_, finished = answers[(index, slot)]
                texts.append({"text": tokenizer.decode_bytes(ids_).decode("utf-8", "replace"), "finished": finished})
            lines.append(json.dumps({"id": record["id"], "split": split, "source": record.get("source"),
                                     "capability": record["capability"], "vertical": record.get("vertical"),
                                     "input": record["input"], "expected": record["output"], "candidates": texts},
                                    ensure_ascii=False))
        (out / f"{split}.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
        summary[split] = {"examples": len(records), "seconds": round(time.perf_counter() - started, 1),
                          "dataset_sha256": _sha256((data_dir or ADS_DIR) / f"{split}.jsonl")}
    _atomic_json(out / "summary.json", summary)
    return summary
