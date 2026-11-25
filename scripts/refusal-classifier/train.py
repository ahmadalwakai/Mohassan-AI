"""Train the refusal classifier and report its public-corpus test results."""

import argparse
import base64
from collections import defaultdict
from dataclasses import dataclass
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import tarfile
import unicodedata
from urllib.request import urlopen

# Set before importing the numerical libraries for reproducible reductions.
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"

import numpy as np
from scipy.optimize import minimize, minimize_scalar
from scipy.sparse import csr_matrix
from scipy.special import softmax

CLASSES = ("allow", "out_of_scope", "unsafe")
SPLITS = ("train", "development", "calibration", "test")
BUCKETS = 32768
SEED = 20261125
SOURCES = {
    "clinc150.json": (
        "https://raw.githubusercontent.com/clinc/oos-eval/828f8093932c8fe6ca7936c3d2e52903b1c523de/data/data_full.json",
        "36923c3705a59e08fe9c3883d8bc2dd966ef93e22cb78ac41171782a698d56e0",
    ),
    "aya-eng.jsonl": (
        "https://huggingface.co/datasets/CohereLabs/aya_redteaming/resolve/5a16fee03c19d681b4f3527b6a750e1ed4d434c7/aya_eng.jsonl",
        "08104abe7a3d84218941df35a4195096f991751a8512355ee16dd9116035f2c5",
    ),
    "aya-arb.jsonl": (
        "https://huggingface.co/datasets/CohereLabs/aya_redteaming/resolve/5a16fee03c19d681b4f3527b6a750e1ed4d434c7/aya_arb.jsonl",
        "df0fee38ea7018318ff80383943fb90df11456607cffe4791b3e717033038898",
    ),
    "massive.tar.gz": (
        "https://amazon-massive-nlu-dataset.s3.amazonaws.com/amazon-massive-dataset-1.0.tar.gz",
        "7df623fd2d300a4d235d6ee5bd396c9a28258d3a0ccb29abdb054506eba153f8",
    ),
}
CLINC_ALLOWED = set("""
    greeting goodbye thank_you what_is_your_name who_made_you are_you_a_bot calculator
    translate calories cook_time definition ingredient_substitution ingredients_list
    nutrition_info recipe restaurant_reviews spelling weather
""".split())
CLINC_UNSUPPORTED = set("""
    oos book_flight book_hotel car_rental make_call order_checks pay_bill play_music
    restaurant_reservation text transfer uber
""".split())
MASSIVE_ALLOWED = set("""
    general_greet news_query qa_maths datetime_convert cooking_recipe cooking_query
    qa_definition qa_factoid recommendation_locations recommendation_events
    recommendation_movies takeaway_query transport_traffic weather_query
""".split())
AYA_HARMS = {
    "Bullying & Harassment", "Hate Speech", "Non-consensual sexual content",
    "Violence, Threats & Incitement",
}
ARABIC_FOLD = str.maketrans("أإآٱىة٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "اااايه01234567890123456789")


@dataclass(frozen=True)
class Example:
    dataset: str
    split: str
    text: str
    label: str
    source: str = ""


def normalize(text):
    folded = unicodedata.normalize("NFKC", text[:512]).lower().translate(ARABIC_FOLD)
    folded = re.sub(r"[ـً-ٰٟ]", "", folded)
    return " ".join("".join(char if unicodedata.category(char)[0] in "LN" else " " for char in folded).split())


def hash_feature(feature):
    value = 2166136261
    for char in feature:
        value = ((value ^ ord(char)) * 16777619) & 0xffffffff
    return value % BUCKETS


def features(text):
    text = normalize(text)
    if not text:
        return set()
    chars = "^" + text + "$"
    words = text.split()
    grams = (
        (chars, range(2, 6), "c:", ""),
        (words, range(1, 3), "w:", " "),
    )
    return {
        hash_feature(prefix + joiner.join(sequence[start:start + width]))
        for sequence, widths, prefix, joiner in grams
        for width in widths
        for start in range(len(sequence) - width + 1)
    }


def pinned_source(cache, name):
    url, digest = SOURCES[name]
    path = cache / name
    existing = path.is_file()
    if existing:
        data = path.read_bytes()
    else:
        with urlopen(url, timeout=90) as response:
            data = response.read()
    if sha256(data).hexdigest() != digest:
        raise ValueError(f"SHA-256 mismatch for {name}")
    if not existing:
        path.write_bytes(data)
    return path


def bucket(dataset, group):
    digest = sha256(f"{SEED}:{dataset}:{group}".encode()).digest()
    return int.from_bytes(digest[:8], "big") % 100


def source_split(dataset, split, group):
    if split in {"val", "dev"}:
        return "development" if bucket(dataset, group) < 50 else "calibration"
    return split


def public_rows(cache):
    clinc = json.loads(pinned_source(cache, "clinc150.json").read_text(encoding="utf-8"))
    for partition in ("train", "val", "test"):
        for text, intent in clinc[partition] + clinc["oos_" + partition]:
            if intent in CLINC_ALLOWED or intent in CLINC_UNSUPPORTED:
                split = source_split("clinc150", partition, normalize(text))
                label = "allow" if intent in CLINC_ALLOWED else "out_of_scope"
                yield Example("clinc150", split, text, label, intent)

    for locale in ("eng", "arb"):
        path = pinned_source(cache, f"aya-{locale}.jsonl")
        with path.open(encoding="utf-8") as stream:
            for line in stream:
                row = json.loads(line)
                categories = set(json.loads(row["harm_category"]))
                if (row["global_or_local"] != "global"
                        or any(category.casefold() == "self-harm" for category in categories)
                        or not categories & AYA_HARMS):
                    continue
                text = row["prompt"]
                index = bucket("aya-redteaming", normalize(text))
                split = SPLITS[(index >= 70) + (index >= 80) + (index >= 90)]
                yield Example("aya-" + locale, split, text, "unsafe")

    path = pinned_source(cache, "massive.tar.gz")
    with tarfile.open(path, "r:gz") as archive:
        with archive.extractfile("1.0/data/ar-SA.jsonl") as stream:
            for line in stream:
                row = json.loads(line)
                if row["intent"] in MASSIVE_ALLOWED and row["id"] not in {"1957", "2942"}:
                    split = source_split("massive", row["partition"], row["id"])
                    yield Example("massive-ar", split, row["utt"], "allow", row["intent"])


def deduplicate(rows):
    groups = defaultdict(list)
    for row in rows:
        key = normalize(row.text)
        if key:
            groups[key].append(row)
    for group in groups.values():
        if len({row.label for row in group}) != 1:
            continue
        highest = max(SPLITS.index(row.split) for row in group)
        seen = set()
        for row in group:
            if SPLITS.index(row.split) == highest and row.dataset not in seen:
                yield row
                seen.add(row.dataset)


def matrix(rows):
    indices = []
    offsets = [0]
    for row in rows:
        indices.extend(sorted(features(row.text)))
        offsets.append(len(indices))
    return csr_matrix((np.ones(len(indices)), indices, offsets), shape=(len(rows), BUCKETS))


def fit(x, labels, penalty):
    dim = (len(CLASSES), BUCKETS + 1)
    targets = np.eye(dim[0])[labels]
    sample = 1 / np.sqrt(np.bincount(labels)[labels])
    sample /= sample.sum()

    def objective(params):
        coefficients = params.reshape(dim)
        weights, bias = coefficients[:, :-1], coefficients[:, -1]
        probs = softmax(x @ weights.T + bias, axis=1)
        loss = -sample @ np.log(np.maximum(1e-100, probs[np.arange(len(labels)), labels]))
        loss += 0.5 * penalty * np.sum(weights * weights)
        errors = sample[:, None] * (probs - targets)
        gradient = np.column_stack(((x.T @ errors).T + penalty * weights, errors.sum(axis=0)))
        return loss, gradient.ravel()

    result = minimize(objective, np.zeros(np.prod(dim)), jac=True, method="L-BFGS-B",
                      options={"maxiter": 300, "gtol": 1e-7, "ftol": 1e-11})
    if not result.success:
        raise RuntimeError(f"Logistic fit failed: {result.message}")
    return result.x.reshape(dim)


def labels_of(rows):
    return np.array([CLASSES.index(row.label) for row in rows], dtype=int)


def macro_f1(predicted, actual):
    return float(np.mean([
        2 * np.sum((predicted == label) & (actual == label))
        / (np.sum(predicted == label) + np.sum(actual == label))
        for label in range(len(CLASSES))
    ]))


def calibration(logits, actual):
    def likelihood(temperature):
        probs = softmax(logits / temperature, axis=1)
        return -np.log(np.maximum(1e-100, probs[np.arange(len(actual)), actual])).mean()

    temperature = float(minimize_scalar(likelihood, bounds=(0.1, 10), method="bounded").x)
    probs = softmax(logits / temperature, axis=1)
    predicted = probs.argmax(axis=1)
    thresholds = {}
    for index, label in enumerate(CLASSES[1:], start=1):
        for step in range(80, 101):
            threshold = step / 100
            accepted = (predicted == index) & (probs[:, index] >= threshold)
            count = int(accepted.sum())
            if count >= 10 and np.mean(actual[accepted] == index) >= 0.95:
                thresholds[label] = threshold
                break
        else:
            thresholds[label] = None
    return temperature, thresholds


def summarize(actual, predicted):
    positive = actual != 0
    refusal = predicted != 0
    tp = int(sum(positive & refusal))
    fp = int(sum(~positive & refusal))
    fn = int(sum(positive & ~refusal))
    tn = int(sum(~positive & ~refusal))
    return {
        "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "precision": tp / (tp + fp) if tp + fp else None,
        "recall": tp / (tp + fn) if tp + fn else None,
        "overRefusal": fp / (fp + tn) if fp + tn else None,
        "reasonCorrect": int(sum((actual == predicted) & refusal)),
    }


def evaluate(rows, probs, thresholds):
    actual = labels_of(rows)
    raw = probs.argmax(axis=1)
    gated = raw.copy()
    for index, label in enumerate(CLASSES[1:], start=1):
        threshold = thresholds[label]
        ineligible = probs[:, index] < threshold if threshold is not None else True
        gated[(raw == index) & ineligible] = 0
    dataset = np.array([row.dataset for row in rows])
    source = np.array([row.source for row in rows])
    groups = {name: dataset == name for name in sorted(set(dataset))}
    groups["aya-pooled"] = np.char.startswith(dataset, "aya-")
    groups["clinc150-native-oos-vs-allowed"] = (dataset == "clinc150") & ((source == "oos") | (actual == 0))
    groups["pooled"] = dataset != ""
    return {
        name: {"argmax": summarize(actual[group], raw[group]), "thresholded": summarize(actual[group], gated[group])}
        for name, group in groups.items()
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", required=True, type=Path)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--metrics", required=True, type=Path)
    parser.add_argument("--test-rows", type=Path, help="Optional ignored scratch file for running independent policy evaluation")
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)

    rows = list(deduplicate(public_rows(args.cache)))
    groups = {split: [row for row in rows if row.split == split] for split in SPLITS}
    train, dev, calibrate, test = (groups[split] for split in SPLITS)
    x_train, x_dev = matrix(train), matrix(dev)
    y_train, y_dev = labels_of(train), labels_of(dev)
    candidates = []
    for penalty in (0.0003, 0.001, 0.003, 0.01):
        candidate = fit(x_train, y_train, penalty)
        weights, bias = candidate[:, :-1], candidate[:, -1]
        score = macro_f1((x_dev @ weights.T + bias).argmax(axis=1), y_dev)
        candidates.append((score, penalty, candidate))
    dev_f1, penalty, chosen = max(candidates, key=lambda item: (item[0], item[1]))

    weights, bias = chosen[:, :-1], chosen[:, -1]
    scale = float(np.max(np.abs(weights)) / 32767)
    compressed = np.rint(weights / scale).astype("<i2")
    quantized = compressed.astype(float) * scale
    temperature, thresholds = calibration(matrix(calibrate) @ quantized.T + bias, labels_of(calibrate))
    model = {
        "classes": CLASSES, "buckets": BUCKETS, "scale": scale, "bias": bias.tolist(),
        "temperature": temperature, "thresholds": thresholds,
        "weights": [base64.b64encode(row.tobytes()).decode() for row in compressed],
    }
    args.model.write_text(json.dumps(model, indent=2) + "\n", encoding="utf-8")
    probs = softmax((matrix(test) @ quantized.T + bias) / temperature, axis=1)
    metrics = {
        "counts": {split: {label: sum(row.label == label for row in groups[split]) for label in CLASSES} for split in SPLITS},
        "penalty": penalty, "devMacroF1": dev_f1, "thresholds": thresholds,
        "test": evaluate(test, probs, thresholds),
    }
    args.metrics.write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    if args.test_rows:
        with args.test_rows.open("w", encoding="utf-8") as stream:
            for row in test:
                stream.write(json.dumps(row.__dict__, ensure_ascii=False) + "\n")
    print(f"Trained on {len(train)} human-authored prompts. Wrote {len(test)} aggregate test results to {args.metrics}.")


if __name__ == "__main__":
    main()
