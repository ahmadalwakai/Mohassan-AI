"""Train the OCR model on rendered shards with CTC loss.

    <venv>/python -I scripts/vision/train.py --data artifacts/vision-ocr-v1/data --out artifacts/vision-ocr-v1/run-1 --steps 40000

Writes log.jsonl (loss, learning rate, held-out metrics), status.json, last.pt and
best.pt (lowest character error rate on the unseen-font held-out set).
"""
from __future__ import annotations

import argparse
import json
import math
import random
import sys
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset

sys.path.insert(0, str(Path(__file__).resolve().parent))
from charset import CLASSES, decode, encode  # noqa: E402
from model import CHANNELS_V2, DOWNSAMPLE, HEIGHT, OCRModel, POOLS_V2, greedy_decode  # noqa: E402


class LineShards(Dataset):
    """Compact index over shards: arrays for offsets and widths, plain lists for labels, so data loader workers stay small."""

    def __init__(self, data: Path, names: list[str], max_width: int | None = None) -> None:
        self.data, self.names = data, names
        shards, offsets, widths = [], [], []
        self.labels: list[str] = []
        self.texts: list[str] = []
        self.kinds: list[str] = []
        self.fonts: list[str] = []
        self.sizes: list[int] = []
        for shard, name in enumerate(names):
            meta = json.loads((data / f"{name}.json").read_text(encoding="utf-8"))
            for line in meta["lines"]:
                if max_width and line["w"] > max_width:
                    continue
                shards.append(shard)
                offsets.append(line["o"])
                widths.append(line["w"])
                self.labels.append(line["l"])
                self.texts.append(line["t"])
                self.kinds.append(line["k"])
                self.fonts.append(line["f"])
                self.sizes.append(line["s"])
            del meta
        self.shards = np.asarray(shards, dtype=np.int16)
        self.offsets = np.asarray(offsets, dtype=np.int64)
        self.width_array = np.asarray(widths, dtype=np.int32)
        self._maps: dict[int, np.memmap] = {}

    def __len__(self) -> int:
        return int(self.width_array.shape[0])

    def widths(self) -> list[int]:
        return self.width_array.tolist()

    def _map(self, shard: int) -> np.memmap:
        if shard not in self._maps:
            self._maps[shard] = np.memmap(self.data / f"{self.names[shard]}.u8", dtype=np.uint8, mode="r")
        return self._maps[shard]

    def __getitem__(self, item: int):
        shard, offset, width = int(self.shards[item]), int(self.offsets[item]), int(self.width_array[item])
        pixels = np.asarray(self._map(shard)[offset:offset + HEIGHT * width]).reshape(HEIGHT, width)
        line = {"l": self.labels[item], "t": self.texts[item], "k": self.kinds[item], "f": self.fonts[item], "s": self.sizes[item], "w": width}
        return pixels, encode(line["l"]), line


def collate(batch):
    widths = [p.shape[1] for p, _, _ in batch]
    width = max(widths)
    width += (-width) % DOWNSAMPLE
    images = np.empty((len(batch), 1, HEIGHT, width), dtype=np.float32)
    for i, (pixels, _, _) in enumerate(batch):
        fill = float(np.median(pixels[:, -2:]))
        images[i, 0, :, :pixels.shape[1]] = pixels
        images[i, 0, :, pixels.shape[1]:] = fill
    images = (images / 255.0 - 0.5) / 0.5
    targets = torch.tensor([c for _, label, _ in batch for c in label], dtype=torch.long)
    target_lengths = torch.tensor([len(label) for _, label, _ in batch], dtype=torch.long)
    input_lengths = torch.tensor([max(1, math.ceil(w / DOWNSAMPLE)) for w in widths], dtype=torch.long)
    return torch.from_numpy(images), targets, target_lengths, input_lengths, [line for _, _, line in batch]


