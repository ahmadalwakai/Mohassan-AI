"""Exports router-b0.pt for the Node server: raw float32 weights plus a JSON header and a parity fixture.

Writes artifacts/router/router-b0.bin (embedding [buckets x dim], head weight [routes x dim], head bias [routes],
little-endian float32), router-b0.json (shapes, routes, sha256 of the .bin), and router-b0-parity.json
(Python logits for sentences, so the TypeScript port is checked against the exact same numbers).
Usage: .venv-execution/Scripts/python.exe -I scripts/router/export.py
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train import B0, BUCKETS, OUT, ROUTES, b0_batch  # noqa: E402

PARITY = ["كم سعر الذهب اليوم؟", "I run a barbershop in Manchester and want more bookings", "افتح يوتيوب وابحث عن كبسة",
          "ذكرني بموعد الطبيب بكرة", "موافق، تابع", "سكّر برنامج الوورد", "صمم لي شعار", "Close Excel", "hi", "٢٥ × ٤",
          "تحقق من موقع Google Ads بفتح https://ads.google.com/home/", "ـــأهلاً  وسهلاً ـــ", "what's the weather in Leeds tomorrow?"]


def main() -> None:
    saved = torch.load(OUT / "router-b0.pt", weights_only=False)
    model = B0()
    model.load_state_dict(saved["state"])
    model.eval()
    embedding = model.bag.weight.detach().numpy().astype("<f4")
    weight = model.head.weight.detach().numpy().astype("<f4")
    bias = model.head.bias.detach().numpy().astype("<f4")
    blob = embedding.tobytes() + weight.tobytes() + bias.tobytes()
    (OUT / "router-b0.bin").write_bytes(blob)
    header = {"kind": "b0", "buckets": BUCKETS, "dim": embedding.shape[1], "routes": ROUTES,
              "sha256": hashlib.sha256(blob).hexdigest(), "source": "router-b0.pt"}
    (OUT / "router-b0.json").write_text(json.dumps(header, ensure_ascii=False, indent=1), encoding="utf-8")
    with torch.no_grad():
        logits = model(*b0_batch(PARITY, "cpu")).numpy()
    fixture = [{"text": text, "logits": [round(float(v), 5) for v in row]} for text, row in zip(PARITY, logits)]
    (OUT / "router-b0-parity.json").write_text(json.dumps(fixture, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"exported {len(blob) / 1e6:.1f} MB, {len(PARITY)} parity rows")


if __name__ == "__main__":
    main()
