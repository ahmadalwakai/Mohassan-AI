"""B2 feature extraction and little-endian float32 export for Node inference."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import torch
from torch.nn import functional as F

from train import ROUTES, fold, stable


CHAR_RANGES = {"b0": (2, 3, 4), "extended": (2, 3, 4, 5)}
PARITY_TEXTS = (
    "كم سعر الذهب اليوم؟",
    "افتح يوتيوب وابحث عن كبسة",
    "ذكرني بموعد الطبيب بكرة",
    "ـــأهلاً  وسهلاً ـــ",
    "٢٥ × ٤",
    "I run a barbershop in Manchester and want more bookings",
    "what's the weather in Leeds tomorrow?",
    "Close Excel",
    "😀 Cafe\u0301\u00a0in London",
    "\ufeffParis\u001cLondon\u0085Friday\ufeff",
    "^$hello world$^",
    "",
)


def b2_ngram_ids(text: str, buckets: int, feature_version: str) -> list[int]:
    folded = f"^{fold(text)}$"
    ids = [stable(f"c{n}:{folded[i:i + n]}") % buckets
           for n in CHAR_RANGES[feature_version] for i in range(len(folded) - n + 1)]
    words = folded.strip("^$").split()
    ids.extend(stable(f"w:{word}") % buckets for word in words)
    if feature_version == "extended":
        ids.extend(stable(f"w2:{left} {right}") % buckets for left, right in zip(words, words[1:]))
    return ids or [0]


def b2_parity_logits(coefficients: np.ndarray, bias: np.ndarray, feature_version: str) -> list[dict]:
    weights = torch.from_numpy(coefficients.astype(np.float32, copy=False))
    biases = torch.from_numpy(bias.astype(np.float32, copy=False))
    fixtures = []
    with torch.inference_mode():
        for text in PARITY_TEXTS:
            ids = b2_ngram_ids(text, len(weights), feature_version)
            logits = F.embedding_bag(torch.tensor([ids]), weights, mode="mean")[0] + biases
            fixtures.append({"text": text, "logits": logits.tolist()})
    return fixtures


def export_b2(directory: Path, coefficients: np.ndarray, bias: np.ndarray, feature_version: str) -> None:
    """Write [bucket, route] coefficients, route biases, and Python logit fixtures."""
    coefficients = np.asarray(coefficients, dtype="<f4")
    bias = np.asarray(bias, dtype="<f4")
    if (coefficients.ndim != 2 or not 1 <= coefficients.shape[0] <= (1 << 20)
            or coefficients.shape[1] != len(ROUTES) or bias.shape != (len(ROUTES),)
            or feature_version not in CHAR_RANGES):
        raise ValueError("invalid B2 feature version or dimensions")
    if not np.isfinite(coefficients).all() or not np.isfinite(bias).all():
        raise ValueError("B2 weights must be finite")

    buckets = coefficients.shape[0]
    blob = coefficients.tobytes() + bias.tobytes()
    header = {"kind": "b2", "buckets": buckets, "featureVersion": feature_version, "routes": ROUTES,
              "sha256": hashlib.sha256(blob).hexdigest()}
    fixtures = b2_parity_logits(coefficients, bias, feature_version)

    directory.mkdir(parents=True, exist_ok=True)
    (directory / "router-b2.bin").write_bytes(blob)
    (directory / "router-b2.json").write_text(json.dumps(header, indent=2) + "\n", encoding="utf-8")
    (directory / "router-b2-parity.json").write_text(json.dumps(fixtures, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
