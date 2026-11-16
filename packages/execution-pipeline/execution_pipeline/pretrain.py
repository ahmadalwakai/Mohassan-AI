"""Raw-text language pre-training for the scratch ExecutionModel.

The structured trainer in ``execution_training`` learns only prompt -> target
examples. This module adds the missing first stage: next-token prediction over
plain local text (Simple English Wikipedia plus the generated Ads training
documents), from random initialization, on one local GPU.

Steps, each explicit and resumable, all writing under one run directory:
  tokenizer  learn byte-BPE merges from a bounded, deterministic text sample
  encode     tokenize every document into uint16 token files (train / validation)
  train      causal LM on random windows; checkpoints, logs, STOP-file to pause
  benchmark  measure a fresh model shape on fixed bilingual training streams
  export     write the Phase 2 inference layout (status "unverified")

Nothing is downloaded, no pretrained weights or tokenizers are used, and
nothing leaves the machine. Held-out Ads splits never enter these token files.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import random
import re
import time
from dataclasses import replace
from inspect import getfile
from pathlib import Path
from typing import Any, Iterator

from . import PACKAGES_ROOT, REPOSITORY_ROOT  # noqa: F401  (extends sys.path)

from execution_model.config import ModelConfig, model_preset
from execution_model.tokenizer import ByteBPETokenizer

WIKI_DIR = REPOSITORY_ROOT / "artifacts" / "corpora" / "simplewiki-20261101" / "text"
ADS_DIR = REPOSITORY_ROOT / "artifacts" / "ads-training" / "dataset"
VALIDATION_MODULUS = 200  # 0.5% of articles, chosen by title hash, never trained on
ENCODE_CHUNK_CHARS = 500_000  # under the tokenizer's 1 MiB encoding budget


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        while chunk := stream.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def _atomic_json(path: Path, value: Any) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def _is_validation(title: str) -> bool:
    return int(hashlib.sha1(title.encode("utf-8")).hexdigest(), 16) % VALIDATION_MODULUS == 0


def wiki_articles() -> Iterator[tuple[str, str]]:
    """Yield (title, article text). Articles are separated by blank lines; the first line is the title."""
    shards = sorted(WIKI_DIR.glob("shard-*.txt"))
    if not shards:
        raise FileNotFoundError(f"No extracted Wikipedia shards in {WIKI_DIR}")
    for shard in shards:
        # The extractor left non-breaking spaces in some articles; they are ordinary spaces here.
        for block in shard.read_text(encoding="utf-8").replace("\xa0", " ").split("\n\n"):
            block = block.strip()
            if block:
                yield block.split("\n", 1)[0], block


def ads_documents(split: str) -> Iterator[str]:
    """Prompt + target exactly as the fine-tuning stage renders them."""
    with open(ADS_DIR / f"{split}.jsonl", encoding="utf-8") as stream:
        for line in stream:
            record = json.loads(line)
            yield record["prompt"] + record["target"]


# --------------------------------------------------------------------------- tokenizer

def train_tokenizer(run: Path, *, vocab: int = 16384, wiki_bytes: int = 20_000_000,
                    ads_bytes: int = 4_000_000, max_token_bytes: int = 24, seed: int = 11) -> dict[str, Any]:
    started = time.perf_counter()
    rng = random.Random(seed)
    articles = [text for title, text in wiki_articles() if not _is_validation(title)]
    rng.shuffle(articles)
    records: list[bytes] = []
    total = 0
    for text in articles:
        data = text.encode("utf-8")[:262_144]
        if total + len(data) > wiki_bytes:
            break
        records.append(data)
        total += len(data)
    wiki_total = total
    ads = list(ads_documents("train"))
    rng.shuffle(ads)
    for text in ads:
        data = text.encode("utf-8")
        if total - wiki_total + len(data) > ads_bytes:
            break
        records.append(data)
        total += len(data)
    rng.shuffle(records)
    tokenizer = ByteBPETokenizer.train(records, target_vocab_size=vocab, max_corpus_bytes=total,
                                       max_records=len(records), max_token_bytes=max_token_bytes,
                                       isolate_digits=True)
    run.mkdir(parents=True, exist_ok=True)
    tokenizer.save(run / "tokenizer.json")
    report = {"identity": tokenizer.identity, "vocab_size": tokenizer.vocab_size, "records": len(records),
              "wiki_bytes": wiki_total, "ads_bytes": total - wiki_total, "max_token_bytes": max_token_bytes,
              "isolate_digits": True, "seed": seed, "seconds": round(time.perf_counter() - started, 1),
              "sha256": _sha256(run / "tokenizer.json")}
    _atomic_json(run / "tokenizer-report.json", report)
    return report


# Word-boundary pre-tokenizer ("words-v1"): a token never spans two words. Each piece is a
# letter run, one digit, a punctuation run, or whitespace, with at most one leading space.
# Copying a name the model has never seen ("Arbroath" -> "arbroath") then only needs the
# name's own pieces, not a merge that also swallowed the bracket or the next word.
PRETOKENIZER = "words-v1"
PRETOKEN = re.compile(r" ?[^\W\d_]+| ?\d| ?[^\s\w]+| ?_+|\s+(?!\S)|\s+")


def pretokenize(text: str) -> list[str]:
    return PRETOKEN.findall(text)


def train_word_tokenizer(run: Path, *, vocab: int = 16384, min_frequency: int = 2,
                         max_token_bytes: int = 24) -> dict[str, Any]:
    """Frequency-weighted BPE over word pieces from every training document (validation excluded).

    The merges load into the project's own ByteBPETokenizer; ``TextEncoder`` applies them per piece.
    """
    import heapq
    from collections import Counter
    started = time.perf_counter()
    counts: Counter[str] = Counter()
    for title, text in wiki_articles():
        if not _is_validation(title):
            counts.update(pretokenize(text))
    for text in ads_documents("train"):
        counts.update(pretokenize(text))
    base = ByteBPETokenizer(target_vocab_size=vocab)
    first = base.vocab_size
    words = [(list(piece.encode("utf-8")), frequency) for piece, frequency in counts.items()]
    lengths = [1] * first
    pairs: dict[tuple[int, int], int] = {}
    where: dict[tuple[int, int], set[int]] = {}
    for index, (symbols, frequency) in enumerate(words):
        for pair in zip(symbols, symbols[1:]):
            pairs[pair] = pairs.get(pair, 0) + frequency
            where.setdefault(pair, set()).add(index)
    heap = [(-count, pair) for pair, count in pairs.items()]
    heapq.heapify(heap)
    merges: list[tuple[int, int]] = []
    while heap and first + len(merges) < vocab:
        negative, pair = heapq.heappop(heap)
        if pairs.get(pair, 0) != -negative:
            continue
        if -negative < min_frequency:
            break
        if lengths[pair[0]] + lengths[pair[1]] > max_token_bytes:
            pairs.pop(pair)
            continue
        new_id = first + len(merges)
        merges.append(pair)
        lengths.append(lengths[pair[0]] + lengths[pair[1]])
        touched: set[tuple[int, int]] = set()
        for index in where.pop(pair, ()):
            symbols, frequency = words[index]
            if len(symbols) < 2:
                continue
            for old in zip(symbols, symbols[1:]):
                pairs[old] -= frequency
                touched.add(old)
            merged, position = [], 0
            while position < len(symbols):
                if position + 1 < len(symbols) and (symbols[position], symbols[position + 1]) == pair:
                    merged.append(new_id)
                    position += 2
                else:
                    merged.append(symbols[position])
                    position += 1
            for new in zip(merged, merged[1:]):
                pairs[new] = pairs.get(new, 0) + frequency
                where.setdefault(new, set()).add(index)
                touched.add(new)
            words[index] = (merged, frequency)
        pairs.pop(pair, None)
        for item in touched:
            count = pairs.get(item, 0)
            if count > 0 and item != pair:
                heapq.heappush(heap, (-count, item))
            elif item in pairs and count <= 0:
                pairs.pop(item)
    tokenizer = ByteBPETokenizer(merges, target_vocab_size=vocab)
    run.mkdir(parents=True, exist_ok=True)
    tokenizer.save(run / "tokenizer.json")
    report = {"identity": tokenizer.identity, "vocab_size": tokenizer.vocab_size, "pretokenizer": PRETOKENIZER,
              "distinct_pieces": len(counts), "piece_occurrences": sum(counts.values()), "min_frequency": min_frequency,
              "max_token_bytes": max_token_bytes, "normalization": "U+00A0 to space",
              "seconds": round(time.perf_counter() - started, 1), "sha256": _sha256(run / "tokenizer.json")}
    _atomic_json(run / "tokenizer-report.json", report)
    return report


class TextEncoder:
    """The run's tokenizer plus its pre-tokenizer. Use this, not the tokenizer alone, for every encode."""

    def __init__(self, run: Path):
        self.tokenizer = ByteBPETokenizer.load(run / "tokenizer.json")
        report_path = run / "tokenizer-report.json"
        report = json.loads(report_path.read_text(encoding="utf-8")) if report_path.exists() else {}
        self.words = report.get("pretokenizer") == PRETOKENIZER
        self._cache: dict[str, list[int]] = {}

    def encode(self, text: str) -> list[int]:
        if not self.words:
            ids: list[int] = []
            for start in range(0, len(text), ENCODE_CHUNK_CHARS):
                ids.extend(self.tokenizer.encode(text[start:start + ENCODE_CHUNK_CHARS]))
            return ids
        ids = []
        for piece in pretokenize(text):
            cached = self._cache.get(piece)
            if cached is None:
                cached = self.tokenizer.encode(piece)
                if len(self._cache) < 2_000_000:
                    self._cache[piece] = cached
            ids.extend(cached)
        return ids


