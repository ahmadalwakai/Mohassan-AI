"""Export a checkpoint to the format the TypeScript reader loads.

    <venv>/python -I scripts/vision/export.py --run artifacts/vision-ocr-v1/run-1 --data artifacts/vision-ocr-v1/data --out artifacts/vision/ocr-v1

Writes manifest.json (architecture, classes, tensor table, hashes, training
metrics), weights.bin (float32 little-endian, batch norm folded into the
convolutions) and parity.json (inputs with the exact outputs the TypeScript
implementation must reproduce).
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F

sys.path.insert(0, str(Path(__file__).resolve().parent))
from charset import CLASSES, decode, to_logical, to_visual  # noqa: E402
from model import DOWNSAMPLE, HEIGHT, OCRModel, fold_batchnorm, greedy_decode  # noqa: E402
from train import LineShards, collate  # noqa: E402

FORMAT = "mohassan-ocr-ts-v1"


def folded_forward(tensors: dict[str, torch.Tensor], channels: tuple[int, ...], hidden: int, x: torch.Tensor) -> torch.Tensor:
    """Plain functional forward over the exported tensors; must equal the module output."""
    pools = [(2, 2), (2, 2), None, (2, 1), (2, 1)]
    for index, pool in enumerate(pools):
        x = F.relu(F.conv2d(x, tensors[f"conv{index}.weight"], tensors[f"conv{index}.bias"], padding=1))
        if pool:
            x = F.max_pool2d(x, pool, pool)
    b, c, h, w = x.shape
    sequence = x.permute(0, 3, 1, 2).reshape(b, w, c * h)
    gru = nn.GRU(c * h, hidden, bidirectional=True, batch_first=True)
    with torch.no_grad():
        for name in ["weight_ih_l0", "weight_hh_l0", "bias_ih_l0", "bias_hh_l0", "weight_ih_l0_reverse", "weight_hh_l0_reverse", "bias_ih_l0_reverse", "bias_hh_l0_reverse"]:
            getattr(gru, name).copy_(tensors[f"rnn.{name}"])
    output, _ = gru(sequence)
    return F.linear(output, tensors["fc.weight"], tensors["fc.bias"])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--checkpoint", default="best.pt")
    parser.add_argument("--samples", type=int, default=8)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    checkpoint_path = args.run / args.checkpoint
    state = torch.load(checkpoint_path, map_location="cpu")
    assert state["classes"] == CLASSES, "checkpoint classes differ from charset.py"
    channels, hidden = tuple(state["channels"]), state["hidden"]
    model = OCRModel(len(CLASSES), channels, hidden)
    model.load_state_dict(state["model"])
    model.eval()

    tensors = fold_batchnorm(model)
    table, blobs, offset = [], [], 0
    for name, tensor in tensors:
        array = tensor.float().numpy().astype("<f4")
        table.append({"name": name, "shape": list(tensor.shape), "offsetFloats": offset, "count": int(array.size)})
        blobs.append(array.tobytes())
        offset += int(array.size)
    weights = b"".join(blobs)
    weights_sha = hashlib.sha256(weights).hexdigest()
    (args.out / "weights.bin").write_bytes(weights)
    max_abs = max(float(tensor.abs().max()) for _, tensor in tensors)

    folded = {name: tensor for name, tensor in tensors}
    holdout = LineShards(args.data, ["holdout-unseen"])
    picked = [i for i in range(len(holdout)) if holdout.index[i][2] <= 360][: args.samples]
    parity = []
    with torch.no_grad():
        for i in picked:
            pixels, _, line = holdout[i]
            images, _, _, input_lengths, _ = collate([(pixels, [], line)])
            expected = model(images)
            check = folded_forward(folded, channels, hidden, images)
            assert float((expected - check).abs().max()) < 1e-3, "folded forward differs from the module"
            indices = greedy_decode(expected, input_lengths)[0]
            text = decode(indices)
            steps = expected[0].argmax(-1).tolist()
            parity.append({"width": int(pixels.shape[1]), "pixelsBase64": base64.b64encode(pixels.tobytes()).decode("ascii"),
                           "argmaxPerStep": steps, "decodedIndices": indices, "visual": text, "logical": to_logical(text),
                           "label": line["l"], "labelLogical": line["t"], "font": line["f"]})
        # Two synthetic inputs with full outputs, for a numeric comparison independent of any dataset.
        numeric = []
        for seed, width in ((1, 64), (2, 96)):
            generator = torch.Generator().manual_seed(seed)
            raw = torch.randint(0, 256, (1, 1, HEIGHT, width), generator=generator).float()
            x = (raw / 255.0 - 0.5) / 0.5
            logits = model(x)[0]
            numeric.append({"width": width, "pixelsBase64": base64.b64encode(raw.to(torch.uint8).numpy().tobytes()).decode("ascii"),
                            "logits": [round(v, 5) for v in logits.flatten().tolist()], "steps": int(logits.shape[0]), "classes": int(logits.shape[1])})
    bidi_cases = ["مرحبا 123 world", "السعر 150 ريال", "Hello مرحبا", "(تجريبي)", "نسبة 12.5% فقط", "تاريخ 22/11/2026", "٢٠٢٦ عام", "مرحبا، كيف الحال؟",
                  "Total: $27.95 (USD)", "اشتريت iPhone 15 بسعر 4,500 ريال", "email: info@example.com", "«النظم» v11.3.7", "AB «مرحبا» CD"]
    parity_doc = {"format": FORMAT, "samples": parity, "numeric": numeric,
                  "bidi": [{"logical": text, "visual": to_visual(text), "base": "R" if to_visual(text) != text or any("؀" <= c <= "ۿ" for c in text) and False else None} for text in bidi_cases]}
    for case in parity_doc["bidi"]:
        case.pop("base")
        case["roundTrip"] = to_visual(to_logical(case["visual"]))
    (args.out / "parity.json").write_text(json.dumps(parity_doc, ensure_ascii=False), encoding="utf-8")

    metrics = state.get("metrics") or {}
    manifest = {
        "format": FORMAT,
        "modelId": weights_sha,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "input": {"height": HEIGHT, "channels": 1, "normalize": {"mean": 0.5, "std": 0.5}, "downsample": DOWNSAMPLE, "maxWidth": 1024},
        "architecture": {"channels": list(channels), "hidden": hidden, "pools": [[2, 2], [2, 2], None, [2, 1], [2, 1]], "classes": len(CLASSES)},
        "classes": CLASSES,
        "weights": {"dtype": "float32-le", "bytes": len(weights), "sha256": weights_sha, "maxAbsValue": round(max_abs, 4), "tensors": table},
        "training": {"step": state.get("step"), "parameters": state.get("parameters"),
                     "metrics": {k: {"cer": v.get("cer"), "lineAccuracy": v.get("line_accuracy"), "wordRecall": v.get("word_recall"), "lines": v.get("lines")} for k, v in metrics.items()}},
        "source": {"run": args.run.name, "checkpoint": args.checkpoint, "checkpointSha256": hashlib.sha256(checkpoint_path.read_bytes()).hexdigest()},
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"exported {len(weights) / 1e6:.2f} MB of weights ({offset} floats, {len(table)} tensors) to {args.out}")
    for item in parity:
        print(f"  parity {item['font']:14s} {item['label']!r} -> {item['visual']!r}")


if __name__ == "__main__":
    main()
