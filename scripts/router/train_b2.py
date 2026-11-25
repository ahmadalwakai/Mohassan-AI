"""Retrain B0 and compare CPU-only sparse linear routers on the existing splits."""
from __future__ import annotations

import argparse
import json
import math
import random
import statistics
import time
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path

import torch
from torch import nn
from torch.nn import functional as F

from export_b2 import b2_ngram_ids, export_b2
from train import (
    NEVER_WEB, OUT, ROUTES, WRITTEN_REPEAT, accuracy, b0_batch, class_weights,
    load_public, load_written, predict, train,
)

Row = tuple[str, int]
SEED = 7
BUCKETS = 1 << 18
BATCH = 256
EPOCHS = 16
LEARNING_RATE = 0.6


@dataclass(frozen=True)
class Candidate:
    name: str
    features: str
    balance_sources: bool = False


CANDIDATES = (
    Candidate("b2-direct", "b0"),
    Candidate("b2-extended", "extended"),
    Candidate("b2-source-balanced", "extended", balance_sources=True),
)


class SparseRouter(nn.EmbeddingBag):
    """Averaged n-gram weights directly in logit space, with a learned route bias."""

    def __init__(self) -> None:
        super().__init__(BUCKETS, len(ROUTES), mode="mean", sparse=True)
        nn.init.normal_(self.weight, std=0.01)
        self.bias = nn.Parameter(torch.empty(len(ROUTES)))
        nn.init.normal_(self.bias, std=0.01)

    def forward(self, ids: torch.Tensor, offsets: torch.Tensor) -> torch.Tensor:
        return super().forward(ids, offsets) + self.bias


def bag_batch(grams: list[list[int]]) -> tuple[torch.Tensor, torch.Tensor]:
    offsets = torch.tensor([0] + [len(ids) for ids in grams[:-1]]).cumsum(0)
    return torch.tensor([bucket for ids in grams for bucket in ids]), offsets


def encode(rows: list[Row], features: str) -> list[list[int]]:
    by_text: dict[str, list[int]] = {}
    for text, _ in rows:
        if text not in by_text:
            by_text[text] = b2_ngram_ids(text, BUCKETS, features)
    return [by_text[text] for text, _ in rows]


def sparse_predict(model: SparseRouter, features: list[list[int]]) -> list[int]:
    return [
        prediction
        for start in range(0, len(features), BATCH)
        for prediction in model(*bag_batch(features[start:start + BATCH])).argmax(-1).tolist()
    ]


def example_weights(labels: list[int], written_start: int, balance_sources: bool) -> torch.Tensor:
    if not balance_sources:
        return class_weights(labels, "cpu")[torch.tensor(labels)]

    # Give each source the same total loss weight, and each observed route
    # the same weight within its source. The data order is preserved by load_public.
    weights = []
    for source in (labels[:written_start], labels[written_start:]):
        counts = Counter(source)
        weights.extend(1 / (len(counts) * counts[label]) for label in source)
    return torch.tensor(weights)


def fit(
    candidate: Candidate, rows: list[Row], dev: list[Row], written_start: int,
    train_features: list[list[int]], dev_features: list[list[int]],
) -> tuple[SparseRouter, dict]:
    torch.manual_seed(SEED)
    rng = random.Random(SEED)
    model = SparseRouter()
    optimizer = torch.optim.Adagrad(model.parameters(), lr=LEARNING_RATE, foreach=False)
    indices = list(range(len(rows)))
    labels = [label for _, label in rows]
    targets = torch.tensor(labels)
    weights = example_weights(labels, written_start, candidate.balance_sources)
    history = []
    best_accuracy = -1.0
    best_epoch = 0
    for epoch in range(1, EPOCHS + 1):
        rng.shuffle(indices)
        for start in range(0, len(indices), BATCH):
            chunk = indices[start:start + BATCH]
            logits = model(*bag_batch([train_features[i] for i in chunk]))
            batch_weights = weights[chunk]
            loss = (F.cross_entropy(logits, targets[chunk], reduction="none") * batch_weights).sum() / batch_weights.sum()
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

        with torch.inference_mode():
            dev_accuracy = accuracy(sparse_predict(model, dev_features), dev)
        history.append({"epoch": epoch, "dev": dev_accuracy})
        print(f"  [{candidate.name}] epoch {epoch}: dev {dev_accuracy:.3f}", flush=True)
        if dev_accuracy > best_accuracy:
            best_accuracy, best_epoch = dev_accuracy, epoch
            best_state = {key: value.detach().clone() for key, value in model.state_dict().items()}
    model.load_state_dict(best_state)
    return model.eval(), {
        "params": sum(p.numel() for p in model.parameters()),
        "best_epoch": best_epoch,
        "history": history,
    }


