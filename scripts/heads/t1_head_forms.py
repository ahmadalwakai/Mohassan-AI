"""T1: which head form specialises the frozen 38.3M trunk best for its cost.

Plan: docs/RESPONSE-QUALITY-PLAN-2026-11-22.md, section 3 ("تجارب التدريب T") and section 4.
Reference, measured 2026-11-20: the full fine-tune pointer-v4-f38m (score.json and log.jsonl
in that folder): goal_test 100%, unseen phrasing 28.4%, gold 65.4%, early stop after 49.2 min.

Arms, declared before any score exists (settings.json records them):
  head   trunk frozen; a zero-initialised residual bottleneck after final_norm is trained
  lora   trunk frozen; rank-8 LoRA (alpha 16) on every block's linear layers
  last2  only the last two blocks and final_norm train; the tied embeddings stay frozen
  full   memory probe only, at the reference's batch, to compare peaks

Same data, data order, effective batch (8), warmup, evaluation interval and patience as the
reference. Each arm gets a wall-clock training budget instead of three epochs. Micro-batch:
the largest of 1, 2, 4, 8 whose probe stays under the VRAM limit without a shared-memory
rise, with gradient accumulation up to 8. Only the trainable tensors are saved.
Answers use the reference's greedy decoding on the same frozen test files, and are scored
by scripts/ads-training/score-mix.ts. One GPU job at a time: .data/gpu.lock.

Run with .venv-execution:
  python -I scripts/heads/t1_head_forms.py --out artifacts/heads-t1-20261122
  python -I scripts/heads/t1_head_forms.py --smoke --out artifacts/heads-t1-smoke-20261122
"""
from __future__ import annotations

import argparse
import gc
import hashlib
import json
import math
import os
import random
import statistics
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages" / "execution-pipeline"))

import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402
from torch import nn  # noqa: E402

from execution_pipeline import ads_finetune as af  # noqa: E402  (also puts execution_model on sys.path)
from execution_model.adapters import attach_adapter  # noqa: E402

RUN = ROOT / "artifacts" / "execution-model-runs" / "text-b4-2026-11-18" / "stage-3-full"
BASE = Path("selected/best.pt")
TRAIN_DIR = ROOT / "artifacts" / "ads-training" / "pointer-v4"
TEST_DIR = ROOT / "artifacts" / "ads-training" / "pointer-v3"
TEST_SPLITS = ("goal_test", "goal_test_unseen_phrasing", "goal_gold")
REFERENCE_DIR = RUN / "pointer-v4-f38m"
LOCK = ROOT / ".data" / "gpu.lock"

