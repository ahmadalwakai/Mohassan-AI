"""SQuAD-style exact match and F1 for reading models on held-out splits.
Greedy, stop at newline/EOS, no repeated trigram, up to GEN tokens.
No-answer rows count as correct only when the model says the not-stated phrase; answerable rows
answered with that phrase score 0.
Usage: python eval_reading_v2.py OUT_JSON [--finetune NAME] [--data DIR] [--splits a,b] [--gen 48] [--limit N]
"""
from __future__ import annotations

from collections import Counter, defaultdict
import json
from pathlib import Path
import re
import string
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_context_test as rc  # noqa: E402  (reads --finetune from sys.argv)

sys.stdout.reconfigure(encoding="utf-8")
ARG = lambda k, d=None: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d  # noqa: E731
DATA = Path(ARG("--data", str(rc.ROOT / "artifacts/reading-training/v2")))
SPLITS = ARG("--splits", "test_squad,test_tydi_ar,test_arcd").split(",")
rc.GEN_MAX = int(ARG("--gen", "48"))
LIMIT = int(ARG("--limit")) if ARG("--limit") else None
# --force: block the first token of the not-stated phrases and EOS at step one, so the model must
# give a span; measures extraction separately from its abstain bias (answerable rows only).
FORCE = "--force" in sys.argv
# --no-passage: drop the passage from every prompt (control: is the answer read or guessed?).
NO_PASSAGE = "--no-passage" in sys.argv
NOT = {"en": "Not stated in the text", "ar": "غير مذكور في النص"}
PUNCT = set(string.punctuation) | set("،؛؟«»…“”‘’")
AR_DIAC = re.compile(r"[ً-ْٰـ]")


def norm(text: str, lang: str) -> list[str]:
    text = text.lower()
    if lang == "ar":
        text = AR_DIAC.sub("", text)
        text = re.sub("[أإآ]", "ا", text).replace("ة", "ه").replace("ى", "ي")
    text = "".join(" " if ch in PUNCT else ch for ch in text)
    words = text.split()
    if lang == "en":
        words = [w for w in words if w not in {"a", "an", "the"}]
    return words


def f1(pred: list[str], gold: list[str]) -> float:
    common = Counter(pred) & Counter(gold)
    same = sum(common.values())
    if not pred or not gold or same == 0:
        return float(pred == gold)
    p, r = same / len(pred), same / len(gold)
    return 2 * p * r / (p + r)


def main() -> int:
    out = Path(sys.argv[1]).resolve()
    scorer = rc.Scorer()
    banned = frozenset()
    if FORCE:
        enc = scorer.w.encoder.encode
        banned = frozenset({scorer.eos} | {enc(" " + NOT[l])[0] for l in NOT} | {enc(NOT[l])[0] for l in NOT})
    report = {"finetune": rc.FINETUNE, "checkpoint_sha256": rc.CHECKPOINT_SHA, "gen_max": rc.GEN_MAX,
              "force_answer": FORCE, "no_passage": NO_PASSAGE,
              "data": str(DATA), "splits": {}}
    preds = []
    for split in SPLITS:
        rows = [json.loads(l) for l in (DATA / f"{split}.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
        rows = rows[:LIMIT] if LIMIT else rows
        if FORCE:
            rows = [r for r in rows if r["kind"] == "answerable"]
        if NO_PASSAGE:
            rows = [dict(r, prompt=r["prompt"].split("\n\n")[-1]) for r in rows]
        t = defaultdict(lambda: {"n": 0, "em": 0.0, "f1": 0.0})
        said_not = 0
        started = time.perf_counter()
        for r in rows:
            lang = r["language"]
            got = scorer.greedy(r["prompt"], banned)["text"]
            is_not = norm(got, lang) == norm(NOT[lang], lang) or norm(got, lang) == norm(NOT["en"], "en")
            if r["kind"] == "unanswerable":
                em = fs = float(is_not)
            else:
                said_not += is_not
                g, p = norm(r["answer"], lang), norm(got, lang)
                em, fs = (0.0, 0.0) if is_not else (float(p == g), f1(p, g))
            for key in ("all", r["kind"]):
                t[key]["n"] += 1
                t[key]["em"] += em
                t[key]["f1"] += fs
            preds.append({"split": split, "id": r["id"], "kind": r["kind"], "expected": r["answer"], "got": got,
                          "em": em, "f1": round(fs, 3)})
        report["splits"][split] = {k: {"n": v["n"], "em_pct": round(100 * v["em"] / v["n"], 1),
                                       "f1_pct": round(100 * v["f1"] / v["n"], 1)} for k, v in t.items()}
        report["splits"][split]["answerable_said_not_stated"] = said_not
        report["splits"][split]["seconds"] = round(time.perf_counter() - started, 1)
        print(split, json.dumps(report["splits"][split], ensure_ascii=False), flush=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    out.with_suffix(".predictions.jsonl").write_text(
        "".join(json.dumps(p, ensure_ascii=False) + "\n" for p in preds), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
