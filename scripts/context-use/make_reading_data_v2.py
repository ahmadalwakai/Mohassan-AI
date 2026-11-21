"""Reading data v2 from human-written QA sets (downloaded 2026-11-20 to artifacts/reading-data-raw):
  SQuAD 2.0 (en, CC BY-SA 4.0), TyDi QA GoldP (ar + en, Apache-2.0), ARCD (ar, MIT).

Same prompt shape as the context test. Long paragraphs are cut to a window of whole sentences that
contains the answer (or, for SQuAD no-answer questions, the "plausible answer"), so every row fits
the 512-token context. Arabic has no native no-answer questions, so some are made by pairing a
question with another paragraph of the same article that does not contain its answer.

Splits (no article appears in two splits):
  train / validation  — from SQuAD train, TyDi train (ar, en), ARCD train; validation by article title.
  test_squad          — 1,000 sampled from SQuAD dev (never trained).
  test_tydi_ar        — all TyDi Arabic dev (921, never trained).
  test_arcd           — ARCD test (702, never trained).
Usage: python -I make_reading_data_v2.py OUT_DIR
"""
from __future__ import annotations

from collections import defaultdict
import hashlib
import json
from pathlib import Path
import random
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "packages/execution-model"), str(ROOT / "packages/execution-pipeline")]
sys.stdout.reconfigure(encoding="utf-8")
from execution_pipeline.pretrain import TextEncoder  # noqa: E402

RAW = ROOT / "artifacts/reading-data-raw"
RUN = ROOT / "artifacts/execution-model-runs/text-b4-2026-11-18/stage-3-full"
NOT_STATED = {"en": "Not stated in the text", "ar": "غير مذكور في النص"}
Q = {"en": "Question: ", "ar": "سؤال: "}
A = {"en": "Answer:", "ar": "الجواب:"}
PASSAGE_BUDGET = 360
TOTAL_BUDGET = 500
EN_SQUAD_TRAIN = 26000        # cap so English does not swamp Arabic (about 18k rows)
# v3: python -I make_reading_data_v2.py OUT --en-answerable 40000 --en-unanswerable-share 0.10
_arg = lambda k: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else None  # noqa: E731
EN_ANSWERABLE = int(_arg("--en-answerable")) if _arg("--en-answerable") else None
EN_UNANSWERABLE_SHARE = float(_arg("--en-unanswerable-share") or 0.10)
AR_NEGATIVE_SHARE = 0.18
SENT = re.compile(r"(?<=[.!?؟])\s+")

enc = TextEncoder(RUN)
_cache: dict[str, int] = {}


def ntok(text: str) -> int:
    n = _cache.get(text)
    if n is None:
        n = len(enc.encode(text))
        if len(_cache) < 500_000:
            _cache[text] = n
    return n


def sentences(context: str) -> list[tuple[int, int]]:
    spans, start = [], 0
    for m in SENT.finditer(context):
        spans.append((start, m.start()))
        start = m.end()
    spans.append((start, len(context)))
    return [(a, b) for a, b in spans if b > a]


def window(context: str, a_start: int | None, a_end: int | None, rng: random.Random) -> str | None:
    """Whole paragraph if it fits; else whole sentences around [a_start, a_end), grown randomly."""
    if ntok(context) <= PASSAGE_BUDGET:
        return context
    spans = sentences(context)
    if a_start is None:
        a_start = a_end = spans[rng.randrange(len(spans))][0]
    first = next((i for i, (s, e) in enumerate(spans) if s <= a_start < e + 1), None)
    last = next((i for i, (s, e) in enumerate(spans) if s < a_end <= e + 1), first)
    if first is None or last is None:
        return None
    lo, hi = first, last
    text = context[spans[lo][0]:spans[hi][1]]
    if ntok(text) > PASSAGE_BUDGET:
        return None
    grow = [-1, 1]
    while True:
        rng.shuffle(grow)
        grown = False
        for d in grow:
            nlo, nhi = (lo - 1, hi) if d < 0 else (lo, hi + 1)
            if nlo < 0 or nhi >= len(spans):
                continue
            cand = context[spans[nlo][0]:spans[nhi][1]]
            if ntok(cand) <= PASSAGE_BUDGET:
                lo, hi, text, grown = nlo, nhi, cand, True
                break
        if not grown:
            return text