ARMS = {
    "head": {"peak_lr": 1e-3, "bottleneck": 256},
    "lora": {"peak_lr": 3e-4, "rank": 8, "alpha": 16.0},
    "last2": {"peak_lr": 1e-4, "blocks": 2},
}
EFFECTIVE_BATCH = 8
WARMUP = 100
EVAL_EVERY = 400
PATIENCE = 5
EPOCHS = 3
SEED = 5
MAX_NEW_TOKENS = 96
GENERATION_BATCH = 32
MICROBATCHES = (1, 2, 4, 8)
VRAM_LIMIT_MIB = 3300          # plan section 4: 3.2 to 3.5 GB dedicated
# The smoke run of 2026-11-22 03:08 spilled 2.6 GB into shared memory at micro-batch 8 although the probe
# had shown 2.2 GB: validation shapes and varying lengths fragment the cache. A hard allocator cap turns
# such a spill into an out-of-memory error, which the loop answers by halving the micro-batch.
ALLOCATOR_CAP_MIB = VRAM_LIMIT_MIB - 250   # the CUDA context itself took about 150 MiB in that run
# The second smoke run (03:16-03:19) stayed under the cap but LoRA and last2 at micro-batch 8 ran with
# 2,994-3,050 MiB reserved, right at the cap, and their speed fell to a third. A micro-batch is chosen
# only if its probe peak leaves a quarter of the cap free.
HEADROOM = 0.75
NEAR_FULL_MIB = 3900           # dedicated this close to 4096 MiB counts as a spill
STOP_DEDICATED_MIB = 3700      # stop rule of 2026-11-16, together with a shared rise
STOP_SHARED_RISE_MIB = 256
SPEED_DROP = 0.30
HOT_C, COOL_C = 87, 80
SAMPLE_SECONDS = 30
CRITERIA = {
    "primary_metric": "goal_test_unseen_phrasing exact (n=1000); goal_test exact and gold (n=26) reported beside it",
    "success_proposed": "an arm within 2 points of the reference on the primary metric, at half or less of the "
                        "reference's minutes to its best checkpoint or of the full fine-tune's probed peak memory",
    "failure_proposed": "every arm more than 5 points below the reference on the primary metric",
    "between": "2 to 5 points below: the owner decides on cost",
    "status": "proposals from the plan; the owner fixes or changes them",
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def nvidia() -> dict:
    line = subprocess.run(["nvidia-smi", "--query-gpu=memory.used,temperature.gpu,utilization.gpu,power.draw",
                           "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=20).stdout.strip().splitlines()[0]
    used, temperature, utilization, power = (part.strip() for part in line.split(","))
    return {"dedicated_mib": int(used), "temperature_c": int(temperature), "utilization_pct": int(utilization),
            "power_w": float(power) if power.replace(".", "", 1).isdigit() else None}


def adapters_memory() -> dict[str, dict[str, float]]:
    """Windows counters per GPU adapter. Shared usage shows a spill out of the 4 GB card."""
    command = ("(Get-Counter '\\GPU Adapter Memory(*)\\Shared Usage','\\GPU Adapter Memory(*)\\Dedicated Usage')"
               ".CounterSamples | ForEach-Object { $_.Path + '|' + $_.CookedValue }")
    result = subprocess.run(["powershell", "-NoProfile", "-Command", command], capture_output=True, text=True, timeout=60)
    adapters: dict[str, dict[str, float]] = {}
    for line in result.stdout.splitlines():
        if "|" not in line:
            continue
        path, value = line.rsplit("|", 1)
        name = path.split("(", 1)[1].split(")", 1)[0] if "(" in path else path
        kind = "shared_mib" if path.lower().endswith("shared usage") else "dedicated_mib"
        adapters.setdefault(name, {})[kind] = round(float(value) / 2**20, 1)
    return adapters


def shared_rise(before: dict, after: dict) -> float:
    """Rise of shared memory on adapters that hold dedicated memory now (the NVIDIA card while CUDA runs)."""
    rises = [values.get("shared_mib", 0.0) - before.get(name, {}).get("shared_mib", values.get("shared_mib", 0.0))
             for name, values in after.items() if values.get("dedicated_mib", 0.0) > 100]
    return round(max(rises, default=0.0), 1)


class Sampler(threading.Thread):
    """Logs GPU memory and temperature every 30 s and raises the loop's guard flags."""

    def __init__(self, path: Path) -> None:
        super().__init__(daemon=True)
        self.path = path
        self.stop_event = threading.Event()
        self.hot = threading.Event()
        self.spill = threading.Event()
        self.baseline: dict | None = None

    def reset(self) -> None:
        """New baseline and a cleared spill flag, so one arm's spill does not stop the next arm."""
        self.baseline = adapters_memory()
        self.spill.clear()

    def run(self) -> None:
        while True:
            row: dict = {"at": now()}
            try:
                row.update(nvidia())
            except Exception as error:  # noqa: BLE001  (a failed sample must not stop training)
                row["nvidia_error"] = str(error)[:200]
            try:
                adapters = adapters_memory()
                self.baseline = self.baseline or adapters
                row["adapters"] = adapters
                row["shared_rise_mib"] = shared_rise(self.baseline, adapters)
            except Exception as error:  # noqa: BLE001
                row["counter_error"] = str(error)[:200]
            temperature = row.get("temperature_c")
            if temperature is not None and temperature >= HOT_C:
                self.hot.set()
            elif temperature is not None and temperature <= COOL_C:
                self.hot.clear()
            if row.get("dedicated_mib", 0) >= STOP_DEDICATED_MIB and row.get("shared_rise_mib", 0.0) > STOP_SHARED_RISE_MIB:
                self.spill.set()
            with self.path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(row) + "\n")
            if self.stop_event.wait(SAMPLE_SECONDS):
                return


def gpu_users() -> list[str]:
    lines = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader"],
                           capture_output=True, text=True, timeout=20).stdout.splitlines()
    return [line.strip() for line in lines if line.strip()]


def acquire_lock(purpose: str) -> None:
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        raise SystemExit(f"The GPU is locked by another job: {LOCK.read_text(encoding='utf-8', errors='replace')[:400]}")
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump({"owner": "Claude Code, RESPONSE-QUALITY-PLAN T1", "purpose": purpose, "pid": os.getpid(), "started": now()}, stream)


def release_lock() -> None:
    try:
        if json.loads(LOCK.read_text(encoding="utf-8")).get("pid") == os.getpid():
            LOCK.unlink()
    except (FileNotFoundError, json.JSONDecodeError):
        pass


class ResidualHead(nn.Module):
    """hidden + up(gelu(down(hidden))); `up` starts at zero, so the untrained head changes nothing."""

    def __init__(self, hidden: int, bottleneck: int) -> None:
        super().__init__()
        self.down = nn.Linear(hidden, bottleneck)
        self.up = nn.Linear(bottleneck, hidden)
        nn.init.zeros_(self.up.weight)
        nn.init.zeros_(self.up.bias)

    def forward(self, hidden: torch.Tensor) -> torch.Tensor:
        return hidden + self.up(F.gelu(self.down(hidden)))


def build(arm: str):
    """Fresh base model on CUDA with only the arm's tensors trainable."""
    model, tokenizer, config = af._load_pretrained(RUN, "cuda", BASE)
    for parameter in model.parameters():
        parameter.requires_grad_(False)
    holder: dict = {}
    if arm == "head":
        torch.manual_seed(SEED)
        head = ResidualHead(config.hidden_size, ARMS["head"]["bottleneck"]).to("cuda")
        holder["head"] = head
        model.final_norm.register_forward_hook(lambda module, args, output: head(output))
        trainable = list(head.parameters())
        state = lambda: {key: value.detach().cpu().clone() for key, value in head.state_dict().items()}  # noqa: E731
        load = lambda values: head.load_state_dict(values)  # noqa: E731
    elif arm == "lora":
        handle = attach_adapter(model, "t1-ads", rank=ARMS["lora"]["rank"], alpha=ARMS["lora"]["alpha"], seed=SEED)
        container = handle.state_module()
        holder["adapter"] = handle
        trainable = handle.parameters()
        state = lambda: {key: value.detach().cpu().clone() for key, value in container.state_dict().items()}  # noqa: E731
        load = lambda values: container.load_state_dict(values)  # noqa: E731
    elif arm == "last2":
        first = config.num_layers - ARMS["last2"]["blocks"]
        prefixes = tuple(f"blocks.{index}." for index in range(first, config.num_layers)) + ("final_norm.",)
        for name, parameter in model.named_parameters():
            if name.startswith(prefixes):
                parameter.requires_grad_(True)
        keys = {name for name, parameter in model.named_parameters() if parameter.requires_grad}
        trainable = [parameter for parameter in model.parameters() if parameter.requires_grad]
        state = lambda: {key: value.detach().cpu().clone() for key, value in model.state_dict().items() if key in keys}  # noqa: E731
        load = lambda values: model.load_state_dict(values, strict=False)  # noqa: E731
    elif arm == "full":
        for parameter in model.parameters():
            parameter.requires_grad_(True)
        trainable = list(model.parameters())
        state = load = None
    else:
        raise ValueError(f"Unknown arm {arm}")
    return model, tokenizer, config, holder, trainable, state, load


def make_optimizer(trainable: list, peak_lr: float):
    decay = [parameter for parameter in trainable if parameter.ndim >= 2]
    plain = [parameter for parameter in trainable if parameter.ndim < 2]
    groups = [{"params": decay, "weight_decay": 0.1}] + ([{"params": plain, "weight_decay": 0.0}] if plain else [])
    return torch.optim.AdamW(groups, lr=peak_lr, betas=(0.9, 0.95), fused=True)


def release(*objects) -> None:
    del objects
    gc.collect()
    torch.cuda.empty_cache()


def probe(arm: str, microbatch: int, longest: list, mixed: list, pad: int) -> dict:
    """Updates on the longest rows, then on mixed lengths, then a validation pass: the shapes training meets."""
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    before = adapters_memory()
    model, _, _, holder, trainable, _, _ = build(arm)
    optimizer = make_optimizer(trainable, 1e-12)
    model.train()
    timings: list[float] = []
    result: dict = {"arm": arm, "microbatch": microbatch, "tokens_per_microstep": sum(len(row[0]) for row in longest[:microbatch]),
                    "trainable_parameters": sum(parameter.numel() for parameter in trainable), "oom": False}
    try:
        batches = [longest[:microbatch]] * 3 + [mixed[begin:begin + microbatch] for begin in range(0, 4 * microbatch, microbatch)]
        for rows in batches:
            torch.cuda.synchronize()
            started = time.perf_counter()
            ids, mask, labels = af._batch(rows, pad, "cuda")
            with torch.autocast("cuda", dtype=torch.bfloat16):
                loss = model(ids, attention_mask=mask, labels=labels).loss
            loss.backward()
            optimizer.step()
            optimizer.zero_grad(set_to_none=True)
            torch.cuda.synchronize()
            timings.append(time.perf_counter() - started)
            del loss, ids, mask, labels
        af._validation_loss(model, longest[:microbatch] + mixed[:microbatch], pad, "cuda", microbatch)
    except torch.cuda.OutOfMemoryError:
        result["oom"] = True
    smi = nvidia()
    after = adapters_memory()
    result.update({"max_allocated_mib": round(torch.cuda.max_memory_allocated() / 2**20),
                   "max_reserved_mib": round(torch.cuda.max_memory_reserved() / 2**20),
                   "nvidia_dedicated_mib": smi["dedicated_mib"], "temperature_c": smi["temperature_c"],
                   "shared_rise_mib": shared_rise(before, after),
                   "seconds_per_longest_microstep": round(statistics.median(timings[1:3]), 4) if len(timings) >= 3 else None})
    result["spill"] = result["shared_rise_mib"] >= STOP_SHARED_RISE_MIB or result["nvidia_dedicated_mib"] >= NEAR_FULL_MIB
    result["fits"] = (not result["oom"] and not result["spill"] and result["nvidia_dedicated_mib"] <= VRAM_LIMIT_MIB
                      and result["max_reserved_mib"] <= HEADROOM * ALLOCATOR_CAP_MIB)
    del optimizer, trainable, holder, model
    release()
    return result


def epoch_batches(rng: random.Random, rows: list) -> list[list[int]]:
    """The reference's order: shuffle, sort inside windows of 400 by length, cut into 8s, shuffle the 8s."""
    order = list(range(len(rows)))
    rng.shuffle(order)
    window = EFFECTIVE_BATCH * 50
    order = [index for begin in range(0, len(order), window)
             for index in sorted(order[begin:begin + window], key=lambda index: len(rows[index][0]))]
    chunks = [order[begin:begin + EFFECTIVE_BATCH] for begin in range(0, len(order), EFFECTIVE_BATCH)]
    rng.shuffle(chunks)
    return chunks


def answer_tokens(rows: list, indices: list[int]) -> int:
    return sum(sum(label != af.IGNORE for label in rows[index][1][1:]) for index in indices)


def train_arm(arm: str, microbatch: int, train_rows: list, validation_rows: list, out: Path,
              sampler: Sampler, budget_seconds: float, eval_every: int) -> tuple[dict, object, object, object]:
    torch.cuda.reset_peak_memory_stats()
    start_microbatch = microbatch
    model, tokenizer, config, holder, trainable, state_of, load = build(arm)
    pad = tokenizer.pad_token_id
    peak_lr = ARMS[arm]["peak_lr"]
    optimizer = make_optimizer(trainable, peak_lr)
    torch.manual_seed(SEED)
    rng = random.Random(SEED)
    planned_steps = math.ceil(len(train_rows) / EFFECTIVE_BATCH) * EPOCHS
    total_steps = planned_steps
    clock = time.perf_counter()
    paused = 0.0

    def active() -> float:
        return time.perf_counter() - clock - paused

    measured = time.perf_counter()
    best = af._validation_loss(model, validation_rows, pad, "cuda", microbatch)
    validation_seconds = time.perf_counter() - measured
    events: list[dict] = []
    rates: list[float] = []
    best_step, best_state, best_minutes, stale = 0, state_of(), 0.0, 0
    log = (out / "log.jsonl").open("w", encoding="utf-8")
    log.write(json.dumps({"step": 0, "validation_loss": round(best, 4), "validation_seconds": round(validation_seconds, 2)}) + "\n")
    step, last_eval_step, status = 0, 0, None
    interval = {"tokens": 0, "seconds": 0.0, "loss": 0.0, "updates": 0}
    first_rate, calibration = None, None
    model.train()

    def evaluate() -> None:
        nonlocal best, best_step, best_state, best_minutes, stale, first_rate, status, last_eval_step, rates
        validation = af._validation_loss(model, validation_rows, pad, "cuda", microbatch)
        torch.cuda.empty_cache()
        rate = interval["tokens"] / interval["seconds"] if interval["seconds"] else None
        first_rate = first_rate or rate
        record = {"step": step, "microbatch": microbatch, "validation_loss": round(validation, 4),
                  "interval_train_loss": round(interval["loss"] / max(1, interval["updates"]), 4),
                  "tokens_per_second": round(rate, 1) if rate else None,
                  "active_minutes": round(active() / 60, 2), "paused_seconds": round(paused, 1)}
        if validation < best:
            best, best_step, best_state, best_minutes, stale = validation, step, state_of(), active() / 60, 0
            record["best"] = True
        else:
            stale += 1
        log.write(json.dumps(record) + "\n")
        log.flush()
        interval.update(tokens=0, seconds=0.0, loss=0.0, updates=0)
        if any(event["step"] > last_eval_step for event in events):
            rates = []  # a halved micro-batch is slower by design; measure the new speed afresh
        last_eval_step = step
        if rate:
            if rates and rate < (1 - SPEED_DROP) * statistics.median(rates):
                status = "stopped_speed_drop"
            rates.append(rate)
        if status is None and stale >= PATIENCE:
            status = "early_stopped"

    def batches():
        for _ in range(EPOCHS):
            yield from epoch_batches(rng, train_rows)

    try:
        for indices in batches():
            if step >= total_steps:
                status = "completed"
                break
            if sampler.spill.is_set():
                status = "stopped_memory_spill"
                break
            while sampler.hot.is_set():
                waited = time.perf_counter()
                time.sleep(10)
                paused += time.perf_counter() - waited
            if active() >= budget_seconds:
                status = "budget_reached"
                break
            started = time.perf_counter()
            ratio = ((step + 1) / WARMUP if step < WARMUP else
                     0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * (step - WARMUP) / max(1, total_steps - WARMUP))))
            for group in optimizer.param_groups:
                group["lr"] = peak_lr * ratio
            total_answer = answer_tokens(train_rows, indices)
            while True:
                update_loss, tokens = 0.0, 0
                try:
                    for begin in range(0, len(indices), microbatch):
                        micro = indices[begin:begin + microbatch]
                        ids, mask, labels = af._batch([train_rows[index] for index in micro], pad, "cuda")
                        tokens += int(mask.sum())
                        with torch.autocast("cuda", dtype=torch.bfloat16):
                            loss = model(ids, attention_mask=mask, labels=labels).loss
                        weight = answer_tokens(train_rows, micro) / total_answer
                        (loss * weight).backward()
                        update_loss += float(loss.detach()) * weight
                        del loss, ids, mask, labels
                    break
                except torch.cuda.OutOfMemoryError:
                    loss = ids = mask = labels = None  # noqa: F841  (drop the failed step's tensors first)
                    optimizer.zero_grad(set_to_none=True)
                    release()
                    if microbatch == 1:
                        raise
                    microbatch //= 2
                    events.append({"step": step, "event": "out_of_memory_halved_microbatch", "microbatch": microbatch, "at": now()})
            interval["tokens"] += tokens
            torch.nn.utils.clip_grad_norm_(trainable, 1.0, error_if_nonfinite=True)
            optimizer.step()
            optimizer.zero_grad(set_to_none=True)
            step += 1
            interval["seconds"] += time.perf_counter() - started
            interval["loss"] += update_loss
            interval["updates"] += 1
            if calibration is None and step == 50:
                per_update = interval["seconds"] / interval["updates"]
                fit = int((budget_seconds - active()) / (per_update + validation_seconds / eval_every))
                total_steps = min(planned_steps, step + max(1, fit))
                calibration = {"seconds_per_update": round(per_update, 4), "validation_seconds": round(validation_seconds, 2),
                               "planned_steps": planned_steps, "total_steps": total_steps,
                               "rule": "cosine schedule shortened so it ends inside the budget"}
            if step % eval_every == 0 or step == total_steps:
                evaluate()
                if status:
                    break
        else:
            status = status or "completed"
        if last_eval_step != step:
            ended = status  # keep the reason the loop ended; this evaluation only offers a last best checkpoint
            evaluate()
            status = ended
    finally:
        log.close()
    load(best_state)
    torch.save(best_state, out / "trainable-best.pt")
    result = {"arm": arm, "status": status, "steps": step, "total_steps": total_steps, "calibration": calibration,
              "best_step": best_step, "best_validation_loss": round(best, 4), "minutes_to_best": round(best_minutes, 2),
              "active_minutes": round(active() / 60, 2), "paused_seconds": round(paused, 1),
              "start_microbatch": start_microbatch, "microbatch": microbatch, "accumulation": EFFECTIVE_BATCH // microbatch,
              "events": events, "peak_lr": peak_lr,
              "trainable_parameters": sum(parameter.numel() for parameter in trainable),
              "max_allocated_mib": round(torch.cuda.max_memory_allocated() / 2**20),
              "max_reserved_mib": round(torch.cuda.max_memory_reserved() / 2**20),
              "trainable_sha256": sha256(out / "trainable-best.pt")}
    del optimizer
    return result, model, tokenizer, config


