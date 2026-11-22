"""T2 follow-up: the full reading evaluation with the reading LoRA merged into the trunk's weights.

The owner approved it on 2026-11-22 («قيّم القراءة كاملة»), answering decision 8 of
docs/RESPONSE-QUALITY-RESULTS-2026-11-22.md. Section 2.2 of that report scored 244 of the 2,086 answerable test
questions (the first 100 rows of each split) with the adapter attached and then merged: attached reproduced the
T1 reading run 244/244, merged changed 5 answers. This script scores all 2,086 with the merged weights only, and
compares them row by row with
  - the T1 reading run's own predictions for that adapter, attached (its last state, as T1 scored it):
    artifacts/heads-t1-reading-20261122/lora/eval.predictions.jsonl
  - the reference reading-v3-last, a full fine-tune: artifacts/reading-training/eval-v3-last-forced.predictions.jsonl
using t1_reading.paired (paired bootstrap 95% interval and sign-flip p on F1, McNemar exact on EM).

Scoring is t1_reading.evaluate_reading (eval_reading_v2.py --force, bf16 autocast on the card), unchanged.
Merging is that of t2_lora_merged.py (each targeted weight plus scaling * B @ A), imported. The base weights are
kept, restored after scoring and checked with torch.equal. The card is locked (.data/gpu.lock) while it is used;
the comparisons run after it is released. Nothing is adopted or wired into the app.
  python -I scripts/heads/t2_reading_merged_full.py --out artifacts/heads-t2-reading-merged-full-20261122
--smoke: the first 3 rows of each split, a functional check only (its numbers are not measurements).
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

import t2_lora_merged as tm  # noqa: E402  (merge helpers; also loads t2_worker, t1_head_forms and ads_finetune)
import t1_reading as tr  # noqa: E402  (eval_reading_v2 reads its own flags from argv; this script passes none of them)

IMPORTED = time.perf_counter()

t2, t1, af = tm.t2, tm.t1, tm.af
READING_LORA = ROOT / "artifacts" / "heads-t1-reading-20261122" / "lora" / "trainable-last.pt"
SMOKE_ROWS = 3


def rows_by_key(path: Path) -> dict[tuple[str, str], dict]:
    table = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            row = json.loads(line)
            table[(row["split"], row["id"])] = row
    return table


def pct(values: list[float]) -> float:
    return round(100 * statistics.fmean(values), 1) if values else 0.0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--reading-lora", type=Path, default=READING_LORA)
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")  # -I ignores PYTHONIOENCODING, and a redirected stdout is cp1252 here
    resolve = lambda path: path if path.is_absolute() else (ROOT / path).resolve()  # noqa: E731
    out = resolve(args.out)
    reading_lora = resolve(args.reading_lora)
    attached_file = reading_lora.parent / "eval.predictions.jsonl"
    limit = SMOKE_ROWS if args.smoke else None
    if out.exists() and any(out.iterdir()):
        raise SystemExit(f"{out} is not empty; results are never overwritten")
    foreign = t1.foreign_gpu_users()
    if foreign:
        raise SystemExit(f"Another job holds GPU memory: {foreign}")
    t1.acquire_lock("T2 merged reading LoRA, full reading evaluation" + (" smoke" if args.smoke else ""))
    load = t2.Load()
    load.start()
    report: dict = {
        "started": datetime.now(timezone.utc).isoformat(timespec="seconds"), "smoke": args.smoke,
        "rows_per_split_before_answerable_filter": limit, "torch": torch.__version__, "precision": "bf16 autocast",
        "code_sha256": t1.sha256(Path(__file__)), "t2_lora_merged_sha256": t1.sha256(HERE / "t2_lora_merged.py"),
        "t1_reading_sha256": t1.sha256(HERE / "t1_reading.py"),
        "adapter": str(reading_lora), "adapter_sha256": t1.sha256(reading_lora),
        "attached_predictions": str(attached_file), "attached_predictions_sha256": t1.sha256(attached_file),
        "reference_predictions": str(tr.REFERENCE_PREDICTIONS),
        "reference_predictions_sha256": t1.sha256(tr.REFERENCE_PREDICTIONS),
    }
    try:
        out.mkdir(parents=True, exist_ok=True)
        loaded = time.perf_counter()
        model, tokenizer, _config = af._load_pretrained(t1.RUN, "cuda", t1.BASE)
        model.eval()
        encoder = af.TextEncoder(t1.RUN)
        state = torch.load(reading_lora, map_location="cuda", weights_only=True)
        deltas = tm.lora_deltas(model, state)
        base = {key: model.get_submodule(key).weight.detach().clone() for key in deltas}
        tm.shift(model, deltas, 1.0)
        ready = time.perf_counter()
        report["startup_seconds"] = {"import_torch_and_helpers": round(IMPORTED - STARTED, 2),
                                     "load_trunk_and_merge": round(ready - loaded, 2), "process_to_ready": round(ready - STARTED, 2)}
        report["weights_dtype"] = str(next(model.parameters()).dtype)
        report["merged"] = {"targeted_linear_layers": len(deltas), "targeted_parameters": sum(delta.numel() for delta in deltas.values())}
        began = time.perf_counter()
        evaluation, predictions = tr.evaluate_reading(model, encoder, tokenizer, out, limit)
        seconds = time.perf_counter() - began
        tm.restore(model, base)
        report["base_restored_exactly"] = tm.same_as(model, base)
        report["gpu_end"] = {"max_allocated_mib": round(torch.cuda.max_memory_allocated() / 2**20),
                             "nvidia_dedicated_mib": t1.nvidia()["dedicated_mib"]}
    finally:
        load.stop_event.set()
        t1.release_lock()
    report["card_released"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    report["machine_load"] = {"gpu_jobs_at_start": foreign, **load.summary()}
    report["memory_end"] = t2.memory()

    attached = rows_by_key(attached_file)
    reference = rows_by_key(tr.REFERENCE_PREDICTIONS)
    splits, changed_rows = {}, []
    for split in tr.TEST_SPLITS:
        rows = [row for row in predictions if row["split"] == split]
        earlier = [attached[(split, row["id"])] for row in rows]
        changed = [(row, old) for row, old in zip(rows, earlier) if row["got"] != old["got"]]
        changed_rows += [{"split": split, "id": row["id"], "expected": row["expected"], "attached": old["got"], "merged": row["got"],
                          "f1_attached": old["f1"], "f1_merged": row["f1"], "em_attached": old["em"], "em_merged": row["em"]}
                         for row, old in changed]
        splits[split] = {
            "n": len(rows), "f1_pct": evaluation["splits"][split]["f1_pct"], "em_pct": evaluation["splits"][split]["em_pct"],
            "attached_t1_run_f1_pct_same_rows": pct([old["f1"] for old in earlier]),
            "attached_t1_run_em_pct_same_rows": pct([old["em"] for old in earlier]),
            "same_answer_as_attached_t1_run": f"{len(rows) - len(changed)}/{len(rows)}",
            "changed_f1_up": sum(row["f1"] > old["f1"] for row, old in changed),
            "changed_f1_down": sum(row["f1"] < old["f1"] for row, old in changed),
            "changed_f1_equal": sum(row["f1"] == old["f1"] for row, old in changed),
            "changed_em_gained": sum(row["em"] == 1.0 and old["em"] != 1.0 for row, old in changed),
            "changed_em_lost": sum(row["em"] != 1.0 and old["em"] == 1.0 for row, old in changed),
            "seconds": evaluation["splits"][split]["seconds"],
            "seconds_per_question": round(evaluation["splits"][split]["seconds"] / max(1, len(rows)), 3),
            "attached_t1_run_seconds": None,
        }
    attached_eval = reading_lora.parent / "eval.json"
    if attached_eval.exists():
        earlier_eval = json.loads(attached_eval.read_text(encoding="utf-8"))
        for split, values in splits.items():
            values["attached_t1_run_seconds"] = earlier_eval["splits"].get(split, {}).get("seconds") if not args.smoke else None
    (out / "changed.jsonl").write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in changed_rows), encoding="utf-8")
    report["results"] = {
        "questions": len(predictions), "seconds": round(seconds, 1), "seconds_per_question": round(seconds / max(1, len(predictions)), 3),
        "splits": splits,
        "paired_vs_attached_t1_run": tr.paired(predictions, attached),
        "paired_vs_reference_v3_last": tr.paired(predictions, reference),
        "changed_answers": len(changed_rows),
        "note": "f1/em are means of the per-row values in the prediction files (rounded to 3 decimals there); "
                "attached_t1_run_seconds were measured during the T1 run, under that run's load",
    }
    report["finished"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    t1.write_json(out / "report.json", report)
    print(json.dumps({key: report[key] for key in ("startup_seconds", "base_restored_exactly", "gpu_end", "machine_load")}, ensure_ascii=False))
    print(json.dumps(report["results"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