def row(lang, source, title, passage, question, answer, answerable, split):
    question = " ".join(question.split())
    answer = " ".join(answer.split())
    prompt = f"{passage}\n\n{Q[lang]}{question}\n{A[lang]}"
    target = " " + (answer if answerable else NOT_STATED[lang])
    if ntok(prompt) + ntok(target) + 1 > TOTAL_BUDGET:
        return None
    if answerable and answer not in passage:
        return None
    return {"id": hashlib.sha256((source + prompt).encode()).hexdigest()[:16], "language": lang, "source": source,
            "title": title, "split": split, "kind": "answerable" if answerable else "unanswerable",
            "answer": answer if answerable else NOT_STATED[lang], "prompt": prompt, "target": target}


def squad_like(path, lang, source, rng, keep_impossible=True):
    data = json.loads(Path(path).read_text(encoding="utf-8"))["data"]
    out = []
    for art in data:
        for p in art["paragraphs"]:
            ctx = p["context"]
            for q in p["qas"]:
                if q.get("is_impossible"):
                    if not keep_impossible:
                        continue
                    pa = (q.get("plausible_answers") or [None])[0]
                    s = pa["answer_start"] if pa else None
                    e = s + len(pa["text"]) if pa else None
                    psg = window(ctx, s, e, rng)
                    r = psg and row(lang, source, art["title"], psg, q["question"], "", False, "")
                else:
                    ans = q["answers"][0]
                    s, e = ans["answer_start"], ans["answer_start"] + len(ans["text"])
                    if ctx[s:e] != ans["text"]:
                        found = ctx.find(ans["text"])
                        if found < 0:
                            continue
                        s, e = found, found + len(ans["text"])
                    psg = window(ctx, s, e, rng)
                    r = psg and row(lang, source, art["title"], psg, q["question"], ans["text"], True, "")
                if r:
                    out.append(r)
    return out


def tydi(path, lang_prefix, lang, rng):
    import pyarrow.parquet as pq
    rows = [r for r in pq.read_table(path).to_pylist() if r["id"].startswith(lang_prefix + "-")]
    out, by_title = [], defaultdict(list)
    for r in rows:
        by_title[r["title"]].append(r["context"])
    for r in rows:
        text = r["answers"]["text"][0]
        s = r["answers"]["answer_start"][0]
        ctx = r["context"]
        if ctx[s:s + len(text)] != text:
            s = ctx.find(text)
            if s < 0:
                continue
        psg = window(ctx, s, s + len(text), rng)
        x = psg and row(lang, "tydi", r["title"], psg, r["question"], text, True, "")
        if x:
            out.append(x)
    return out, by_title


def arabic_negatives(rows, contexts_by_title, share, rng):
    """Question + a different paragraph of the same article that lacks the answer."""
    out = []
    want = int(len(rows) * share / (1 - share))
    pool = rows[:]
    rng.shuffle(pool)
    for r in pool:
        if len(out) >= want:
            break
        others = [c for c in set(contexts_by_title.get(r["title"], [])) if r["answer"] not in c]
        if not others:
            continue
        ctx = rng.choice(others)
        psg = window(ctx, None, None, rng)
        q = r["prompt"].split("\n" + Q[r["language"]])[-1].split("\n")[0]
        x = psg and row(r["language"], r["source"] + "-neg", r["title"], psg, q, "", False, "")
        if x:
            out.append(x)
    return out


def split_by_title(rows, val_titles):
    tr, va = [], []
    for r in rows:
        (va if r["title"] in val_titles else tr).append(r)
    return tr, va