def generate(model, tokenizer, config, encoder, out: Path, limit: int | None) -> dict:
    """The reference's greedy decoding (ads_finetune.generate_answers), on the in-memory arm."""
    model.eval()
    pad, eos = tokenizer.pad_token_id, tokenizer.eos_token_id
    folder = out / "answers"
    folder.mkdir()
    summary: dict = {"decoding": "greedy", "max_new_tokens": MAX_NEW_TOKENS}
    for split in TEST_SPLITS:
        records = af.load_split(split, TEST_DIR)[:limit]
        started = time.perf_counter()
        lines = []
        for begin in range(0, len(records), GENERATION_BATCH):
            chunk = records[begin:begin + GENERATION_BATCH]
            prompts = [encoder.encode(af.prompt_text(record, None)) for record in chunk]
            generated: list[list[int]] = [[] for _ in chunk]
            done, stopped = [False] * len(chunk), [False] * len(chunk)
            for _ in range(MAX_NEW_TOKENS):
                active = [index for index in range(len(chunk)) if not done[index] and not stopped[index]
                          and len(prompts[index]) + len(generated[index]) <= config.max_context_length]
                for index in range(len(chunk)):
                    if not done[index] and index not in active:
                        stopped[index] = True
                if not active:
                    break
                sequences = [prompts[index] + generated[index] for index in active]
                width = max(len(sequence) for sequence in sequences)
                ids = torch.full((len(active), width), pad, dtype=torch.long)
                mask = torch.zeros((len(active), width), dtype=torch.bool)
                for row, sequence in enumerate(sequences):
                    ids[row, width - len(sequence):] = torch.tensor(sequence)
                    mask[row, width - len(sequence):] = True
                with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
                    logits = model(ids.to("cuda"), attention_mask=mask.to("cuda"), last_token_only=True).logits[:, -1]
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
        (folder / f"{split}.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
        summary[split] = {"examples": len(records), "seconds": round(time.perf_counter() - started, 1),
                          "dataset_sha256": sha256(TEST_DIR / f"{split}.jsonl")}
    write_json(folder / "summary.json", summary)
    return summary


def score(answers: Path) -> dict:
    result = subprocess.run(["npx.cmd", "tsx", "scripts/ads-training/score-mix.ts", str(answers)],
                            cwd=ROOT, capture_output=True, text=True, timeout=900, encoding="utf-8")
    if result.returncode != 0:
        return {"error": result.stderr[-2000:]}
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {"error": "score-mix.ts printed no JSON", "stdout": result.stdout[-2000:]}


def percent(text: object) -> float | None:
    return float(str(text).rstrip("%")) if isinstance(text, str) and text.endswith("%") else None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--arms", default="head,lora,last2")
    parser.add_argument("--budget-minutes", type=float, default=30.0)
    parser.add_argument("--smoke", action="store_true", help="1-minute budget, evaluation every 20 steps, 8 test rows per split")
    args = parser.parse_args()
    arms = [arm for arm in args.arms.split(",") if arm]
    if any(arm not in ARMS for arm in arms):
        raise SystemExit(f"Arms must be among {sorted(ARMS)}")
    budget = 60.0 if args.smoke else args.budget_minutes * 60
    eval_every = 20 if args.smoke else EVAL_EVERY
    limit = 8 if args.smoke else None
    out_root = (ROOT / args.out).resolve() if not args.out.is_absolute() else args.out.resolve()
    if not out_root.is_relative_to((ROOT / "artifacts").resolve()):
        raise SystemExit("--out must be inside artifacts/")
    users = gpu_users()
    if users:
        raise SystemExit(f"The GPU has compute processes: {users}")
    out_root.mkdir(parents=True, exist_ok=False)
    acquire_lock("T1 head forms" + (" (smoke)" if args.smoke else ""))
    sampler = Sampler(out_root / "resources.jsonl")
    sampler.start()
    try:
        total_mib = torch.cuda.get_device_properties(0).total_memory / 2**20
        torch.cuda.set_per_process_memory_fraction(ALLOCATOR_CAP_MIB / total_mib, 0)
        payload, encoder, config = af._load_payload(RUN, af._base_path(RUN, BASE))
        del payload
        tokenizer = encoder.tokenizer
        limit_tokens = config.max_context_length
        train_records = af.load_split("train", TRAIN_DIR)
        validation_records = af.load_split("validation", TRAIN_DIR)
        train_rows = [row for row in (af.encode_pair(encoder, record, None) for record in train_records) if len(row[0]) <= limit_tokens]
        validation_rows = [row for row in (af.encode_pair(encoder, record, None) for record in validation_records) if len(row[0]) <= limit_tokens]
        reference_settings = json.loads((REFERENCE_DIR / "settings.json").read_text(encoding="utf-8"))
        reference_log = [json.loads(line) for line in (REFERENCE_DIR / "log.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
        reference_best = next((row for row in reference_log if row.get("step") == json.loads(
            (REFERENCE_DIR / "status.json").read_text(encoding="utf-8"))["best_step"]), {})
        settings = {
            "started": now(), "smoke": args.smoke, "arms": {arm: ARMS[arm] for arm in arms},
            "budget_seconds_per_arm": budget, "effective_batch": EFFECTIVE_BATCH, "warmup": WARMUP,
            "eval_every": eval_every, "patience": PATIENCE, "epochs_cap": EPOCHS, "seed": SEED,
            "microbatch_candidates": MICROBATCHES, "vram_limit_mib": VRAM_LIMIT_MIB,
            "allocator_cap_mib": ALLOCATOR_CAP_MIB, "device_total_mib": round(total_mib),
            "model": {"parameters": 38281728, "hidden_size": config.hidden_size, "num_layers": config.num_layers,
                      "vocab_size": config.vocab_size, "max_context_length": config.max_context_length},
            "guards": {"stop_dedicated_mib": STOP_DEDICATED_MIB, "stop_shared_rise_mib": STOP_SHARED_RISE_MIB,
                       "speed_drop": SPEED_DROP, "pause_at_c": HOT_C, "resume_at_c": COOL_C},
            "precision": "bf16 autocast (torch.cuda.is_bf16_supported() = %s)" % torch.cuda.is_bf16_supported(),
            "base": str(RUN / BASE), "base_sha256": sha256(RUN / BASE),
            "train_dir": str(TRAIN_DIR), "train_sha256": {name: sha256(TRAIN_DIR / f"{name}.jsonl") for name in ("train", "validation")},
            "train_rows_after_drop_long": len(train_rows), "validation_rows_after_drop_long": len(validation_rows),
            "reference_train_examples": reference_settings.get("train_examples"),
            "test_dir": str(TEST_DIR), "test_splits": TEST_SPLITS,
            "reference": {"folder": str(REFERENCE_DIR), "score_sha256": sha256(REFERENCE_DIR / "score.json"),
                          "batch": reference_settings.get("batch"), "peak_lr": reference_settings.get("peak_lr"),
                          "best_step": reference_best.get("step"), "minutes_to_best": reference_best.get("minutes"),
                          "minutes_total": json.loads((REFERENCE_DIR / "status.json").read_text(encoding="utf-8")).get("minutes")},
            "criteria": CRITERIA, "code_sha256": sha256(Path(__file__)), "torch": torch.__version__,
        }
        write_json(out_root / "settings.json", settings)
        pad = tokenizer.pad_token_id
        longest = sorted(train_rows, key=lambda row: len(row[0]), reverse=True)[:max(MICROBATCHES)]
        mixed = random.Random(SEED).sample(train_rows, 4 * max(MICROBATCHES))
        probes = []
        chosen: dict[str, int] = {}
        for arm in arms:
            sampler.reset()
            for microbatch in MICROBATCHES:
                result = probe(arm, microbatch, longest, mixed, pad)
                probes.append(result)
                write_json(out_root / "probe.json", probes)
                print(json.dumps(result), flush=True)
                if not result["fits"]:
                    break
                chosen[arm] = microbatch
        if not args.smoke:
            # The full fine-tune at the reference's batch 8, without the cap, for its real peak (3 updates only).
            sampler.reset()
            torch.cuda.set_per_process_memory_fraction(1.0, 0)
            result = probe("full", EFFECTIVE_BATCH, longest, mixed, pad)
            result["note"] = "uncapped, measurement only; the reference trained at this batch without a cap"
            probes.append(result)
            write_json(out_root / "probe.json", probes)
            print(json.dumps(result), flush=True)
            torch.cuda.set_per_process_memory_fraction(ALLOCATOR_CAP_MIB / total_mib, 0)
        summary = {"probes": probes, "arms": {}}
        for arm in arms:
            if arm not in chosen:
                summary["arms"][arm] = {"status": "no_microbatch_fits"}
                continue
            out = out_root / arm
            out.mkdir()
            release()
            sampler.reset()
            result, model, arm_tokenizer, arm_config = train_arm(arm, chosen[arm], train_rows, validation_rows, out,
                                                                 sampler, budget, eval_every)
            result["generation"] = generate(model, arm_tokenizer, arm_config, encoder, out, limit)
            del model
            release()
            scores = score(out / "answers")
            write_json(out / "score.json", scores)
            result["scores"] = {split: {"exact": percent(values.get("exact")), "refused": percent(values.get("refusedByCheck")),
                                        "wrong_but_accepted": percent(values.get("wrongButAccepted")), "rows": values.get("rows")}
                                for split, values in scores.items() if isinstance(values, dict) and "exact" in values}
            write_json(out / "status.json", result)
            summary["arms"][arm] = result
            write_json(out_root / "summary.json", summary)
            print(json.dumps({"arm": arm, "status": result["status"], "scores": result["scores"],
                              "minutes_to_best": result["minutes_to_best"]}), flush=True)
        summary["finished"] = now()
        write_json(out_root / "summary.json", summary)
        return 0
    finally:
        sampler.stop_event.set()
        sampler.join(timeout=90)
        release_lock()


if __name__ == "__main__":
    raise SystemExit(main())