# --------------------------------------------------------------------------- encoding

_WORKER_ENCODER: TextEncoder | None = None


def _init_worker(run: str) -> None:
    global _WORKER_ENCODER
    _WORKER_ENCODER = TextEncoder(Path(run))


def _encode_document(text: str) -> bytes:
    import numpy as np
    assert _WORKER_ENCODER is not None
    ids = _WORKER_ENCODER.encode(text)
    ids.append(_WORKER_ENCODER.tokenizer.eos_token_id)
    return np.asarray(ids, dtype=np.uint16).tobytes()


def encode_corpus(run: Path, *, workers: int = 12, limit: int | None = None, seed: int = 13) -> dict[str, Any]:
    """Tokenize all documents into uint16 files. ``limit`` caps documents per stream (smoke tests)."""
    from multiprocessing import Pool
    started = time.perf_counter()
    tokenizer_path = run / "tokenizer.json"
    tokenizer = ByteBPETokenizer.load(tokenizer_path)
    if tokenizer.vocab_size > 65_535:
        raise ValueError("uint16 token files need a vocabulary below 65536.")
    train_docs: list[str] = []
    validation_docs: list[str] = []
    for title, text in wiki_articles():
        (validation_docs if _is_validation(title) else train_docs).append(text)
    wiki_train = len(train_docs)
    train_docs += list(ads_documents("train"))
    ads_validation = list(ads_documents("validation"))
    if limit:
        train_docs = train_docs[:limit] + train_docs[wiki_train:wiki_train + limit // 10]
        validation_docs, ads_validation = validation_docs[:limit // 20], ads_validation[:limit // 20]
    random.Random(seed).shuffle(train_docs)  # interleave Ads documents through the text
    data_dir = run / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    counts: dict[str, Any] = {}
    with Pool(workers, initializer=_init_worker, initargs=(str(run),)) as pool:
        for name, docs in (("train", train_docs), ("validation", validation_docs), ("ads_validation", ads_validation)):
            path = data_dir / f"{name}.bin"
            temporary = path.with_name(path.name + ".tmp")
            tokens = 0
            with open(temporary, "wb") as stream:
                for chunk in pool.imap(_encode_document, docs, chunksize=64):
                    stream.write(chunk)
                    tokens += len(chunk) // 2
            os.replace(temporary, path)
            counts[name] = {"documents": len(docs), "tokens": tokens, "sha256": _sha256(path)}
    characters = sum(len(text) for text in train_docs)
    report = {"tokenizer_identity": tokenizer.identity, "files": counts,
              "train_characters": characters,
              "characters_per_token": round(characters / max(counts["train"]["tokens"], 1), 3),
              "ads_train_documents": len(train_docs) - min(wiki_train, len(train_docs)) if not limit else None,
              "limit": limit, "seconds": round(time.perf_counter() - started, 1)}
    _atomic_json(run / "data" / "report.json", report)
    return report


# --------------------------------------------------------------------------- training

def _batches(tokens: Any, *, batch: int, length: int, generator: Any, device: str) -> Any:
    import torch
    starts = torch.randint(0, len(tokens) - length, (batch,), generator=generator).tolist()
    rows = [torch.from_numpy(tokens[start:start + length].astype("int64")) for start in starts]
    return torch.stack(rows).to(device, non_blocking=True)


def _learning_rate(step: int, total: int, peak: float, warmup: int) -> float:
    if step < warmup:
        return peak * (step + 1) / warmup
    progress = min(1.0, (step - warmup) / max(1, total - warmup))
    return peak * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * progress)))


