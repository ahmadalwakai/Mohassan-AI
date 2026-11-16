"""Word knowledge learnt from local text, from random initialization (owner, 2026-11-15).

The goal tagger knew only the ~9,000 words of its synthetic training sentences. On the fourth
independent test most of its mistakes were ordinary words it had never met ("seek", "للدورات"),
read as a place or a service. This module learns, from text already on this machine, what
ordinary words look like: one vector per word (skip-gram with negative sampling), how common
the word is, and how often a Latin word is written with a capital inside a sentence.

No pretrained vectors, no external model, no network: the corpora are local files.

    python -I lexicon.py --corpus en=<file> --corpus ar=<file> --out <dir> [--words 70000]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
from collections import Counter
from pathlib import Path

from .goal_tagger import DIGIT, URL_WORD

STRIP = "()[]\"'“”‘’«»,.!?;:،؛؟"


def keys_of(line: str) -> list[tuple[str, bool]]:
    """The words of a line as the tagger keys them, and whether each is capitalized inside its sentence."""
    result, start = [], True
    for chunk in line.split():
        word = chunk.strip(STRIP)
        if word:
            key = "<url>" if URL_WORD.match(word) else DIGIT.sub("0", word.lower())
            result.append((key, word[0].isupper() and not start))
        start = chunk.endswith((".", "?", "!", "؟", ":"))
    return result


def read_lines(path: Path, limit: int):
    size = 0
    with path.open(encoding="utf-8", errors="ignore") as stream:
        for line in stream:
            size += len(line)
            if size > limit:
                return
            yield line


def build(args: argparse.Namespace) -> int:
    import numpy as np
    import torch
    started = time.time()
    corpora = [(item.split("=", 1)[0], Path(item.split("=", 1)[1])) for item in args.corpus]
    counts: dict[str, Counter[str]] = {}
    capitals: Counter[str] = Counter()
    insides: Counter[str] = Counter()
    for language, path in corpora:
        counter = counts.setdefault(language, Counter())
        for line in read_lines(path, args.characters):
            pairs = keys_of(line)
            counter.update(key for key, _ in pairs)
            if language == "en":
                capitals.update(key for key, capital in pairs if capital)
        print(json.dumps({"counted": str(path), "types": len(counter), "tokens": sum(counter.values()), "seconds": round(time.time() - started)}), flush=True)
    words = ["<pad>", "<unk>"]
    for language in sorted(counts):
        words += [word for word, seen in counts[language].most_common(args.words) if seen >= args.minimum and word not in words[:2]]
    words = list(dict.fromkeys(words))
    index = {word: at for at, word in enumerate(words)}
    total = Counter()
    for counter in counts.values():
        total.update({word: seen for word, seen in counter.items() if word in index})
    top = math.log(max(total.values()))
    frequency = [0.0, 0.0] + [math.log(total[word]) / top for word in words[2:]]
    capital = [0.0, 0.0] + [min(1.0, capitals[word] / total[word]) for word in words[2:]]

    # Token stream with gaps between lines, frequent words thinned as in word2vec.
    rng = np.random.default_rng(args.seed)
    all_tokens = sum(total.values())
    keep = np.ones(len(words), dtype=np.float64)
    for word, at in index.items():
        if at >= 2:
            share = total[word] / all_tokens
            keep[at] = min(1.0, math.sqrt(args.sample / share) + args.sample / share)
    pieces = []
    for language, path in corpora:
        for line in read_lines(path, args.characters):
            ids = np.fromiter((index.get(key, 1) for key, _ in keys_of(line)), dtype=np.int32)
            ids = ids[(ids > 1) & (rng.random(len(ids)) < keep[ids])]
            if len(ids) > 1:
                pieces.append(ids)
                pieces.append(np.zeros(args.window, dtype=np.int32))
    stream = torch.from_numpy(np.concatenate(pieces)).to(args.device)
    del pieces
    print(json.dumps({"words": len(words), "stream": int(stream.numel()), "seconds": round(time.time() - started)}), flush=True)

    torch.manual_seed(args.seed)
    centre = torch.nn.Embedding(len(words), args.width, sparse=True).to(args.device)
    context = torch.nn.Embedding(len(words), args.width, sparse=True).to(args.device)
    torch.nn.init.uniform_(centre.weight, -0.5 / args.width, 0.5 / args.width)
    torch.nn.init.zeros_(context.weight)
    noise = torch.tensor([0.0, 0.0] + [total[word] ** 0.75 for word in words[2:]], device=args.device)
    optimizer = torch.optim.SparseAdam(list(centre.parameters()) + list(context.parameters()), lr=args.lr)
    steps = max(1, int(stream.numel() * args.epochs * 2 * args.window / args.batch / 2))
    running = 0.0
    for step in range(steps):
        for group in optimizer.param_groups:
            group["lr"] = args.lr * max(0.05, 1 - step / steps)
        at = torch.randint(args.window, stream.numel() - args.window, (args.batch,), device=args.device)
        shift = torch.randint(1, args.window + 1, (args.batch,), device=args.device) * (torch.randint(0, 2, (args.batch,), device=args.device) * 2 - 1)
        middle, near = stream[at].long(), stream[at + shift].long()
        valid = (middle > 0) & (near > 0)
        middle, near = middle[valid], near[valid]
        negative = torch.multinomial(noise, middle.numel() * args.negatives, replacement=True).view(-1, args.negatives)
        vector = centre(middle)
        positive = torch.nn.functional.logsigmoid((vector * context(near)).sum(dim=1))
        negative_score = torch.nn.functional.logsigmoid(-(context(negative) * vector.unsqueeze(1)).sum(dim=2)).sum(dim=1)
        loss = -(positive + negative_score).mean()
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
        running += float(loss.detach())
        if (step + 1) % 2000 == 0 or step + 1 == steps:
            print(json.dumps({"step": step + 1, "steps": steps, "loss": round(running / (2000 if (step + 1) % 2000 == 0 else (steps % 2000 or 2000)), 4), "seconds": round(time.time() - started)}), flush=True)
            running = 0.0
    vectors = centre.weight.detach().float().cpu()
    vectors = vectors / vectors[2:].norm(dim=1).mean()
    vectors[:2] = 0
    args.out.mkdir(parents=True, exist_ok=True)
    torch.save({"words": words, "vectors": vectors, "frequency": torch.tensor(frequency), "capital": torch.tensor(capital)}, args.out / "lexicon.pt")
    digest = hashlib.sha256((args.out / "lexicon.pt").read_bytes()).hexdigest()
    report = {"lexicon": "goal-lexicon-v1", "initialization": "random", "externalPretrainedVectors": False, "network": False,
              "corpora": [{"language": language, "path": str(path).replace("\\", "/"), "charactersRead": args.characters} for language, path in corpora],
              "words": len(words), "width": args.width, "window": args.window, "negatives": args.negatives, "epochs": args.epochs, "steps": steps,
              "seed": args.seed, "sha256": digest, "seconds": round(time.time() - started)}
    (args.out / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report), flush=True)
    return 0


def nearest(args: argparse.Namespace) -> int:
    import torch
    payload = torch.load(args.out / "lexicon.pt", weights_only=True)
    index = {word: at for at, word in enumerate(payload["words"])}
    unit = torch.nn.functional.normalize(payload["vectors"], dim=1)
    for word in args.nearest.split(","):
        if word not in index:
            print(word, "-> not in lexicon")
            continue
        scores = unit @ unit[index[word]]
        best = scores.topk(9).indices.tolist()[1:]
        print(word, round(float(payload["frequency"][index[word]]), 2), round(float(payload["capital"][index[word]]), 2), "->", " ".join(payload["words"][at] for at in best))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", action="append", default=[], help="language=path, repeatable")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--words", type=int, default=70000, help="most frequent words kept per language")
    parser.add_argument("--minimum", type=int, default=8)
    parser.add_argument("--characters", type=int, default=300_000_000, help="characters read from each corpus file")
    parser.add_argument("--width", type=int, default=96)
    parser.add_argument("--window", type=int, default=4)
    parser.add_argument("--negatives", type=int, default=6)
    parser.add_argument("--epochs", type=float, default=2.0)
    parser.add_argument("--batch", type=int, default=32768)
    parser.add_argument("--lr", type=float, default=0.003)
    parser.add_argument("--sample", type=float, default=1e-4)
    parser.add_argument("--seed", type=int, default=3)
    parser.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    parser.add_argument("--nearest", default=None, help="comma-separated words: print neighbours from an existing lexicon")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    return nearest(args) if args.nearest else build(args)


if __name__ == "__main__":
    raise SystemExit(main())
