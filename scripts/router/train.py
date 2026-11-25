"""Mohassan's own request router: trained from scratch, no pretrained weights, no external AI.

Data (docs/ROUTER-MODEL-PLAN-2026-11-20.md §4):
  - Amazon MASSIVE 1.1 ar-SA + en-US (CC BY 4.0), intents mapped to Mohassan routes;
  - scripts/router/data/written.jsonl (routes MASSIVE lacks; written by Claude Code on the owner's instruction);
  - .data/router/real-labeled.jsonl: the owner's real messages, SEALED, scored once per model at the end.
Models: B0 = hashed char/word n-grams + linear layer; B1 = tiny character transformer.
Usage: .venv-execution/Scripts/python.exe scripts/router/train.py [--model b0|b1|both]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import re
import time
import unicodedata
from collections import Counter
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F

ROOT = Path(__file__).resolve().parents[2]
MASSIVE = ROOT / ".data/router/download/1.1/data"
WRITTEN = ROOT / "scripts/router/data/written.jsonl"
SEALED = ROOT / ".data/router/real-labeled.jsonl"
OUT = ROOT / "artifacts/router"

MASSIVE_ROUTES = {
    "web_search": ["weather_query", "qa_factoid", "qa_definition", "qa_currency", "qa_stock", "cooking_recipe", "cooking_query",
                   "transport_query", "transport_traffic", "transport_ticket", "recommendation_events", "recommendation_locations",
                   "recommendation_movies", "takeaway_query", "music_query"],
    "news": ["news_query"],
    "reminder": ["alarm_set", "alarm_query", "alarm_remove", "calendar_set", "calendar_query", "calendar_remove"],
    "memory": ["lists_query", "lists_remove", "lists_createoradd"],
    "compute": ["qa_maths", "datetime_query", "datetime_convert"],
    "chat": ["general_quirky", "general_joke", "general_greet"],
    "writing": ["email_sendemail", "social_post"],
    "pc": ["audio_volume_mute", "audio_volume_up", "audio_volume_down", "audio_volume_other"],
    "media": ["play_music", "play_radio", "play_podcasts", "play_audiobook", "play_game", "music_likeness", "music_dislikeness", "music_settings"],
    "unsupported": ["iot_hue_lightoff", "iot_hue_lightchange", "iot_hue_lightup", "iot_hue_lightdim", "iot_hue_lighton", "iot_coffee",
                    "iot_cleaning", "iot_wemo_off", "iot_wemo_on", "takeaway_order", "transport_taxi", "email_query",
                    "email_querycontact", "email_addcontact", "social_query"],
}
INTENT_TO_ROUTE = {intent: route for route, intents in MASSIVE_ROUTES.items() for intent in intents}
ROUTES = ["web_search", "browser_command", "news", "memory", "reminder", "compute", "ads", "pc", "writing", "chat", "reply",
          "image", "media", "unsupported"]
ROUTE_ID = {route: index for index, route in enumerate(ROUTES)}
NEVER_WEB = {"memory", "reminder", "pc", "ads"}


def fold(text: str) -> str:
    """The same folding as hands.ts: marks and tatweel removed, hamza/alef maqsura/ta marbuta unified, lower case."""
    text = unicodedata.normalize("NFC", text)
    text = re.sub(r"[\u0640\u064b-\u065f\u0670]", "", text)
    text = re.sub(r"[أإآٱ]", "ا", text).replace("ى", "ي").replace("ة", "ه")
    text = text.translate(str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789"))
    return re.sub(r"\s+", " ", text.lower()).strip()


def stable(text: str) -> int:
    return int(hashlib.sha256(text.encode("utf-8")).hexdigest()[:8], 16)


WRITTEN_REPEAT = 10


def load_massive() -> tuple[list[tuple[str, int]], list[tuple[str, int]]]:
    train_rows, test_rows = [], []
    for locale in ("ar-SA", "en-US"):
        for line in (MASSIVE / f"{locale}.jsonl").read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            route = INTENT_TO_ROUTE[row["intent"]]
            partition = test_rows if row["partition"] == "test" else train_rows
            partition.append((row["utt"], ROUTE_ID[route]))
    return train_rows, test_rows


def load_written() -> tuple[list[tuple[str, int]], list[tuple[str, int]]]:
    train_rows, dev_rows = [], []
    for line in WRITTEN.read_text(encoding="utf-8").splitlines():
        row = json.loads(line)
        # A fixed fifth of the written sentences is held out for model selection.
        partition = dev_rows if stable(row["text"]) % 5 == 0 else train_rows
        partition.append((row["text"], ROUTE_ID[row["route"]]))
    return train_rows, dev_rows


def load_public(*, use_massive: bool = True) -> dict[str, list[tuple[str, int]]]:
    massive_train, massive_test = load_massive() if use_massive else ([], [])
    written_train, dev = load_written()
    repeated_written = [row for row in written_train for _ in range(WRITTEN_REPEAT)]
    return {"train": massive_train + repeated_written, "dev": dev, "massive_test": massive_test}


def load(*, use_sealed: bool = False) -> dict[str, list[tuple[str, int]]]:
    splits = load_public()
    splits["sealed"] = []
    if use_sealed:
        for line in SEALED.read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            splits["sealed"].append((row["text"], ROUTE_ID[row["route"]]))
    return splits


# ---------- B0: hashed n-grams + linear layer ----------
BUCKETS = 1 << 18


def ngram_ids(text: str) -> list[int]:
    folded = f"^{fold(text)}$"
    ids = [stable(f"c{n}:{folded[i:i + n]}") % BUCKETS for n in (2, 3, 4) for i in range(len(folded) - n + 1)]
    ids += [stable(f"w:{word}") % BUCKETS for word in folded.strip("^$").split()]
    return ids or [0]


class B0(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.bag = nn.EmbeddingBag(BUCKETS, 64, mode="mean")
        self.head = nn.Linear(64, len(ROUTES))

    def forward(self, ids: torch.Tensor, offsets: torch.Tensor) -> torch.Tensor:
        return self.head(self.bag(ids, offsets))


def b0_batch(texts: list[str], device: str) -> tuple[torch.Tensor, torch.Tensor]:
    grams = [ngram_ids(text) for text in texts]
    offsets = torch.tensor([0] + [len(g) for g in grams[:-1]]).cumsum(0)
    return torch.tensor([i for g in grams for i in g], device=device), offsets.to(device)


# ---------- B1: tiny character transformer ----------
MAX_LEN = 128


class B1(nn.Module):
    def __init__(self, vocab: int, width: int = 128, layers: int = 3, heads: int = 4) -> None:
        super().__init__()
        self.embed = nn.Embedding(vocab, width, padding_idx=0)
        self.position = nn.Embedding(MAX_LEN, width)
        block = nn.TransformerEncoderLayer(width, heads, width * 4, dropout=0.1, batch_first=True, norm_first=True)
        self.encoder = nn.TransformerEncoder(block, layers)
        self.norm = nn.LayerNorm(width)
        self.head = nn.Linear(width, len(ROUTES))

    def forward(self, ids: torch.Tensor) -> torch.Tensor:
        mask = ids == 0
        x = self.embed(ids) + self.position(torch.arange(ids.shape[1], device=ids.device))
        x = self.norm(self.encoder(x, src_key_padding_mask=mask))
        keep = (~mask).unsqueeze(-1).float()
        return self.head((x * keep).sum(1) / keep.sum(1).clamp(min=1))


def b1_batch(texts: list[str], chars: dict[str, int], device: str) -> torch.Tensor:
    rows = [[chars.get(c, 1) for c in fold(text)[:MAX_LEN]] or [1] for text in texts]
    width = max(map(len, rows))
    return torch.tensor([row + [0] * (width - len(row)) for row in rows], device=device)


# ---------- training and scoring ----------
def class_weights(labels: list[int], device: str) -> torch.Tensor:
    counts = Counter(labels)
    weights = [1 / counts.get(i, 1) for i in range(len(ROUTES))]
    mean = sum(weights) / len(weights)
    return torch.tensor([w / mean for w in weights], device=device)


def predict(model: nn.Module, kind: str, texts: list[str], chars: dict[str, int], device: str) -> list[int]:
    model.eval()
    out: list[int] = []
    with torch.no_grad():
        for start in range(0, len(texts), 512):
            chunk = texts[start:start + 512]
            logits = model(*b0_batch(chunk, device)) if kind == "b0" else model(b1_batch(chunk, chars, device))
            out += logits.argmax(-1).tolist()
    return out


def accuracy(pred: list[int], data: list[tuple[str, int]]) -> float:
    return sum(p == y for p, (_, y) in zip(pred, data)) / max(1, len(data))


def train(kind: str, splits: dict, device: str, seed: int = 7) -> tuple[nn.Module, dict[str, int], dict]:
    random.seed(seed)
    torch.manual_seed(seed)
    train_rows = list(splits["train"])
    chars: dict[str, int] = {}
    if kind == "b1":
        counts = Counter(c for text, _ in train_rows for c in fold(text))
        chars = {c: i + 2 for i, (c, n) in enumerate(counts.most_common()) if n >= 2}
    model = (B0() if kind == "b0" else B1(len(chars) + 2)).to(device)
    params = sum(p.numel() for p in model.parameters())
    epochs, lr, batch = (8, 0.05, 64) if kind == "b0" else (12, 1e-3, 64)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr) if kind == "b1" else torch.optim.Adagrad(model.parameters(), lr=lr)
    weights = class_weights([y for _, y in train_rows], device)
    best = (-1.0, None, 0)
    history = []
    for epoch in range(epochs):
        model.train()
        random.shuffle(train_rows)
        total = 0.0
        for start in range(0, len(train_rows), batch):
            chunk = train_rows[start:start + batch]
            texts, labels = [t for t, _ in chunk], torch.tensor([y for _, y in chunk], device=device)
            logits = model(*b0_batch(texts, device)) if kind == "b0" else model(b1_batch(texts, chars, device))
            loss = F.cross_entropy(logits, labels, weight=weights)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            total += loss.item() * len(chunk)
        dev = accuracy(predict(model, kind, [t for t, _ in splits["dev"]], chars, device), splits["dev"])
        history.append({"epoch": epoch + 1, "loss": round(total / len(train_rows), 4), "dev": round(dev, 4)})
        print(f"  [{kind}] epoch {epoch + 1}: loss {total / len(train_rows):.4f}  dev {dev:.3f}", flush=True)
        if dev > best[0]:
            best = (dev, {k: v.detach().clone() for k, v in model.state_dict().items()}, epoch + 1)
    model.load_state_dict(best[1])
    return model, chars, {"params": params, "best_epoch": best[2], "history": history}


def mcnemar_exact(a_right: list[bool], b_right: list[bool]) -> tuple[int, int, float]:
    """Two-sided exact McNemar test on paired correctness."""
    b = sum(x and not y for x, y in zip(a_right, b_right))
    c = sum(y and not x for x, y in zip(a_right, b_right))
    n, k = b + c, min(b, c)
    p = 1.0 if n == 0 else min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n)
    return b, c, p


def main() -> None:
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=["b0", "b1", "both"], default="both")
    parser.add_argument("--sealed", action="store_true", help="score the owner's real messages (once per final model)")
    args = parser.parse_args()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    splits = load(use_sealed=args.sealed)
    print({k: len(v) for k, v in splits.items()}, "device", device)
    print("train routes:", {ROUTES[k]: n for k, n in sorted(Counter(y for _, y in splits["train"]).items())})
    OUT.mkdir(parents=True, exist_ok=True)
    rules_file = OUT / "rules-sealed.json"
    rules = json.loads(rules_file.read_text(encoding="utf-8")) if args.sealed and rules_file.exists() else None
    report: dict = {"date": time.strftime("%Y-%m-%d-%H%M%S"), "splits": {k: len(v) for k, v in splits.items()}, "models": {}}
    for kind in (["b0", "b1"] if args.model == "both" else [args.model]):
        started = time.time()
        model, chars, info = train(kind, splits, device)
        seconds = time.time() - started
        scores = {}
        for name in ("dev", "massive_test", "sealed") if args.sealed else ("dev", "massive_test"):
            data = splits[name]
            pred = predict(model, kind, [t for t, _ in data], chars, device)
            scores[name] = round(accuracy(pred, data), 4)
            if name == "dev":
                for p_, (t, y) in zip(pred, data):
                    if p_ != y:
                        print(f"    dev miss: {ROUTES[y]:>15} -> {ROUTES[p_]:<15} {t[:70]}")
            if name == "sealed":
                right = [p == y for p, (_, y) in zip(pred, data)]
                info["sealed_predictions"] = [{"text": t[:120], "label": ROUTES[y], "pred": ROUTES[p]} for p, (t, y) in zip(pred, data)]
                info["R3_never_web_sent_to_web"] = sum(ROUTES[y] in NEVER_WEB and ROUTES[p] == "web_search" for p, (_, y) in zip(pred, data))
                if rules:
                    b, c, p = mcnemar_exact(rules["right"], right)
                    info["R2_vs_rules"] = {"rules_only_right": b, "model_only_right": c, "p_value": round(p, 4)}
        # Latency on this machine, CPU, one request at a time.
        cpu = model.to("cpu")
        sample = [t for t, _ in (splits["sealed"] or splits["dev"])][:40]
        tick = time.perf_counter()
        for text in sample:
            predict(cpu, kind, [text], chars, "cpu")
        info.setdefault("R3_never_web_sent_to_web", None)
        info["cpu_ms_per_request"] = round(1000 * (time.perf_counter() - tick) / len(sample), 2)
        info.update(scores=scores, train_seconds=round(seconds, 1))
        torch.save({"kind": kind, "state": cpu.state_dict(), "chars": chars, "routes": ROUTES}, OUT / f"router-{kind}.pt")
        report["models"][kind] = info
        print(f"[{kind}] params {info['params']:,}  scores {scores}  R3 {info['R3_never_web_sent_to_web']}  "
              f"R2 {info.get('R2_vs_rules')}  cpu {info['cpu_ms_per_request']} ms", flush=True)
    (OUT / f"report-{report['date']}.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