def bucket_batches(widths: list[int], batch_size: int, rng: random.Random) -> list[list[int]]:
    order = list(range(len(widths)))
    rng.shuffle(order)
    batches = []
    span = batch_size * 32
    for start in range(0, len(order), span):
        chunk = sorted(order[start:start + span], key=lambda i: widths[i])
        for i in range(0, len(chunk), batch_size):
            batches.append(chunk[i:i + batch_size])
    rng.shuffle(batches)
    return batches


def edit_distance(a: str, b: str) -> int:
    if a == b:
        return 0
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


@torch.no_grad()
def evaluate(model: nn.Module, dataset: Dataset, device: str, batch_size: int = 64, limit: int | None = None) -> dict:
    model.eval()
    indices = list(range(len(dataset)))[:limit]
    widths = dataset.widths()
    indices.sort(key=lambda i: widths[i])
    errors = chars = exact = words_total = words_right = 0
    by_kind: dict[str, list[int]] = {}
    samples = []
    for start in range(0, len(indices), batch_size):
        batch = [dataset[i] for i in indices[start:start + batch_size]]
        images, _, _, input_lengths, lines = collate(batch)
        logits = model(images.to(device))
        for predicted, line in zip(greedy_decode(logits, input_lengths), lines):
            text = decode(predicted)
            distance = edit_distance(text, line["l"])
            errors += distance
            chars += len(line["l"])
            exact += text == line["l"]
            expected_words, got_words = line["l"].split(), text.split()
            words_total += len(expected_words)
            words_right += sum(1 for word in expected_words if word in got_words)
            kind = by_kind.setdefault(line["k"], [0, 0, 0])
            kind[0] += distance
            kind[1] += len(line["l"])
            kind[2] += 1
            if len(samples) < 12 and text != line["l"]:
                samples.append({"expected": line["l"], "got": text, "font": line["f"]})
    model.train()
    return {"cer": errors / max(1, chars), "line_accuracy": exact / max(1, len(indices)), "word_recall": words_right / max(1, words_total),
            "lines": len(indices), "by_kind": {k: {"cer": v[0] / max(1, v[1]), "lines": v[2]} for k, v in by_kind.items()}, "samples": samples}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--steps", type=int, default=40000)
    parser.add_argument("--batch", type=int, default=96)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--eval-every", type=int, default=1000)
    parser.add_argument("--eval-limit", type=int, default=1500)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--seed", type=int, default=11)
    parser.add_argument("--shards", default="")
    parser.add_argument("--max-width", type=int, default=800, help="skip wider training lines; caps the memory of the widest batches")
    parser.add_argument("--arch", choices=["v1", "v2"], default="v1", help="v1: channels 24-128, hidden 128; v2: channels 16-96, hidden 96, pooled earlier")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(args.seed)
    rng = random.Random(args.seed)
    device = args.device

    names = [p.stem for p in sorted(args.data.glob("shard-*.json"))]
    if args.shards:
        names = [n for n in names if n in args.shards.split(",")]
    train = LineShards(args.data, names, args.max_width)
    holdouts = {name: LineShards(args.data, [name]) for name in ("holdout-seen", "holdout-unseen") if (args.data / f"{name}.json").exists()}
    print(f"train lines {len(train)} from {len(names)} shards; holdouts {[(k, len(v)) for k, v in holdouts.items()]}", flush=True)

    model = (OCRModel(len(CLASSES), CHANNELS_V2, 96, POOLS_V2) if args.arch == "v2" else OCRModel(len(CLASSES))).to(device)
    parameters = sum(p.numel() for p in model.parameters())
    print(f"architecture {args.arch}: channels {model.channels} hidden {model.hidden} pools {model.pools} parameters {parameters}", flush=True)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=args.lr, total_steps=args.steps, pct_start=0.06, anneal_strategy="cos", div_factor=20, final_div_factor=200)
    ctc = nn.CTCLoss(blank=0, zero_infinity=True)
    use_amp = device.startswith("cuda")
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)
    step, best = 0, float("inf")
    last_path, best_path = args.out / "last.pt", args.out / "best.pt"
    if args.resume and last_path.exists():
        state = torch.load(last_path, map_location=device)
        model.load_state_dict(state["model"])
        optimizer.load_state_dict(state["optimizer"])
        scheduler.load_state_dict(state["scheduler"])
        step, best = state["step"], state.get("best", best)
        print("resumed at step", step, flush=True)
    log = (args.out / "log.jsonl").open("a", encoding="utf-8")

    def save(path: Path, metrics: dict | None = None) -> None:
        torch.save({"model": model.state_dict(), "optimizer": optimizer.state_dict(), "scheduler": scheduler.state_dict(), "step": step, "best": best,
                    "classes": CLASSES, "channels": model.channels, "hidden": model.hidden, "pools": model.pools, "metrics": metrics, "parameters": parameters}, path)

    def status(extra: dict) -> None:
        (args.out / "status.json").write_text(json.dumps({"step": step, "steps": args.steps, "best_unseen_cer": best, "parameters": parameters, "device": device,
                                                          "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S"), **extra}, ensure_ascii=False, indent=1), encoding="utf-8")

    model.train()
    started, window_loss, window_count = time.time(), 0.0, 0
    widths = train.widths()
    while step < args.steps:
        # Shards still being rendered join at the next pass, so generation and training overlap.
        if not args.shards:
            fresh = [p.stem for p in sorted(args.data.glob("shard-*.json")) if p.stem not in names]
            if fresh:
                names += fresh
                train = LineShards(args.data, names, args.max_width)
                widths = train.widths()
                print(f"added shards {fresh}: {len(train)} train lines", flush=True)
        loader = DataLoader(train, batch_sampler=bucket_batches(widths, args.batch, rng), collate_fn=collate, num_workers=args.workers, pin_memory=use_amp, persistent_workers=False)
        for images, targets, target_lengths, input_lengths, _ in loader:
            images = images.to(device, non_blocking=True)
            with torch.autocast("cuda", dtype=torch.float16, enabled=use_amp):
                logits = model(images)
            log_probs = logits.float().log_softmax(-1).permute(1, 0, 2)  # T, B, C
            loss = ctc(log_probs, targets, input_lengths, target_lengths)
            optimizer.zero_grad(set_to_none=True)
            scaler.scale(loss).backward()
            scaler.unscale_(optimizer)
            nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            scaler.step(optimizer)
            scaler.update()
            scheduler.step()
            step += 1
            window_loss += loss.item()
            window_count += 1
            if step % 100 == 0:
                elapsed = time.time() - started
                entry = {"step": step, "loss": window_loss / window_count, "lr": scheduler.get_last_lr()[0], "elapsed": round(elapsed), "steps_per_second": round(step / elapsed, 2)}
                log.write(json.dumps(entry) + "\n")
                log.flush()
                print(f"step {step} loss {entry['loss']:.4f} lr {entry['lr']:.2e} {entry['steps_per_second']} it/s", flush=True)
                window_loss, window_count = 0.0, 0
                status({"loss": entry["loss"]})
            if step % args.eval_every == 0 or step == args.steps:
                metrics = {name: evaluate(model, dataset, device, limit=args.eval_limit) for name, dataset in holdouts.items()}
                unseen = metrics.get("holdout-unseen", metrics.get("holdout-seen", {})).get("cer", float("inf"))
                summary = {k: {"cer": round(v["cer"], 4), "line_accuracy": round(v["line_accuracy"], 4), "word_recall": round(v["word_recall"], 4)} for k, v in metrics.items()}
                print(f"eval step {step}: {summary}", flush=True)
                log.write(json.dumps({"step": step, "eval": metrics}, ensure_ascii=False) + "\n")
                log.flush()
                if unseen < best:
                    best = unseen
                    save(best_path, metrics)
                save(last_path, metrics)
                status({"eval": summary})
            if step >= args.steps:
                break
    save(last_path)
    status({"finished": True})
    print("finished", flush=True)


if __name__ == "__main__":
    main()
