"""Build training and evaluation shards from matched real line crops.

    python -I scripts/vision/build_real_shards.py --lines artifacts/vision-real-v1/lines --out artifacts/vision-real-v1/data

Labels come from the page's own characters (captured by capture-lines.ts, placed by
match-lines.ts): DOM order gives the logical text, gaps without a space character become
spaces, and the visual order the model learns is computed with the same bidi rules as the
synthetic labels. A crop is kept only when the browser's measured left-to-right order of its
characters agrees with that visual order; otherwise the label could be wrong and it is dropped.

Writes real-train (web pages), gen-train (locally generated pages), real-heldout-site and
real-heldout-page (never trained on), each as <name>.u8 + <name>.json in the format of
make_shards.py, and stats.json. A held-out line whose text also appears in any training set
(menus and footers repeat across a site's pages) is dropped, so the held-out sets measure
text the model has never been trained on.
"""
from __future__ import annotations

import argparse
import bisect
import hashlib
import json
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from charset import MIRROR, classify, normalize_char, resolve_levels, visual_indices  # noqa: E402

HEIGHT = 32
MAX_LABEL = 120


def piece_label(piece: dict) -> tuple[str | None, str | None, str]:
    """Return (visual label, logical text, reason)."""
    size = max(4.0, float(piece["size"]) or 12.0)
    centres = sorted(cx for _order, raw, cx, *_rest in piece["chars"] if raw.strip())

    def neighbours(a: float, b: float) -> bool:
        """No other character sits between two logically consecutive ones; bidi reordering can put them far apart."""
        low, high = min(a, b), max(a, b)
        return bisect.bisect_left(centres, high) - bisect.bisect_right(centres, low) == 0

    seq: list[tuple[str, float | None, float, float]] = []  # char, centre x, x0, x1
    previous = None  # (order, x0, x1, was_space, centre x)
    for order, raw, cx, x0, x1, letter_case in piece["chars"]:
        text = raw.upper() if letter_case == 1 else raw.lower() if letter_case == 2 else raw
        parts = []
        for c in text:
            norm = normalize_char(c)
            if norm is None:
                return None, None, "charset"
            parts.append(norm)
        norm = "".join(parts)
        if not norm:
            continue
        if norm == " ":
            if seq and seq[-1][0] != " ":
                seq.append((" ", None, x0, x1))
            previous = (order, x0, x1, True, cx)
            continue
        if previous is not None and not previous[3]:
            adjacent = order == previous[0] + 1
            gap = max(x0 - previous[2], previous[1] - x1)
            if ((not adjacent and gap > 0.25 * size) or gap > 0.8 * size) and neighbours(previous[4], cx):
                if seq and seq[-1][0] != " ":
                    seq.append((" ", None, x0, x1))
        for c in norm:
            seq.append((c, cx, x0, x1))
        previous = (order, x0, x1, False, cx)
    while seq and seq[0][0] == " ":
        seq.pop(0)
    while seq and seq[-1][0] == " ":
        seq.pop()
    if not seq:
        return None, None, "empty"
    logical = "".join(c for c, *_ in seq)
    base = "R" if piece["base"] == "rtl" else "L"
    levels = resolve_levels(logical, base)
    order = visual_indices(levels)
    position = {index: rank for rank, index in enumerate(order)}
    measured = sorted((i for i, (c, cx, *_rest) in enumerate(seq) if cx is not None and c != " "), key=lambda i: seq[i][1])
    # Characters whose boxes overlap (ligatures, kerned pairs) are one cluster; inside it the expected order decides.
    clusters: list[dict] = []
    for i in measured:
        _, _, x0, x1 = seq[i]
        width = max(0.5, x1 - x0)
        if clusters:
            last = clusters[-1]
            if min(x1, last["x1"]) - max(x0, last["x0"]) > 0.4 * min(width, last["w"]):
                last["items"].append(i)
                last["x0"], last["x1"], last["w"] = min(last["x0"], x0), max(last["x1"], x1), min(last["w"], width)
                continue
        clusters.append({"items": [i], "x0": x0, "x1": x1, "w": width})
    browser = [i for cluster in clusters for i in sorted(cluster["items"], key=position.__getitem__)]
    wanted = set(measured)
    expected = [i for i in order if i in wanted]
    if browser != expected:
        return None, None, "bidi-order"
    label = "".join(MIRROR.get(logical[i], logical[i]) if levels[i] % 2 else logical[i] for i in order)
    label = " ".join(label.split())
    if not label or len(label) > MAX_LABEL:
        return None, None, "length"
    if not any(c.isalnum() for c in label):
        return None, None, "no-alnum"
    return label, logical, "ok"