def score(predictions: list[int], rows: list[Row]) -> dict:
    if len(predictions) != len(rows):
        raise ValueError("prediction count must match input count")
    totals = Counter(y for _, y in rows)
    correct = Counter(y for p, (_, y) in zip(predictions, rows) if p == y)
    never_web_sent_to_web = sum(
        ROUTES[y] in NEVER_WEB and ROUTES[p] == "web_search" for p, (_, y) in zip(predictions, rows)
    )
    return {
        "accuracy": sum(correct.values()) / len(rows) if rows else None,
        "per_route": {
            route: {
                "correct": correct[i],
                "total": totals[i],
                "accuracy": correct[i] / totals[i] if totals[i] else None,
            }
            for i, route in enumerate(ROUTES)
        },
        "never_web_sent_to_web": never_web_sent_to_web,
    }


def select(dev_scores: dict[str, dict]) -> str:
    """Use dev accuracy, then fewer never-web errors, then experiment order."""
    return max(dev_scores, key=lambda name: (
        dev_scores[name]["accuracy"], -dev_scores[name]["never_web_sent_to_web"]
    ))


def benchmark(infer, texts: list[str]) -> dict:
    times = []
    for text in texts:
        infer(text)
    for _ in range(20):
        for text in texts:
            start = time.perf_counter_ns()
            infer(text)
            times.append((time.perf_counter_ns() - start) / 1e6)
    return {"mean": statistics.mean(times), "p95": sorted(times)[math.ceil(0.95 * len(times)) - 1]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-only", action="store_true", help="skip MASSIVE for an offline run")
    parser.add_argument("--out", type=Path, default=OUT.parent / "router-b2")
    args = parser.parse_args()
    torch.set_num_threads(1)
    torch.use_deterministic_algorithms(True)
    splits = load_public(use_massive=not args.repo_only)
    rows, dev = splits["train"], splits["dev"]
    written_train, _ = load_written()
    written_start = len(rows) - WRITTEN_REPEAT * len(written_train)
    print({name: len(split) for name, split in splits.items()}, flush=True)

    started = time.perf_counter()
    baseline, _, baseline_info = train("b0", splits, "cpu", SEED)
    baseline_info["train_seconds"] = time.perf_counter() - started
    baseline.eval()
    models = {"b0": baseline}
    info = {"b0": baseline_info}
    dev_texts = [text for text, _ in dev]
    dev_scores = {"b0": score(predict(baseline, "b0", dev_texts, {}, "cpu"), dev)}
    experiment = {candidate.name: candidate for candidate in CANDIDATES}

    # Reuse encoded input where candidates share features. MASSIVE test
    # features are kept out of the fitting and selection path.
    cached = {}
    for candidate in CANDIDATES:
        started = time.perf_counter()
        features = candidate.features
        if features not in cached:
            cached[features] = (encode(rows, features), encode(dev, features))
        train_features, dev_features = cached[features]
        model, details = fit(candidate, rows, dev, written_start, train_features, dev_features)
        models[candidate.name] = model
        details["train_seconds"] = time.perf_counter() - started
        info[candidate.name] = details
        with torch.inference_mode():
            dev_scores[candidate.name] = score(sparse_predict(model, dev_features), dev)

    selected = select(dev_scores)
    best_candidate = select({name: dev_scores[name] for name in experiment})
    print(f"Selected on dev: {selected}; best B2 candidate: {best_candidate}", flush=True)
    test = splits["massive_test"]
    test_texts = [text for text, _ in test]
    test_features = {features: encode(test, features) for features in cached}
    with torch.inference_mode():
        for name, model in models.items():
            if name == "b0":
                test_pred = predict(model, "b0", test_texts, {}, "cpu")
                infer = lambda text: model(*b0_batch([text], "cpu"))
            else:
                features = experiment[name].features
                test_pred = sparse_predict(model, test_features[features])
                infer = lambda text: model(*bag_batch([b2_ngram_ids(text, BUCKETS, features)]))
            info[name].update(
                dev=dev_scores[name],
                massive_test=score(test_pred, test),
                cpu_ms=benchmark(infer, dev_texts),
            )
            print(name, {key: info[name][key]["accuracy"] for key in ("dev", "massive_test")},
                  "dev never-web → web", dev_scores[name]["never_web_sent_to_web"], info[name]["cpu_ms"], flush=True)

    args.out.mkdir(parents=True, exist_ok=True)
    winner = models[best_candidate]
    export_b2(args.out, winner.weight.detach().numpy(), winner.bias.detach().numpy(), experiment[best_candidate].features)
    report = {
        "seed": SEED,
        "torch": torch.__version__,
        "cpu_threads": torch.get_num_threads(),
        "splits": {name: len(split) for name, split in splits.items()},
        "candidates": [asdict(candidate) for candidate in CANDIDATES],
        "selected_on_dev": selected,
        "exported_candidate": best_candidate,
        "models": info,
    }
    (args.out / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