def main() -> int:
    out = Path(sys.argv[1]).resolve()
    out.mkdir(parents=True, exist_ok=False)
    rng = random.Random(20261120)

    squad_tr = squad_like(RAW / "squad2/train-v2.0.json", "en", "squad", rng)
    squad_dev = squad_like(RAW / "squad2/dev-v2.0.json", "en", "squad", rng)
    arcd_tr = squad_like(RAW / "arcd/arcd-train.json", "ar", "arcd", rng, keep_impossible=False)
    arcd_te = squad_like(RAW / "arcd/arcd-test.json", "ar", "arcd", rng, keep_impossible=False)
    tydi_ar_tr, ar_ctx = tydi(RAW / "tydiqa-goldp/train.parquet", "arabic", "ar", rng)
    tydi_en_tr, en_ctx = tydi(RAW / "tydiqa-goldp/train.parquet", "english", "en", rng)
    tydi_ar_dev, _ = tydi(RAW / "tydiqa-goldp/validation.parquet", "arabic", "ar", rng)

    # ARCD contexts for negatives come from ARCD train articles only.
    arcd_ctx = defaultdict(list)
    for art in json.loads((RAW / "arcd/arcd-train.json").read_text(encoding="utf-8"))["data"]:
        for p in art["paragraphs"]:
            arcd_ctx[art["title"]].append(p["context"])
    ar_pos = tydi_ar_tr + arcd_tr
    ar_neg = arabic_negatives(tydi_ar_tr, ar_ctx, AR_NEGATIVE_SHARE, rng) + \
        arabic_negatives(arcd_tr, arcd_ctx, AR_NEGATIVE_SHARE, rng)
    rng.shuffle(squad_tr)
    squad_dev_titles = {r["title"] for r in squad_dev}
    if EN_ANSWERABLE is None:      # v2 recipe: first EN_SQUAD_TRAIN rows, SQuAD's own ~1/3 no-answer mix
        en_rows = [r for r in squad_tr[:EN_SQUAD_TRAIN] + tydi_en_tr if r["title"] not in squad_dev_titles]
    else:                          # v3 recipe: more answerable rows, no-answer share set explicitly
        pos = [r for r in squad_tr if r["kind"] == "answerable"][:EN_ANSWERABLE] + tydi_en_tr
        neg_n = int(len(pos) * EN_UNANSWERABLE_SHARE / (1 - EN_UNANSWERABLE_SHARE))
        neg = [r for r in squad_tr if r["kind"] == "unanswerable"][:neg_n]
        en_rows = [r for r in pos + neg if r["title"] not in squad_dev_titles]
    ar_rows = ar_pos + ar_neg
    # No article of an Arabic test set may appear in training (TyDi and ARCD both come from Arabic Wikipedia).
    test_titles = {r["title"] for r in tydi_ar_dev + arcd_te}
    ar_rows = [r for r in ar_rows if r["title"] not in test_titles]

    titles = sorted({r["title"] for r in en_rows}), sorted({r["title"] for r in ar_rows})
    val_titles = set(random.Random(7).sample(titles[0], max(1, len(titles[0]) // 40))) | \
        set(random.Random(8).sample(titles[1], max(1, len(titles[1]) // 40)))
    train, val = [], []
    for rows in (en_rows, ar_rows):
        tr, va = split_by_title(rows, val_titles)
        train += tr
        val += va[:500]
    rng.shuffle(train)
    rng2 = random.Random(3)
    test_squad = rng2.sample(squad_dev, 1000)
    splits = {"train": train, "validation": val, "test_squad": test_squad, "test_tydi_ar": tydi_ar_dev, "test_arcd": arcd_te}
    for name, rows in splits.items():
        with (out / f"{name}.jsonl").open("w", encoding="utf-8", newline="\n") as f:
            for r in rows:
                r = dict(r, split=name)
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
    # article-overlap checks
    tr_titles = {(r["language"], r["title"]) for r in train}
    overlap = {name: sum((r["language"], r["title"]) in tr_titles for r in rows)
               for name, rows in splits.items() if name != "train"}
    summary = {
        "available": {"squad_train": len(squad_tr), "squad_dev": len(squad_dev), "tydi_ar_train": len(tydi_ar_tr),
                      "tydi_en_train": len(tydi_en_tr), "tydi_ar_dev": len(tydi_ar_dev), "arcd_train": len(arcd_tr),
                      "arcd_test": len(arcd_te), "ar_negatives_made": len(ar_neg)},
        "counts": {k: len(v) for k, v in splits.items()},
        "by_language": {k: {lang: sum(r["language"] == lang for r in v) for lang in ("ar", "en")} for k, v in splits.items()},
        "unanswerable_share": {k: round(sum(r["kind"] == "unanswerable" for r in v) / max(1, len(v)), 3) for k, v in splits.items()},
        "rows_sharing_a_train_article": overlap,
        "budgets": {"passage_tokens": PASSAGE_BUDGET, "total_tokens": TOTAL_BUDGET},
        "raw_sha256": (RAW / "SHA256SUMS").read_text(encoding="utf-8").splitlines(),
    }
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
