"""Render text lines into memory-mappable shards for OCR training.

    python -I scripts/vision/make_shards.py --out artifacts/vision-ocr-v1/data --train-lines 480000 --shards 8 --holdout-lines 3000 --workers 5

Each shard is `shard-NN.u8` (rows of 32 x W uint8 pixels back to back) plus
`shard-NN.json` (offset, width, label, text, kind, font per line). The held-out
sets use fresh text; `holdout-unseen` also uses fonts the training never shows.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from multiprocessing import Pool
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

_STATE: dict = {}


def _init(per_source: int) -> None:
    from render import FontRegistry
    from textgen import TextSampler
    _STATE["registry"] = FontRegistry()
    _STATE["sampler"] = TextSampler(per_source=per_source)


def _task(args: tuple[int, int, bool]) -> list[tuple[bytes, int, str, str, str, str, int]]:
    from render import render_line
    task_seed, count, holdout = args
    rng = random.Random(task_seed)
    sampler, registry = _STATE["sampler"], _STATE["registry"]
    items = []
    while len(items) < count:
        text, base, kind = sampler.sample(rng)
        rendered = render_line(text, base, rng, registry, holdout=holdout)
        if rendered is None:
            continue
        arr, label, meta = rendered
        items.append((arr.tobytes(), int(arr.shape[1]), label, text, kind, meta["font"], int(meta["size"])))
    return items


def write_set(pool: Pool, out: Path, name: str, lines: int, seed: int, holdout: bool, task_size: int = 400) -> None:
    pixels_path, index_path = out / f"{name}.u8", out / f"{name}.json"
    tasks = [(seed * 1_000_003 + i, min(task_size, lines - i * task_size), holdout) for i in range((lines + task_size - 1) // task_size)]
    index, offset, started = [], 0, time.time()
    with pixels_path.open("wb") as pixels:
        for done, items in enumerate(pool.imap_unordered(_task, tasks), 1):
            for data, width, label, text, kind, font, size in items:
                pixels.write(data)
                index.append({"o": offset, "w": width, "l": label, "t": text, "k": kind, "f": font, "s": size})
                offset += len(data)
            if done % 10 == 0 or done == len(tasks):
                print(f"  {name}: {len(index)}/{lines} lines, {offset / 1e6:.0f} MB, {time.time() - started:.0f}s", flush=True)
    index_path.write_text(json.dumps({"height": 32, "count": len(index), "bytes": offset, "lines": index}, ensure_ascii=False), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--train-lines", type=int, default=480_000)
    parser.add_argument("--shards", type=int, default=8)
    parser.add_argument("--holdout-lines", type=int, default=3000)
    parser.add_argument("--workers", type=int, default=5)
    parser.add_argument("--per-source", type=int, default=120_000)
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument("--only-holdout", action="store_true")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    started = time.time()
    with Pool(args.workers, initializer=_init, initargs=(args.per_source,)) as pool:
        write_set(pool, args.out, "holdout-seen", args.holdout_lines, args.seed + 1, holdout=False)
        write_set(pool, args.out, "holdout-unseen", args.holdout_lines, args.seed + 2, holdout=True)
        if not args.only_holdout:
            per_shard = args.train_lines // args.shards
            for shard in range(args.shards):
                write_set(pool, args.out, f"shard-{shard:02d}", per_shard, args.seed + 100 + shard, holdout=False)
    (args.out / "manifest.json").write_text(json.dumps({"seed": args.seed, "train_lines": args.train_lines, "shards": args.shards,
                                                         "holdout_lines": args.holdout_lines, "seconds": round(time.time() - started)}, indent=1), encoding="utf-8")
    print("done in", round(time.time() - started), "s")


if __name__ == "__main__":
    main()
