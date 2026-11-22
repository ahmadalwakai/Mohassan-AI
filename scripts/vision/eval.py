"""Measure a checkpoint on the held-out sets, by kind and by font.

    <venv>/python -I scripts/vision/eval.py --run artifacts/vision-ocr-v1/run-1 --data artifacts/vision-ocr-v1/data [--json metrics.json]
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from charset import CLASSES, decode  # noqa: E402
from model import OCRModel, greedy_decode  # noqa: E402
from train import LineShards, collate, edit_distance, gpu_lock  # noqa: E402


@torch.no_grad()
def run(model: OCRModel, dataset: LineShards, device: str, batch_size: int = 64) -> dict:
    widths = dataset.widths()
    order = sorted(range(len(dataset)), key=lambda i: widths[i])
    totals = defaultdict(lambda: [0, 0, 0, 0])  # errors, chars, lines, exact
    fonts = defaultdict(lambda: [0, 0, 0])
    lengths = defaultdict(lambda: [0, 0])
    worst = []
    for start in range(0, len(order), batch_size):
        batch = [dataset[i] for i in order[start:start + batch_size]]
        images, _, _, input_lengths, lines = collate(batch)
        logits = model(images.to(device))
        for predicted, line in zip(greedy_decode(logits, input_lengths), lines):
            text = decode(predicted)
            distance = edit_distance(text, line["l"])
            for key in ("all", line["k"]):
                bucket = totals[key]
                bucket[0] += distance
                bucket[1] += len(line["l"])
                bucket[2] += 1
                bucket[3] += text == line["l"]
            font = fonts[line["f"]]
            font[0] += distance
            font[1] += len(line["l"])
            font[2] += 1
            band = "1-10" if len(line["l"]) <= 10 else "11-25" if len(line["l"]) <= 25 else "26-45" if len(line["l"]) <= 45 else "46+"
            lengths[band][0] += distance
            lengths[band][1] += len(line["l"])
            if distance:
                worst.append((distance / max(1, len(line["l"])), line["l"], text, line["f"], line["s"]))
    worst.sort(reverse=True)
    return {
        "by_kind": {k: {"cer": round(v[0] / max(1, v[1]), 4), "line_accuracy": round(v[3] / max(1, v[2]), 4), "lines": v[2]} for k, v in totals.items()},
        "by_font": {k: {"cer": round(v[0] / max(1, v[1]), 4), "lines": v[2]} for k, v in sorted(fonts.items(), key=lambda kv: -kv[1][0] / max(1, kv[1][1]))},
        "by_length": {k: {"cer": round(v[0] / max(1, v[1]), 4)} for k, v in sorted(lengths.items())},
        "worst": [{"cer": round(c, 3), "expected": e, "got": g, "font": f, "size": s} for c, e, g, f, s in worst[:25]],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--checkpoint", default="best.pt")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--json", type=Path)
    parser.add_argument("--real", type=Path, help="also measure real-heldout-site and real-heldout-page from build_real_shards.py (font column = site)")
    parser.add_argument("--skip-synthetic", action="store_true")
    args = parser.parse_args()
    with gpu_lock(args.device, f"OCR evaluation {args.run.name}"):
        evaluate_run(args)


def evaluate_run(args: argparse.Namespace) -> None:
    state = torch.load(args.run / args.checkpoint, map_location=args.device)
    pools = tuple(tuple(p) if p else None for p in state.get("pools", ((2, 2), (2, 2), None, (2, 1), (2, 1))))
    model = OCRModel(len(CLASSES), tuple(state["channels"]), state["hidden"], pools).to(args.device)
    model.load_state_dict(state["model"])
    model.eval()
    report = {"step": state.get("step"), "parameters": state.get("parameters")}
    sets = [] if args.skip_synthetic else [(args.data, name) for name in ("holdout-seen", "holdout-unseen")]
    if args.real:
        sets += [(args.real, name) for name in ("real-heldout-site", "real-heldout-page")]
    for directory, name in sets:
        if not (directory / f"{name}.json").exists():
            continue
        report[name] = run(model, LineShards(directory, [name]), args.device)
        kinds = report[name]["by_kind"]
        print(f"{name}: " + ", ".join(f"{k} CER {v['cer']:.3f} (lines {v['lines']}, exact {v['line_accuracy']:.2f})" for k, v in kinds.items()))
        print("  by length:", {k: v["cer"] for k, v in report[name]["by_length"].items()})
        print("  worst fonts:", list(report[name]["by_font"].items())[:5])
        for item in report[name]["worst"][:6]:
            print(f"  {item['font']:14s} {item['size']:2d} expected {item['expected']!r} got {item['got']!r}")
    if args.json:
        args.json.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
        print("wrote", args.json)


if __name__ == "__main__":
    main()
