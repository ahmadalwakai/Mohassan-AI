"""T1, reading task: the same three head forms against the reading reference, a full fine-tune.

Plan: docs/RESPONSE-QUALITY-PLAN-2026-11-22.md, section 3 (T1 names two tasks; the Ads part is
t1_head_forms.py). The owner asked for this part on 2026-11-22 («شغّل جزء القراءة من T1 بعد الإعادة»).

Reference, measured 2026-11-20: reading-v3-f38m, a full fine-tune of stage-3-full/selected/best.pt on
artifacts/reading-training/v3 (64,794 train rows, 918 validation): one epoch, batch 4 x accumulation 2,
peak lr 3e-5, warmup 500, evaluation every 1000 steps, ar/en balanced batches, 35.6 minutes. Its final
step (reading-v3-last, chosen before scoring because the loss-best step abstained most) scored with
answers forced (eval_reading_v2.py --force, artifacts/reading-training/eval-v3-last-forced.json):
F1 61.5 on test_tydi_ar (n=903), 29.1 on test_arcd (n=696), 25.9 on test_squad (n=487).

Arms and their learning rates are those of t1_head_forms.py (head, lora, last2). Same data, batch order
(ads_finetune._balanced_epoch_batches, seed 5, length grouping, full batches), effective batch 8, warmup,
evaluation interval and macro-language validation loss as the reference; no early stop (the reference's
patience was 1000). Each arm gets a 30-minute active budget; the cosine schedule is shortened at step 50
to end inside it. As with the reference, the final state is scored; the best-loss state is saved beside it.
Scoring repeats eval_reading_v2.py --force on the in-memory arm: answerable rows of the three test splits,
greedy up to 48 tokens, no repeated trigram, stop at newline or EOS, EOS and the first token of the
not-stated phrases blocked at step one, and that script's own norm() and f1().
Guards as in t1_head_forms.py: allocator cap, quarter headroom, spill stop, pause while another job holds
GPU memory, thermal pause, speed-drop stop, and .data/gpu.lock.

Run with .venv-execution:
  python -I scripts/heads/t1_reading.py --out artifacts/heads-t1-reading-20261122
  python -I scripts/heads/t1_reading.py --smoke --out artifacts/heads-t1-reading-smoke-20261122
"""
from __future__ import annotations

import argparse
import json
import math
import random
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / "scripts" / "context-use"))

import torch  # noqa: E402

import t1_head_forms as t1  # noqa: E402  (also puts the execution pipeline on sys.path)
from execution_pipeline import ads_finetune as af  # noqa: E402
# eval_reading_v2 reads only --data, --splits, --gen, --limit, --force and --no-passage from argv, and its
# run_context_test import only --finetune and --shots; this script takes none of those names.
import eval_reading_v2 as ev  # noqa: E402

TRAIN_DIR = ROOT / "artifacts" / "reading-training" / "v3"
TEST_DIR = ROOT / "artifacts" / "reading-training" / "v2"   # the reference's evaluation data; same test files as v3
TEST_SPLITS = ("test_squad", "test_tydi_ar", "test_arcd")
REFERENCE_DIR = t1.RUN / "reading-v3-f38m"
REFERENCE_EVAL = ROOT / "artifacts" / "reading-training" / "eval-v3-last-forced.json"
REFERENCE_PREDICTIONS = ROOT / "artifacts" / "reading-training" / "eval-v3-last-forced.predictions.jsonl"
EFFECTIVE_BATCH = 8
WARMUP = 500
EVAL_EVERY = 1000
REFERENCE_MICROBATCH = 4
GEN_MAX = 48
BOOTSTRAP = 10000
CRITERIA = {
    "primary_metric": "F1 with forced answers on test_tydi_ar (n=903) and on test_arcd (n=696); test_squad and EM beside them",
    "success_proposed": "an arm within 2 F1 points of the reference on both, at half or less of the reference's 35.6 minutes "
                        "or of the full fine-tune's probed peak memory",
    "failure_proposed": "every arm more than 5 F1 points below the reference on either",
    "between": "the owner decides on cost",
    "status": "proposals from the plan; the owner fixes or changes them",
}