def _evaluate(model: Any, tokens: Any, *, batches: int, batch: int, length: int, device: str) -> float:
    import torch
    generator = torch.Generator().manual_seed(1234)  # same windows every evaluation
    model.eval()
    total = 0.0
    with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16, enabled=device == "cuda"):
        for _ in range(batches):
            ids = _batches(tokens, batch=batch, length=length, generator=generator, device=device)
            total += float(model(ids, labels=ids).loss)
    model.train()
    return total / batches


def _sample(model: Any, encoder: "TextEncoder", prompt: str, *, tokens: int, device: str) -> str:
    import torch
    tokenizer = encoder.tokenizer
    ids = encoder.encode(prompt)
    prompt_length = len(ids)
    model.eval()
    with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16, enabled=device == "cuda"):
        for _ in range(tokens):
            window = torch.tensor([ids[-model.config.max_context_length:]], device=device)
            next_id = int(model(window, last_token_only=True).logits[0, -1].argmax())
            if next_id == tokenizer.eos_token_id:
                break
            ids.append(next_id)
    model.train()
    return tokenizer.decode_bytes(ids[prompt_length:]).decode("utf-8", "replace")


SAMPLE_PROMPTS = ("The capital city of France is", "Water is made of", "Ads task:\n{\"capability\":\"ads.headlines.v1\"")