def kind_of(label: str) -> str:
    arabic = any(classify(c) == "R" for c in label)
    latin = any(c.isascii() and c.isalpha() for c in label)
    return "real-mixed" if arabic and latin else "real-ar" if arabic else "real-en" if latin else "real-num"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lines", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--train-cap", type=int, default=4, help="most copies of one (site, label) in training")
    parser.add_argument("--skip-captures", type=Path, help="file with capture ids to leave out, one per line (bot-check pages matched before match-lines skipped them)")
    args = parser.parse_args()
    skip = set(args.skip_captures.read_text(encoding="utf-8").split()) if args.skip_captures else set()
    args.out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)
    buckets: dict[str, list[dict]] = defaultdict(list)
    reasons: Counter = Counter()
    match_reasons: Counter = Counter()
    detected = 0
    for index_path in sorted(args.lines.glob("*.json")):
        meta = json.loads(index_path.read_text(encoding="utf-8"))
        if meta["capture"] in skip:
            reasons["skipped-capture"] += 1
            continue
        detected += meta["lines"]
        match_reasons.update(meta["reasons"])
        pixels = (index_path.with_suffix(".u8")).read_bytes()
        split = meta["split"]
        if split == "train":
            bucket = "gen-train" if meta["generated"] else "real-train"
        elif meta["variant"] != "clean":
            continue
        else:
            bucket = f"real-{split}"
        for piece in meta["pieces"]:
            label, logical, reason = piece_label(piece)
            reasons[reason] += 1
            if label is None:
                continue
            data = pixels[piece["o"]:piece["o"] + HEIGHT * piece["w"]]
            if len(data) != HEIGHT * piece["w"]:
                reasons["pixels"] += 1
                continue
            buckets[bucket].append({"pixels": data, "w": piece["w"], "l": label, "t": logical, "k": kind_of(label), "f": meta["site"], "s": int(round(piece["size"])),
                                    "u": meta["url"], "v": f"{meta['source']}/{meta['variant']}", "hash": hashlib.sha1(data).hexdigest()})
    trained = {item["l"] for name, items in buckets.items() if name.endswith("train") for item in items}
    seen_in_training = {}
    for name in [n for n in buckets if not n.endswith("train")]:
        before = len(buckets[name])
        buckets[name] = [item for item in buckets[name] if item["l"] not in trained]
        seen_in_training[name] = before - len(buckets[name])
    stats = {"detected_lines": detected, "match_rejections": dict(match_reasons.most_common()), "label_outcomes": dict(reasons.most_common()),
             "heldout_dropped_as_seen_in_training": seen_in_training, "sets": {}}
    for name, items in sorted(buckets.items()):
        seen_pixels: set[str] = set()
        per_label: Counter = Counter()
        cap = args.train_cap if name.endswith("train") else 1
        rng.shuffle(items)
        kept = []
        for item in items:
            key = (item["f"], item["l"])
            if item["hash"] in seen_pixels or per_label[key] >= cap:
                continue
            seen_pixels.add(item["hash"])
            per_label[key] += 1
            kept.append(item)
        offset = 0
        index = []
        with (args.out / f"{name}.u8").open("wb") as handle:
            for item in kept:
                handle.write(item["pixels"])
                index.append({"o": offset, "w": item["w"], "l": item["l"], "t": item["t"], "k": item["k"], "f": item["f"], "s": item["s"], "u": item["u"], "v": item["v"]})
                offset += len(item["pixels"])
        (args.out / f"{name}.json").write_text(json.dumps({"height": HEIGHT, "count": len(index), "bytes": offset, "lines": index}, ensure_ascii=False), encoding="utf-8")
        kinds = Counter(item["k"] for item in kept)
        sites = Counter(item["f"] for item in kept)
        stats["sets"][name] = {"lines": len(kept), "before_dedup": len(items), "chars": sum(len(item["l"]) for item in kept), "kinds": dict(kinds), "sites": len(sites), "top_sites": dict(sites.most_common(12))}
        print(f"{name}: {len(kept)} lines (of {len(items)}), kinds {dict(kinds)}, sites {len(sites)}")
    (args.out / "stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=1), encoding="utf-8")
    print("label outcomes", dict(reasons.most_common()))
    print("held-out lines dropped because their text is in training", seen_in_training)


if __name__ == "__main__":
    main()