def train_arm(arm: str, microbatch: int, train_rows: list, train_groups: dict, validation_rows: list,
              validation_groups: dict, out: Path, sampler: t1.Sampler, budget_seconds: float, eval_every: int):
    """t1_head_forms.train_arm with the reading reference's batches, warmup, validation and final-state choice."""
    torch.cuda.reset_peak_memory_stats()
    start_microbatch = microbatch
    model, tokenizer, config, holder, trainable, state_of, load = t1.build(arm)
    pad = tokenizer.pad_token_id
    peak_lr = t1.ARMS[arm]["peak_lr"]
    optimizer = t1.make_optimizer(trainable, peak_lr)
    torch.manual_seed(t1.SEED)
    order_rng = random.Random(t1.SEED)
    batches = af._balanced_epoch_batches(train_groups, order_rng, EFFECTIVE_BATCH,
                                         [len(row[0]) for row in train_rows], full_batches=True)
    planned_steps = len(batches)
    total_steps = planned_steps
    clock = time.perf_counter()
    paused = 0.0

    def active() -> float:
        return time.perf_counter() - clock - paused

    def validate() -> dict:
        return af._balanced_validation_metrics(model, validation_rows, validation_groups, pad, "cuda", microbatch)

    measured = time.perf_counter()
    metrics = validate()
    validation_seconds = time.perf_counter() - measured
    best = metrics["macro_language_answer_loss"]
    events: list[dict] = []
    rates: list[float] = []
    best_step, best_state, best_minutes = 0, state_of(), 0.0
    last_metrics = metrics
    log = (out / "log.jsonl").open("w", encoding="utf-8")
    log.write(json.dumps({"step": 0, "validation_loss": round(best, 4), "validation_metrics": metrics,
                          "validation_seconds": round(validation_seconds, 2)}) + "\n")
    log.flush()
    step, last_eval_step, status = 0, 0, None
    interval = {"tokens": 0, "seconds": 0.0, "loss": 0.0, "updates": 0}
    calibration = None
    model.train()

    def evaluate() -> None:
        nonlocal best, best_step, best_state, best_minutes, status, last_eval_step, rates, last_metrics
        last_metrics = validate()
        validation = last_metrics["macro_language_answer_loss"]
        torch.cuda.empty_cache()
        rate = interval["tokens"] / interval["seconds"] if interval["seconds"] else None
        record = {"step": step, "microbatch": microbatch, "validation_loss": round(validation, 4),
                  "per_language": {language: round(value["answer_loss"], 4) for language, value in last_metrics["per_language"].items()},
                  "interval_train_loss": round(interval["loss"] / max(1, interval["updates"]), 4),
                  "tokens_per_second": round(rate, 1) if rate else None,
                  "active_minutes": round(active() / 60, 2), "paused_seconds": round(paused, 1)}
        if validation < best:
            best, best_step, best_state, best_minutes = validation, step, state_of(), active() / 60
            record["best"] = True
        interval.update(tokens=0, seconds=0.0, loss=0.0, updates=0)
        since = [event for event in events if event["step"] >= last_eval_step]
        if any(event["event"] == "out_of_memory_halved_microbatch" for event in since):
            rates = []
        if any(event["event"] == "paused_other_gpu_job" for event in since):
            rate = None
            record["speed_check"] = "skipped: another GPU job in this interval"
        log.write(json.dumps(record) + "\n")
        log.flush()
        last_eval_step = step
        if rate:
            if rates and rate < (1 - t1.SPEED_DROP) * statistics.median(rates):
                status = "stopped_speed_drop"
            rates.append(rate)

    try:
        for indices in batches:
            if step >= total_steps:
                status = "completed"
                break
            if sampler.spill.is_set():
                status = "stopped_memory_spill"
                break
            if sampler.foreign.is_set():
                waited = time.perf_counter()
                events.append({"step": step, "event": "paused_other_gpu_job", "processes": sampler.foreign_processes, "at": t1.now()})
                torch.cuda.empty_cache()
                while sampler.foreign.is_set() and time.perf_counter() - waited < t1.FOREIGN_PAUSE_LIMIT_SECONDS:
                    time.sleep(10)
                paused += time.perf_counter() - waited
                events.append({"step": step, "event": "resumed_after_other_gpu_job" if not sampler.foreign.is_set()
                               else "other_gpu_job_outlasted_pause", "paused_seconds": round(time.perf_counter() - waited, 1), "at": t1.now()})
                if sampler.foreign.is_set():
                    status = "stopped_other_gpu_job"
                    break
                sampler.reset()
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
            total_answer = t1.answer_tokens(train_rows, indices)
            while True:
                update_loss, tokens = 0.0, 0
                try:
                    for begin in range(0, len(indices), microbatch):
                        micro = indices[begin:begin + microbatch]
                        ids, mask, labels = af._batch([train_rows[index] for index in micro], pad, "cuda")
                        tokens += int(mask.sum())
                        with torch.autocast("cuda", dtype=torch.bfloat16):
                            loss = model(ids, attention_mask=mask, labels=labels).loss
                        weight = t1.answer_tokens(train_rows, micro) / total_answer
                        (loss * weight).backward()
                        update_loss += float(loss.detach()) * weight
                        del loss, ids, mask, labels
                    break
                except torch.cuda.OutOfMemoryError:
                    loss = ids = mask = labels = None  # noqa: F841
                    optimizer.zero_grad(set_to_none=True)
                    t1.release()
                    if microbatch == 1:
                        raise
                    microbatch //= 2
                    events.append({"step": step, "event": "out_of_memory_halved_microbatch", "microbatch": microbatch, "at": t1.now()})
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
            ended = status
            evaluate()
            status = ended
    finally:
        log.close()
    last_state = state_of()
    torch.save(last_state, out / "trainable-last.pt")
    torch.save(best_state, out / "trainable-best.pt")
    result = {"arm": arm, "status": status, "steps": step, "total_steps": total_steps, "calibration": calibration,
              "scored_state": "last (as the reference)", "last_validation_loss": round(last_metrics["macro_language_answer_loss"], 4),
              "last_validation_metrics": last_metrics,
              "best_step": best_step, "best_validation_loss": round(best, 4), "minutes_to_best": round(best_minutes, 2),
              "active_minutes": round(active() / 60, 2), "paused_seconds": round(paused, 1),
              "start_microbatch": start_microbatch, "microbatch": microbatch, "accumulation": EFFECTIVE_BATCH // microbatch,
              "events": events, "peak_lr": peak_lr, "warmup": WARMUP,
              "trainable_parameters": sum(parameter.numel() for parameter in trainable),
              "max_allocated_mib": round(torch.cuda.max_memory_allocated() / 2**20),
              "max_reserved_mib": round(torch.cuda.max_memory_reserved() / 2**20),
              "trainable_last_sha256": t1.sha256(out / "trainable-last.pt"),
              "trainable_best_sha256": t1.sha256(out / "trainable-best.pt")}
    del optimizer
    return result, model, tokenizer, config