def model_config(run: Path, preset: str, context: int, seed: int) -> ModelConfig:
    tokenizer = ByteBPETokenizer.load(run / "tokenizer.json")
    return model_preset(preset, vocab_size=tokenizer.vocab_size, max_context_length=context, seed=seed)


def _optimizer(model: Any, peak_lr: float, weight_decay: float, device: str) -> Any:
    import torch

    decay = [parameter for parameter in model.parameters() if parameter.ndim >= 2]
    no_decay = [parameter for parameter in model.parameters() if parameter.ndim < 2]
    return torch.optim.AdamW([{"params": decay, "weight_decay": weight_decay},
                              {"params": no_decay, "weight_decay": 0.0}],
                             lr=peak_lr, betas=(0.9, 0.95), eps=1e-8, fused=device == "cuda")


def _optimizer_update(model: Any, optimizer: Any, batches: Iterator[Any], accumulation: int,
                      device: str) -> tuple[float, float]:
    import torch

    loss_total = 0.0
    for ids in batches:
        with torch.autocast("cuda", dtype=torch.bfloat16, enabled=device == "cuda"):
            loss = model(ids, labels=ids).loss / accumulation
        loss.backward()
        loss_total += float(loss.detach())
    norm = float(torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0))
    optimizer.step()
    optimizer.zero_grad(set_to_none=True)
    return loss_total, norm


