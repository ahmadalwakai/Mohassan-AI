"""T2 follow-up: the LoRA adapter merged into the trunk's weights, against the same adapter attached.

The owner approved it on 2026-11-22 («طبعاً»), answering decision 7 of
docs/RESPONSE-QUALITY-RESULTS-2026-11-22.md. In the T2 rerun (artifacts/heads-t2-rerun-20261122) the attached
adapter was the slowest head on the card: select p95 73.4 ms against 30.7 ms for the trunk alone, because each
targeted Linear runs two more matrix products. Merging adds scaling * B @ A to each targeted weight once, so a
request then costs what the trunk costs. A merged trunk serves only that task until it is restored, as with the
last2 swap.

One fresh process per device. Requests, counts and timers are those of t2_worker.py: its helpers are imported
and its request code is repeated below, with one addition (the pointer answers are kept, to compare merged with
attached).
  trunk          the base weights, measured first and again last as a same-process baseline
  lora_attached  the Ads adapter attached, as T2 measured it
  lora_merged    the same adapter folded into the weights
  agreement      next-token argmax over the select requests, merged against attached, with the largest logit
                 difference; pointer answers against the T1 batch run (as in T2) and against attached
  switch         merge from the file, merge from deltas kept in memory, unmerge by subtraction with its drift
                 from the base, and an exact restore from a kept copy, checked with torch.equal
  reading        cuda only (--reading-lora): eval_reading_v2 --force over the first --reading-limit rows of each
                 test split, the reading adapter attached and then merged, both against that arm's own
                 predictions from the T1 reading run (which scored its last state)
Nothing is adopted or wired into the app.
  python -I scripts/heads/t2_lora_merged.py --device cuda --out artifacts/heads-t2-lora-merged-20261122 \
      --reading-lora artifacts/heads-t1-reading-20261122/lora/trainable-last.pt
  python -I scripts/heads/t2_lora_merged.py --device cpu --out artifacts/heads-t2-lora-merged-20261122
--smoke: one thread, a few requests, a functional check only (its numbers are not measurements).
"""
from __future__ import annotations

import time

STARTED = time.perf_counter()

import argparse  # noqa: E402
import json  # noqa: E402
import statistics  # noqa: E402
import sys  # noqa: E402
from datetime import datetime, timezone  # noqa: E402
from pathlib import Path  # noqa: E402

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))

import torch  # noqa: E402

import t2_worker as t2  # noqa: E402  (also loads t1_head_forms, ads_finetune and the adapters)

IMPORTED = time.perf_counter()

t1, af = t2.t1, t2.af
ADS_LORA = ROOT / "artifacts" / "heads-t1-rerun-20261122" / "lora"
READING_LIMIT = 100
SMOKE_READING_LIMIT = 3


def lora_deltas(model, state: dict) -> dict[str, torch.Tensor]:
    """scaling * B @ A for every targeted Linear of a saved adapter (attached only long enough to read it)."""
    handle = t2.attach_adapter(model, "t2-merge", rank=t1.ARMS["lora"]["rank"], alpha=t1.ARMS["lora"]["alpha"], seed=t1.SEED)
    try:
        handle.state_module().load_state_dict(state)
        with torch.no_grad():
            return {key: (module.lora_b @ module.lora_a) * module.scaling for key, module in handle.modules.items()}
    finally:
        t2.detach_adapter(model)


def shift(model, deltas: dict, sign: float) -> None:
    with torch.no_grad():
        for key, delta in deltas.items():
            model.get_submodule(key).weight.add_(delta, alpha=sign)


def restore(model, base: dict) -> None:
    with torch.no_grad():
        for key, weight in base.items():
            model.get_submodule(key).weight.copy_(weight)


def same_as(model, base: dict) -> bool:
    return all(torch.equal(model.get_submodule(key).weight, weight) for key, weight in base.items())


def drift(model, base: dict) -> float:
    with torch.no_grad():
        return max(float((model.get_submodule(key).weight - weight).abs().max()) for key, weight in base.items())