def greedy(model, encoder, tokenizer, prompt: str, banned_first: frozenset[int]) -> dict:
    """run_context_test.Scorer.greedy on the in-memory arm (full logits, bf16 autocast, the same stop rules)."""
    ids = encoder.encode(prompt)
    start = len(ids)
    stop = "length"
    eos = tokenizer.eos_token_id
    for _ in range(GEN_MAX):
        with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
            row = model(torch.tensor([ids], device="cuda")).logits[0].float()[-1]
        seen = set()
        if len(ids) - start >= 2:
            a, b = ids[-2], ids[-1]
            generated = ids[start:]
            for index in range(len(generated) - 2):
                if generated[index] == a and generated[index + 1] == b:
                    seen.add(generated[index + 2])
        for token in seen | (set(banned_first) if len(ids) == start else set()):
            row[token] = -float("inf")
        chosen = int(row.argmax())
        if chosen == eos:
            stop = "eos"
            break
        ids.append(chosen)
        text = tokenizer.decode_bytes(ids[start:]).decode("utf-8", "replace")
        if "\n" in text.strip(" ") and text.strip():
            stop = "newline"
            break
    text = tokenizer.decode_bytes(ids[start:]).decode("utf-8", "replace")
    return {"text": text.split("\n")[0].strip() if text.strip() else text, "stop": stop}