def train_text(run: Path, *, preset: str = "B", total_tokens: int = 200_000_000, sequence: int = 512,
               microbatch: int = 8, accumulation: int = 8, peak_lr: float = 8e-4, warmup_steps: int = 300,
               weight_decay: float = 0.1, context: int = 1024, seed: int = 0, eval_every: int = 250,
               checkpoint_minutes: float = 15.0, max_minutes: float | None = None, device: str = "cuda") -> dict[str, Any]:
    import numpy as np
    import torch
    from execution_model.model import ExecutionModel

    out = run / "pretrain"
    out.mkdir(parents=True, exist_ok=True)
    encoder = TextEncoder(run)
    tokenizer = encoder.tokenizer
    config = model_config(run, preset, context, seed)
    train_tokens = np.memmap(run / "data" / "train.bin", dtype=np.uint16, mode="r")
    validation = np.memmap(run / "data" / "validation.bin", dtype=np.uint16, mode="r")
    ads_validation = np.memmap(run / "data" / "ads_validation.bin", dtype=np.uint16, mode="r")
    tokens_per_step = sequence * microbatch * accumulation
    total_steps = max(1, total_tokens // tokens_per_step)
    settings = {"preset": preset, "parameters": config.parameter_count(), "config_identity": config.identity,
                "tokenizer_identity": tokenizer.identity, "total_tokens": total_tokens, "sequence": sequence,
                "microbatch": microbatch, "accumulation": accumulation, "tokens_per_step": tokens_per_step,
                "total_steps": total_steps, "peak_lr": peak_lr, "warmup_steps": warmup_steps,
                "weight_decay": weight_decay, "seed": seed, "train_file_tokens": int(len(train_tokens)),
                "epochs": round(total_tokens / len(train_tokens), 2), "precision": "bf16-autocast"}

    torch.manual_seed(seed)
    model = ExecutionModel(config).to(device)
    optimizer = _optimizer(model, peak_lr, weight_decay, device)
    generator = torch.Generator().manual_seed(seed + 1)
    step, processed, best = 0, 0, None
    last_path = out / "last.pt"
    if last_path.exists():
        state = torch.load(last_path, map_location="cpu", weights_only=False)
        if state["settings"]["config_identity"] != config.identity or state["settings"]["tokenizer_identity"] != tokenizer.identity:
            raise RuntimeError("Existing checkpoint belongs to a different model or tokenizer.")
        model.load_state_dict(state["model_state"])
        optimizer.load_state_dict(state["optimizer_state"])
        generator.set_state(state["generator_state"])
        step, processed, best = state["step"], state["processed_tokens"], state.get("best_validation")
        settings["resumed_from_step"] = step
    _atomic_json(out / "settings.json", settings)

    def save(path: Path) -> None:
        temporary = path.with_name(path.name + ".tmp")
        torch.save({"model_state": model.state_dict(), "optimizer_state": optimizer.state_dict(),
                    "generator_state": generator.get_state(), "step": step, "processed_tokens": processed,
                    "best_validation": best, "settings": settings, "config": config.to_dict()}, temporary)
        os.replace(temporary, path)

    log = open(out / "log.jsonl", "a", encoding="utf-8")
    stop_file = run / "STOP"
    started = window_start = time.perf_counter()
    last_save = started
    window_tokens = 0
    status = "running"
    model.train()
    try:
        while step < total_steps:
            learning_rate = _learning_rate(step, total_steps, peak_lr, warmup_steps)
            for group in optimizer.param_groups:
                group["lr"] = learning_rate
            batches = (_batches(train_tokens, batch=microbatch, length=sequence, generator=generator, device=device)
                       for _ in range(accumulation))
            loss_total, norm = _optimizer_update(model, optimizer, batches, accumulation, device)
            step += 1
            processed += tokens_per_step
            window_tokens += tokens_per_step
            if step % 25 == 0:
                now = time.perf_counter()
                record = {"step": step, "tokens": processed, "loss": round(loss_total, 4), "lr": round(learning_rate, 7),
                          "grad_norm": round(norm, 3), "tokens_per_second": round(window_tokens / (now - window_start)),
                          "elapsed_minutes": round((now - started) / 60, 1)}
                window_start, window_tokens = now, 0
                if step % eval_every == 0 or step == total_steps:
                    record["validation_loss"] = round(_evaluate(model, validation, batches=40, batch=microbatch, length=sequence, device=device), 4)
                    record["ads_validation_loss"] = round(_evaluate(model, ads_validation, batches=20, batch=microbatch, length=min(sequence, 256), device=device), 4)
                    record["samples"] = {prompt: _sample(model, encoder, prompt, tokens=40, device=device) for prompt in SAMPLE_PROMPTS[:2]}
                    if best is None or record["validation_loss"] < best:
                        best = record["validation_loss"]
                        save(out / "best.pt")
                    window_start = time.perf_counter()
                log.write(json.dumps(record, ensure_ascii=False) + "\n")
                log.flush()
            if time.perf_counter() - last_save > checkpoint_minutes * 60:
                save(last_path)
                last_save = time.perf_counter()
            if stop_file.exists():
                status = "paused_by_stop_file"
                break
            if max_minutes is not None and time.perf_counter() - started > max_minutes * 60:
                status = "paused_time_limit"
                break
        else:
            status = "completed"
    finally:
        save(last_path)
        log.close()
    result = {"status": status, "step": step, "processed_tokens": processed, "best_validation_loss": best,
              "minutes": round((time.perf_counter() - started) / 60, 1)}
    _atomic_json(out / "status.json", result | {"settings": settings})
    return result


# --------------------------------------------------------------------------- throughput benchmarking

BENCHMARK_SHAPES = {
    "38m": {},
    "60m": {"num_layers": 15},
    "85m": {"hidden_size": 640, "intermediate_size": 1728, "num_layers": 14, "num_heads": 10},
}


def benchmark_text(run: Path, corpus: Path, output: Path, shape: str, *, microbatch: int = 2,
                   accumulation: int = 8) -> dict[str, Any]:
    """Measure ten minutes of guarded next-token training without saving model weights."""
    import numpy as np
    import torch
    from execution_model.model import ExecutionModel

    from .chat_diagnostics import GpuJob
    from .language_adaptation import corpus_manifest

    if shape not in BENCHMARK_SHAPES or not 1 <= microbatch <= 64 or accumulation < 2 or accumulation % 2:
        raise ValueError("Choose a benchmark shape, a positive microbatch and even accumulation for bilingual sampling.")
    sequence, seed, duration, device = 512, 719, 600, "cuda"
    config = replace(model_config(run, "B", sequence, seed), **BENCHMARK_SHAPES[shape])
    tokenizer = ByteBPETokenizer.load(run / "tokenizer.json")
    manifest = corpus_manifest(corpus, tokenizer.identity, sequence)
    tokenizer_hash = _sha256(run / "tokenizer.json")
    if tokenizer_hash != manifest["tokenizer_sha256"]:
        raise ValueError("Benchmark tokenizer bytes differ from the corpus manifest.")
    languages = ("ar", "en")
    inputs = {language: manifest["files"][f"{language}.train.bin"] for language in languages}
    arrays = {language: np.memmap(corpus / f"{language}.train.bin", dtype="<u2", mode="r") for language in languages}
    code_paths = [Path(getfile(obj)) for obj in (benchmark_text, GpuJob, ExecutionModel, ModelConfig,
                                               ByteBPETokenizer, corpus_manifest)]
    code_paths.append(REPOSITORY_ROOT / "packages/execution-pipeline/scripts/pretrain_text.py")
    settings = {"shape": shape, "parameters": config.parameter_count(), "model_config": config.to_dict(),
                "config_identity": config.identity, "duration_seconds": duration, "sequence": sequence,
                "microbatch": microbatch, "accumulation": accumulation, "seed": seed, "peak_lr": 2e-4,
                "weight_decay": 0.1, "precision": "bf16-autocast", "torch_version": str(torch.__version__),
                "tokenizer_sha256": tokenizer_hash, "corpus_manifest_sha256": _sha256(corpus / "manifest.json"),
                "inputs": inputs, "input_language_schedule": "alternate Arabic and English microbatches",
                "code_sha256": {path.relative_to(REPOSITORY_ROOT).as_posix(): _sha256(path) for path in code_paths}}
    output.mkdir(parents=True, exist_ok=False)
    _atomic_json(output / "settings.json", settings)
    torch.set_num_threads(4)
    steps, active_seconds, wall_seconds, failure = 0, 0.0, 0.0, None
    interval = sequence * microbatch * accumulation
    try:
        with GpuJob(REPOSITORY_ROOT, output, stage="0.3", max_seconds=duration + 120) as guard:
            torch.empty(1, device=device)
            guard.start_monitor()
            torch.manual_seed(seed)
            model = ExecutionModel(config).to(device).train()
            optimizer = _optimizer(model, settings["peak_lr"], settings["weight_decay"], device)
            generator = torch.Generator().manual_seed(seed + 1)
            torch.cuda.synchronize()
            guard.start_training(shape)
            started = time.perf_counter()
            with (output / "throughput.jsonl").open("x", encoding="utf-8") as log:
                while wall_seconds < duration:
                    guard.check()
                    update_start = time.perf_counter()
                    batches = (_batches(arrays[languages[index % 2]], batch=microbatch, length=sequence,
                                        generator=generator, device=device) for index in range(accumulation))
                    loss, grad_norm = _optimizer_update(model, optimizer, batches, accumulation, device)
                    torch.cuda.synchronize()
                    finished = time.perf_counter()
                    elapsed = finished - update_start
                    steps += 1
                    active_seconds += elapsed
                    wall_seconds = finished - started
                    guard.record_training_update(interval, elapsed)
                    if steps % 25 == 0 or wall_seconds >= duration:
                        log.write(json.dumps({"step": steps, "tokens": steps * interval, "wall_seconds": wall_seconds,
                                              "tokens_per_second": steps * interval / active_seconds,
                                              "train_loss": loss, "grad_norm": grad_norm}, allow_nan=False) + "\n")
                        log.flush()
            guard.check()
    except (Exception, KeyboardInterrupt) as error:
        failure = f"{type(error).__name__}: {error}"
        raise
    finally:
        tokens = steps * interval
        files = {path.name: _sha256(path) for path in output.iterdir() if path.is_file()}
        gpu_summary = output / "gpu-summary.json"
        record = {"status": "stopped" if failure else "completed", "failure": failure, "settings": settings,
                  "optimizer_steps": steps, "tokens": tokens, "tokens_by_language": {lang: tokens // 2 for lang in languages},
                  "active_seconds": active_seconds, "wall_seconds": wall_seconds, "files": files,
                  "tokens_per_second": tokens / active_seconds if active_seconds else None,
                  "wall_tokens_per_second": tokens / wall_seconds if wall_seconds else None,
                  "gpu": json.loads(gpu_summary.read_text(encoding="utf-8")) if gpu_summary.exists() else None}
        _atomic_json(output / "manifest.json", record)
    return record


# --------------------------------------------------------------------------- export

def export_text_checkpoint(run: Path, *, source: str = "best.pt", name: str = "inference") -> dict[str, Any]:
    """Write weights in the Phase 2 inference layout; status stays "unverified"."""
    import torch
    from execution_model.checkpoint import CHECKPOINT_FORMAT, CHECKPOINT_VERSION
    from execution_model.metadata import ARCHITECTURE_ID
    from execution_model.model import ExecutionModel

    payload = torch.load(run / "pretrain" / source, map_location="cpu", weights_only=False)
    config = ModelConfig.from_dict(payload["config"])
    tokenizer = ByteBPETokenizer.load(run / "tokenizer.json")
    if payload["settings"]["tokenizer_identity"] != tokenizer.identity or config.vocab_size != tokenizer.vocab_size:
        raise RuntimeError("Checkpoint and tokenizer do not match.")
    reference = ExecutionModel(config)
    reference.load_state_dict(payload["model_state"], strict=True)
    clean = {key: value.detach().float().contiguous().clone() for key, value in reference.state_dict().items()}
    directory = run / name
    directory.mkdir(parents=True, exist_ok=False)
    torch.save(clean, directory / "weights.pt")
    canonical = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n"  # noqa: E731
    (directory / "config.json").write_text(canonical(config.to_dict()), encoding="ascii")
    (directory / "tokenizer.json").write_text(canonical(tokenizer.to_dict()), encoding="ascii")
    manifest = {"format": CHECKPOINT_FORMAT, "version": CHECKPOINT_VERSION, "architecture": ARCHITECTURE_ID,
                "config_identity": config.identity, "tokenizer_identity": tokenizer.identity,
                "weights_sha256": _sha256(directory / "weights.pt"), "training_status": "unverified",
                "initialization_seed": config.seed}
    (directory / "manifest.json").write_text(canonical(manifest), encoding="ascii")
    return {"directory": str(directory), "manifest": manifest, "step": payload["step"],
            "processed_tokens": payload["processed_tokens"]}