def mean(values: list[float]) -> float:
    return statistics.fmean(values) if values else 0.0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", choices=["cpu", "cuda"], required=True)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--lora-dir", type=Path, default=ADS_LORA)
    parser.add_argument("--reading-lora", type=Path, default=None)
    parser.add_argument("--reading-limit", type=int, default=None)
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")  # -I ignores PYTHONIOENCODING, and a redirected stdout is cp1252 here
    device = args.device
    counts = t2.SMOKE_COUNTS if args.smoke else t2.COUNTS
    if args.smoke:
        torch.set_num_threads(1)
    resolve = lambda path: path if path.is_absolute() else (ROOT / path).resolve()  # noqa: E731
    out = resolve(args.out)
    lora_dir = resolve(args.lora_dir)
    reading_lora = resolve(args.reading_lora) if args.reading_lora else None
    if reading_lora and device != "cuda":
        raise SystemExit("--reading-lora runs on cuda only (the reading evaluation decodes on the card)")
    reading_limit = args.reading_limit or (SMOKE_READING_LIMIT if args.smoke else READING_LIMIT)
    out.mkdir(parents=True, exist_ok=True)
    target = out / f"{device}.json"
    folders = [out / f"reading-{mode}" for mode in ("attached", "merged")] if reading_lora else []
    if target.exists() or any(folder.exists() for folder in folders):
        raise SystemExit(f"{target} or its reading folders exist; results are never overwritten")
    foreign = t1.foreign_gpu_users()
    if device == "cuda":
        if foreign:
            raise SystemExit(f"Another job holds GPU memory: {foreign}")
        t1.acquire_lock("T2 merged LoRA (cuda)" + (" smoke" if args.smoke else ""))
    load = t2.Load()
    load.start()
    try:
        autocast = (lambda: torch.autocast("cuda", dtype=torch.bfloat16)) if device == "cuda" else None
        loaded = time.perf_counter()
        model, tokenizer, config = af._load_pretrained(t1.RUN, device, t1.BASE)
        model.eval()
        lora_file = lora_dir / "trainable-best.pt"
        lora_state = torch.load(lora_file, map_location=device, weights_only=True)
        ready = time.perf_counter()
        report: dict = {
            "device": device, "started": datetime.now(timezone.utc).isoformat(timespec="seconds"), "smoke": args.smoke,
            "threads": torch.get_num_threads(), "torch": torch.__version__, "counts": counts,
            "code_sha256": t1.sha256(Path(__file__)), "t2_worker_sha256": t1.sha256(HERE / "t2_worker.py"),
            "ads_lora": str(lora_file), "ads_lora_sha256": t1.sha256(lora_file),
            "startup_seconds": {"import_torch_and_helpers": round(IMPORTED - STARTED, 2),
                                "load_trunk_and_adapter": round(ready - loaded, 2), "process_to_ready": round(ready - STARTED, 2)},
            "memory_ready": t2.memory(),
            "precision": "bf16 autocast" if device == "cuda" else "fp32",
            "weights_dtype": str(next(model.parameters()).dtype),
        }
        encoder = af.TextEncoder(t1.RUN)
        records = af.load_split("goal_test_unseen_phrasing", t1.TEST_DIR)
        prompts = [encoder.encode(af.prompt_text(record, None)) for record in records]
        selects = [prompt[-t2.SELECT_TOKENS:] for prompt in prompts[:counts["select"] + counts["warmup"]]]

        # The request code of t2_worker.py, unchanged except that time_pointer also returns the answers.
        def forward(batch: list[list[int]]):
            width = max(len(ids) for ids in batch)
            ids = torch.full((len(batch), width), tokenizer.pad_token_id, dtype=torch.long)
            mask = torch.zeros((len(batch), width), dtype=torch.bool)
            for row, sequence in enumerate(batch):
                ids[row, width - len(sequence):] = torch.tensor(sequence)
                mask[row, width - len(sequence):] = True
            with torch.no_grad():
                if autocast:
                    with autocast():
                        return model(ids.to(device), attention_mask=mask.to(device), last_token_only=True).logits[:, -1]
                return model(ids.to(device), attention_mask=mask.to(device), last_token_only=True).logits[:, -1]

        def time_selects(label: str) -> dict:
            for sequence in selects[:counts["warmup"]]:
                forward([sequence])
            single = []
            for sequence in selects[counts["warmup"]:]:
                t2.sync(device)
                began = time.perf_counter()
                forward([sequence])
                t2.sync(device)
                single.append(time.perf_counter() - began)
            batched = []
            for index in range(counts["batch"]):
                batch = [selects[(index * 8 + offset) % len(selects)] for offset in range(8)]
                t2.sync(device)
                began = time.perf_counter()
                forward(batch)
                t2.sync(device)
                batched.append(time.perf_counter() - began)
            return {"label": label, "select": t2.percentiles(single), "select8": t2.percentiles(batched)}

        def pointer(prompt: list[int]) -> tuple[str, float]:
            generated: list[int] = []
            t2.sync(device)
            began = time.perf_counter()
            for _ in range(t1.MAX_NEW_TOKENS):
                if len(prompt) + len(generated) > config.max_context_length:
                    break
                token = int(forward([prompt + generated]).argmax(dim=-1)[0])
                if token == tokenizer.eos_token_id:
                    break
                generated.append(token)
            t2.sync(device)
            return tokenizer.decode_bytes(generated).decode("utf-8", "replace"), time.perf_counter() - began

        def time_pointer(arm_dir: Path) -> tuple[dict, list[str]]:
            answers = {json.loads(line)["id"]: json.loads(line)["answer_text"]
                       for line in (arm_dir / "answers" / "goal_test_unseen_phrasing.jsonl").read_text(encoding="utf-8").splitlines() if line}
            pointer(prompts[0])
            times, same, texts = [], 0, []
            for record, prompt in zip(records[1:counts["pointer"] + 1], prompts[1:counts["pointer"] + 1]):
                text, seconds = pointer(prompt)
                times.append(seconds)
                texts.append(text)
                same += int(text == answers.get(record["id"]))
            return {**t2.percentiles(times), "same_answer_as_t1_batch_run": f"{same}/{len(times)}"}, texts

        def timed(action) -> float:
            t2.sync(device)
            began = time.perf_counter()
            action()
            t2.sync(device)
            return time.perf_counter() - began

        def select_logits() -> torch.Tensor:
            return torch.stack([forward([sequence])[0] for sequence in selects[counts["warmup"]:]]).float()

        results: dict = {}
        results["trunk"] = time_selects("trunk")
        trunk_logits = select_logits()

        began = time.perf_counter()
        handle = t2.attach_adapter(model, "t2-lora", rank=t1.ARMS["lora"]["rank"], alpha=t1.ARMS["lora"]["alpha"], seed=t1.SEED)
        handle.state_module().load_state_dict(lora_state)
        attach_seconds = time.perf_counter() - began
        results["lora_attached"] = time_selects("lora_attached")
        results["lora_attached"]["pointer"], attached_texts = time_pointer(lora_dir)
        attached_logits = select_logits()
        began = time.perf_counter()
        t2.detach_adapter(model)
        detach_seconds = time.perf_counter() - began

        deltas = lora_deltas(model, lora_state)
        base = {key: model.get_submodule(key).weight.detach().clone() for key in deltas}
        from_file, from_memory, subtract, copy_back, drifts = [], [], [], [], []
        for _ in range(counts["switch"]):
            def merge_from_file() -> None:
                fresh = lora_deltas(model, torch.load(lora_file, map_location=device, weights_only=True))
                shift(model, fresh, 1.0)
            from_file.append(timed(merge_from_file))
            restore(model, base)
            from_memory.append(timed(lambda: shift(model, deltas, 1.0)))
            subtract.append(timed(lambda: shift(model, deltas, -1.0)))
            drifts.append(drift(model, base))
            copy_back.append(timed(lambda: restore(model, base)))
        restored_after_switches = same_as(model, base)

        shift(model, deltas, 1.0)
        results["lora_merged"] = time_selects("lora_merged")
        results["lora_merged"]["pointer"], merged_texts = time_pointer(lora_dir)
        merged_logits = select_logits()
        restore(model, base)
        results["agreement"] = {
            "select_argmax_merged_vs_attached": f"{int((merged_logits.argmax(-1) == attached_logits.argmax(-1)).sum())}/{len(merged_logits)}",
            "select_max_abs_logit_difference": round(float((merged_logits - attached_logits).abs().max()), 5),
            "select_max_abs_logit_attached": round(float(attached_logits.abs().max()), 3),
            "pointer_same_text_merged_vs_attached": f"{sum(a == b for a, b in zip(merged_texts, attached_texts))}/{len(merged_texts)}",
        }
        targeted = sum(delta.numel() for delta in deltas.values())
        results["switch_seconds"] = {
            "attach_and_load_lora": round(attach_seconds, 4), "detach_lora": round(detach_seconds, 4),
            "merge_from_file_median": round(statistics.median(from_file), 4),
            "merge_from_deltas_in_memory_median": round(statistics.median(from_memory), 4),
            "unmerge_by_subtraction_median": round(statistics.median(subtract), 4),
            "unmerge_max_abs_drift_from_base": max(drifts),
            "restore_from_kept_copy_median": round(statistics.median(copy_back), 4),
            "base_restored_exactly": restored_after_switches and same_as(model, base),
            "repeats": counts["switch"],
            "targeted_linear_layers": len(deltas), "targeted_parameters": targeted,
            "trunk_parameters": sum(parameter.numel() for parameter in model.parameters()),
            "kept_copy_mib_fp32": round(targeted * 4 / 2**20, 1), "deltas_mib_fp32": round(targeted * 4 / 2**20, 1),
        }

        results["trunk_again"] = time_selects("trunk_again")
        again_logits = select_logits()
        results["trunk_again"]["logits_equal_to_first_trunk_pass"] = bool(torch.equal(again_logits, trunk_logits))
        results["trunk_again"]["max_abs_logit_difference_to_first_pass"] = round(float((again_logits - trunk_logits).abs().max()), 6)

        if reading_lora:
            import t1_reading as tr  # eval_reading_v2 reads its own flags from argv; this script passes none of them

            reading_state = torch.load(reading_lora, map_location=device, weights_only=True)
            saved = {}
            for line in (reading_lora.parent / "eval.predictions.jsonl").read_text(encoding="utf-8").splitlines():
                if line.strip():
                    row = json.loads(line)
                    saved[(row["split"], row["id"])] = row
            reading: dict = {"adapter": str(reading_lora), "adapter_sha256": t1.sha256(reading_lora),
                             "rows_per_split_before_answerable_filter": reading_limit, "modes": {}}
            outputs: dict[str, dict] = {}
            for mode, folder in zip(("attached", "merged"), folders):
                folder.mkdir(parents=True)
                if mode == "attached":
                    handle = t2.attach_adapter(model, "t2-reading", rank=t1.ARMS["lora"]["rank"], alpha=t1.ARMS["lora"]["alpha"], seed=t1.SEED)
                    handle.state_module().load_state_dict(reading_state)
                else:
                    reading_deltas = lora_deltas(model, reading_state)
                    if set(reading_deltas) != set(base):
                        raise SystemExit("The reading adapter targets other layers than the Ads adapter")
                    shift(model, reading_deltas, 1.0)
                began = time.perf_counter()
                evaluation, predictions = tr.evaluate_reading(model, encoder, tokenizer, folder, reading_limit)
                seconds = time.perf_counter() - began
                if mode == "attached":
                    t2.detach_adapter(model)
                else:
                    restore(model, base)
                outputs[mode] = {(row["split"], row["id"]): row for row in predictions}
                splits = {}
                for split in tr.TEST_SPLITS:
                    rows = [row for row in predictions if row["split"] == split]
                    earlier = [saved[(split, row["id"])] for row in rows]
                    splits[split] = {
                        "n": len(rows),
                        "same_answer_as_t1_reading_run": f"{sum(row['got'] == old['got'] for row, old in zip(rows, earlier))}/{len(rows)}",
                        "f1_pct": round(100 * mean([row["f1"] for row in rows]), 1),
                        "t1_reading_run_f1_pct_same_rows": round(100 * mean([old["f1"] for old in earlier]), 1),
                        "em_pct": round(100 * mean([row["em"] for row in rows]), 1),
                        "t1_reading_run_em_pct_same_rows": round(100 * mean([old["em"] for old in earlier]), 1),
                        "seconds": evaluation["splits"][split]["seconds"]}
                questions = len(predictions)
                reading["modes"][mode] = {"questions": questions, "seconds": round(seconds, 1),
                                          "seconds_per_question": round(seconds / max(1, questions), 3), "splits": splits}
            shared = [key for key in outputs["merged"] if key in outputs["attached"]]
            reading["merged_vs_attached_same_answer"] = f"{sum(outputs['merged'][key]['got'] == outputs['attached'][key]['got'] for key in shared)}/{len(shared)}"
            reading["base_restored_exactly"] = same_as(model, base)
            reading["note"] = "f1/em are means of the per-row values in the prediction files, rounded to 3 decimals there"
            results["reading"] = reading

        report["results"] = results
        load.stop_event.set()
        report["machine_load"] = {"gpu_jobs_at_start": foreign, **load.summary()}
        report["memory_end"] = t2.memory()
        if device == "cuda":
            report["gpu_end"] = {"max_allocated_mib": round(torch.cuda.max_memory_allocated() / 2**20),
                                 "nvidia_dedicated_mib": t1.nvidia()["dedicated_mib"]}
        report["finished"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        report["criterion_proposed"] = "p95 per head on the CPU <= 50 ms for select requests; the owner fixes it"
        target.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(json.dumps({key: report[key] for key in ("device", "startup_seconds", "machine_load")}, ensure_ascii=False))
        print(json.dumps({arm: {key: value for key, value in values.items() if key in ("select", "select8", "pointer")}
                          for arm, values in results.items() if isinstance(values, dict) and "select" in values}, ensure_ascii=False))
        print(json.dumps({"agreement": results["agreement"], "switch": results["switch_seconds"]}, ensure_ascii=False))
        if "reading" in results:
            print(json.dumps(results["reading"], ensure_ascii=False))
        return 0
    finally:
        load.stop_event.set()
        if device == "cuda":
            t1.release_lock()


if __name__ == "__main__":
    raise SystemExit(main())