def evaluate_reading(model, encoder, tokenizer, out: Path, limit: int | None) -> tuple[dict, list[dict]]:
    """eval_reading_v2.py --force: answerable rows only, a span forced at step one."""
    model.eval()
    enc = encoder.encode
    banned = frozenset({tokenizer.eos_token_id} | {enc(" " + ev.NOT[lang])[0] for lang in ev.NOT} | {enc(ev.NOT[lang])[0] for lang in ev.NOT})
    report: dict = {"gen_max": GEN_MAX, "force_answer": True, "data": str(TEST_DIR), "splits": {}}
    predictions = []
    for split in TEST_SPLITS:
        rows = [json.loads(line) for line in (TEST_DIR / f"{split}.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
        rows = rows[:limit] if limit else rows
        rows = [row for row in rows if row["kind"] == "answerable"]
        totals = {"n": 0, "em": 0.0, "f1": 0.0}
        said_not, stops = 0, {"eos": 0, "newline": 0, "length": 0}
        started = time.perf_counter()
        for row in rows:
            language = row["language"]
            answer = greedy(model, encoder, tokenizer, row["prompt"], banned)
            got = answer["text"]
            stops[answer["stop"]] += 1
            is_not = ev.norm(got, language) == ev.norm(ev.NOT[language], language) or ev.norm(got, language) == ev.norm(ev.NOT["en"], "en")
            said_not += is_not
            gold, mine = ev.norm(row["answer"], language), ev.norm(got, language)
            em, score = (0.0, 0.0) if is_not else (float(mine == gold), ev.f1(mine, gold))
            totals["n"] += 1
            totals["em"] += em
            totals["f1"] += score
            predictions.append({"split": split, "id": row["id"], "kind": row["kind"], "expected": row["answer"], "got": got,
                                "em": em, "f1": round(score, 3), "stop": answer["stop"]})
        report["splits"][split] = {"n": totals["n"], "em_pct": round(100 * totals["em"] / max(1, totals["n"]), 1),
                                   "f1_pct": round(100 * totals["f1"] / max(1, totals["n"]), 1),
                                   "answerable_said_not_stated": said_not, "stops": stops,
                                   "seconds": round(time.perf_counter() - started, 1),
                                   "dataset_sha256": t1.sha256(TEST_DIR / f"{split}.jsonl")}
        print(json.dumps({"split": split, **report["splits"][split]}, ensure_ascii=False), flush=True)
    t1.write_json(out / "eval.json", report)
    (out / "eval.predictions.jsonl").write_text("".join(json.dumps(item, ensure_ascii=False) + "\n" for item in predictions), encoding="utf-8")
    return report, predictions


def paired(predictions: list[dict], reference: dict[tuple[str, str], dict]) -> dict:
    """Per split: mean F1 difference (arm - reference) with a paired bootstrap 95% interval and a sign-flip
    permutation p-value, and McNemar exact on EM. Rows are matched by (split, id)."""
    result = {}
    rng = random.Random(t1.SEED)
    for split in TEST_SPLITS:
        pairs = [(item, reference[(split, item["id"])]) for item in predictions if item["split"] == split and (split, item["id"]) in reference]
        if not pairs:
            continue
        differences = [mine["f1"] - theirs["f1"] for mine, theirs in pairs]
        mean = statistics.fmean(differences)
        boots = sorted(statistics.fmean(rng.choices(differences, k=len(differences))) for _ in range(BOOTSTRAP))
        flips = sum(abs(statistics.fmean(d if rng.random() < 0.5 else -d for d in differences)) >= abs(mean) - 1e-12
                    for _ in range(BOOTSTRAP))
        only_arm = sum(1 for mine, theirs in pairs if mine["em"] == 1.0 and theirs["em"] != 1.0)
        only_reference = sum(1 for mine, theirs in pairs if mine["em"] != 1.0 and theirs["em"] == 1.0)
        result[split] = {"rows": len(pairs), "arm_f1_pct": round(100 * statistics.fmean(mine["f1"] for mine, _ in pairs), 1),
                         "reference_f1_pct": round(100 * statistics.fmean(theirs["f1"] for _, theirs in pairs), 1),
                         "f1_difference_points": round(100 * mean, 1),
                         "f1_difference_ci95": [round(100 * boots[int(0.025 * BOOTSTRAP)], 1), round(100 * boots[int(0.975 * BOOTSTRAP) - 1], 1)],
                         "f1_sign_flip_p": round((flips + 1) / (BOOTSTRAP + 1), 4),
                         "em_only_arm": only_arm, "em_only_reference": only_reference,
                         "em_mcnemar_p": mcnemar(only_arm, only_reference)}
    return result


def mcnemar(only_arm: int, only_reference: int) -> float:
    n = only_arm + only_reference
    if not n:
        return 1.0
    k = min(only_arm, only_reference)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / 2**n
    return round(min(1.0, 2 * tail), 6)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--arms", default="head,lora,last2")
    parser.add_argument("--budget-minutes", type=float, default=30.0)
    parser.add_argument("--smoke", action="store_true", help="1-minute budget, evaluation every 20 steps, 8 test rows per split")
    args = parser.parse_args()
    arms = [arm for arm in args.arms.split(",") if arm]
    if any(arm not in t1.ARMS for arm in arms):
        raise SystemExit(f"Arms must be among {sorted(t1.ARMS)}")
    budget = 60.0 if args.smoke else args.budget_minutes * 60
    eval_every = 20 if args.smoke else EVAL_EVERY
    limit = 8 if args.smoke else None
    out_root = (ROOT / args.out).resolve() if not args.out.is_absolute() else args.out.resolve()
    if not out_root.is_relative_to((ROOT / "artifacts").resolve()):
        raise SystemExit("--out must be inside artifacts/")
    users = t1.foreign_gpu_users()
    if users:
        raise SystemExit(f"Another job holds GPU memory: {users}")
    out_root.mkdir(parents=True, exist_ok=False)
    t1.acquire_lock("T1 reading head forms" + (" (smoke)" if args.smoke else ""))
    sampler = t1.Sampler(out_root / "resources.jsonl")
    sampler.start()
    try:
        total_mib = torch.cuda.get_device_properties(0).total_memory / 2**20
        torch.cuda.set_per_process_memory_fraction(t1.ALLOCATOR_CAP_MIB / total_mib, 0)
        payload, encoder, config = af._load_payload(t1.RUN, af._base_path(t1.RUN, t1.BASE))
        del payload
        tokenizer = encoder.tokenizer
        fits = lambda row: len(row[0]) <= config.max_context_length  # noqa: E731
        train_records = af.load_split("train", TRAIN_DIR)
        validation_records = af.load_split("validation", TRAIN_DIR)
        train_pairs = [(record, af.encode_pair(encoder, record, None)) for record in train_records]
        validation_pairs = [(record, af.encode_pair(encoder, record, None)) for record in validation_records]
        dropped = {"train": sum(not fits(row) for _, row in train_pairs), "validation": sum(not fits(row) for _, row in validation_pairs)}
        train_records = [record for record, row in train_pairs if fits(row)]
        train_rows = [row for _, row in train_pairs if fits(row)]
        validation_records = [record for record, row in validation_pairs if fits(row)]
        validation_rows = [row for _, row in validation_pairs if fits(row)]
        train_groups = af._balanced_language_groups(train_records, "train")
        validation_groups = af._balanced_language_groups(validation_records, "validation")
        reference_status = json.loads((REFERENCE_DIR / "status.json").read_text(encoding="utf-8"))
        reference_eval = json.loads(REFERENCE_EVAL.read_text(encoding="utf-8"))
        reference = {(item["split"], item["id"]): item for item in
                     (json.loads(line) for line in REFERENCE_PREDICTIONS.read_text(encoding="utf-8").splitlines() if line.strip())}
        settings = {
            "started": t1.now(), "smoke": args.smoke, "arms": {arm: t1.ARMS[arm] for arm in arms},
            "budget_seconds_per_arm": budget, "effective_batch": EFFECTIVE_BATCH, "warmup": WARMUP,
            "eval_every": eval_every, "early_stop": "none (the reference's patience was 1000)", "epochs_cap": 1, "seed": t1.SEED,
            "microbatch_candidates": t1.MICROBATCHES, "vram_limit_mib": t1.VRAM_LIMIT_MIB,
            "allocator_cap_mib": t1.ALLOCATOR_CAP_MIB, "headroom": t1.HEADROOM, "device_total_mib": round(total_mib),
            "guards": {"stop_dedicated_mib": t1.STOP_DEDICATED_MIB, "stop_shared_rise_mib": t1.STOP_SHARED_RISE_MIB,
                       "speed_drop": t1.SPEED_DROP, "pause_at_c": t1.HOT_C, "resume_at_c": t1.COOL_C,
                       "other_gpu_job_pause_limit_seconds": t1.FOREIGN_PAUSE_LIMIT_SECONDS},
            "precision": "bf16 autocast (torch.cuda.is_bf16_supported() = %s)" % torch.cuda.is_bf16_supported(),
            "base": str(t1.RUN / t1.BASE), "base_sha256": t1.sha256(t1.RUN / t1.BASE),
            "train_dir": str(TRAIN_DIR), "train_sha256": {name: t1.sha256(TRAIN_DIR / f"{name}.jsonl") for name in ("train", "validation")},
            "rows_after_drop_long": {"train": len(train_rows), "validation": len(validation_rows)}, "dropped_long": dropped,
            "rows_by_language": {"train": {language: len(indices) for language, indices in train_groups.items()},
                                 "validation": {language: len(indices) for language, indices in validation_groups.items()}},
            "test_dir": str(TEST_DIR), "test_splits": TEST_SPLITS, "scoring": "eval_reading_v2.py --force, repeated in memory",
            "reference": {"folder": str(REFERENCE_DIR), "scored_checkpoint": "reading-v3-last (final step)",
                          "minutes": reference_status.get("minutes"), "steps": reference_status.get("steps"),
                          "settings": {key: reference_status["settings"].get(key) for key in
                                       ("epochs", "batch", "accumulation", "peak_lr", "warmup", "eval_every", "patience",
                                        "balanced_languages", "group_by_length", "drop_long", "data_dir")},
                          "eval_file": str(REFERENCE_EVAL), "eval_sha256": t1.sha256(REFERENCE_EVAL),
                          "eval_splits": reference_eval["splits"]},
            "criteria": CRITERIA,
            "code_sha256": {"t1_reading.py": t1.sha256(Path(__file__)), "t1_head_forms.py": t1.sha256(Path(t1.__file__)),
                            "eval_reading_v2.py": t1.sha256(Path(ev.__file__)), "ads_finetune.py": t1.sha256(Path(af.__file__))},
            "torch": torch.__version__,
        }
        t1.write_json(out_root / "settings.json", settings)
        pad = tokenizer.pad_token_id
        longest = sorted(train_rows, key=lambda row: len(row[0]), reverse=True)[:max(t1.MICROBATCHES)]
        mixed = random.Random(t1.SEED).sample(train_rows, 4 * max(t1.MICROBATCHES))
        probes, chosen = [], {}
        for arm in arms:
            sampler.reset()
            for microbatch in t1.MICROBATCHES:
                result = t1.probe(arm, microbatch, longest, mixed, pad)
                probes.append(result)
                t1.write_json(out_root / "probe.json", probes)
                print(json.dumps(result), flush=True)
                if not result["fits"]:
                    break
                chosen[arm] = microbatch
        if not args.smoke:
            sampler.reset()
            torch.cuda.set_per_process_memory_fraction(1.0, 0)
            result = t1.probe("full", REFERENCE_MICROBATCH, longest, mixed, pad)
            result["note"] = "uncapped, measurement only; the reference trained at micro-batch 4 without a cap"
            probes.append(result)
            t1.write_json(out_root / "probe.json", probes)
            print(json.dumps(result), flush=True)
            torch.cuda.set_per_process_memory_fraction(t1.ALLOCATOR_CAP_MIB / total_mib, 0)
        summary: dict = {"probes": probes, "arms": {}}
        for arm in arms:
            if arm not in chosen:
                summary["arms"][arm] = {"status": "no_microbatch_fits"}
                continue
            out = out_root / arm
            out.mkdir()
            t1.release()
            sampler.reset()
            result, model, arm_tokenizer, _ = train_arm(arm, chosen[arm], train_rows, train_groups, validation_rows,
                                                        validation_groups, out, sampler, budget, eval_every)
            report, predictions = evaluate_reading(model, encoder, arm_tokenizer, out, limit)
            result["evaluation"] = report
            result["paired_with_reference"] = paired(predictions, reference)
            del model
            t1.release()
            t1.write_json(out / "status.json", result)
            summary["arms"][arm] = result
            t1.write_json(out_root / "summary.json", summary)
            print(json.dumps({"arm": arm, "status": result["status"],
                              "f1": {split: values["f1_pct"] for split, values in report["splits"].items()},
                              "active_minutes": result["active_minutes"]}), flush=True)
        summary["finished"] = t1.now()
        t1.write_json(out_root / "summary.json", summary)
        return 0
    finally:
        sampler.stop_event.set()
        sampler.join(timeout=90)
        t1.release_lock()


if __name__ == "__main__":
    raise SystemExit(main())
