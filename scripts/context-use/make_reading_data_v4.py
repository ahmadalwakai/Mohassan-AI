"""Reading data v4: hard negatives on top of v3, for a short continuation of reading-v3-last (2026-11-20).

Why: the independent check showed abstaining barely tracks evidence. The model was never trained on
"same topic, answer removed". v3 negatives are SQuAD-native (en, 10%) and other-paragraph (ar).
v4 train (one epoch, continued from reading-v3-last):
  replay      answerable rows sampled from v3 train (keeps extraction)
  deleted     a v3-train answerable row with every sentence holding the answer removed -> not stated (ar + en)
  squad-neg   SQuAD-train native no-answer questions not already in v3 train (en)
Validation = v3 validation unchanged. Train articles only; no dev or test article is used.
Usage: python -I make_reading_data_v4.py OUT_DIR [--rows 24000] [--neg-share 0.30]
"""
from __future__ import annotations

from collections import Counter
import hashlib
import json
from pathlib import Path
import random
import shutil
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import make_reading_data_v2 as mk  # noqa: E402

V3 = mk.ROOT / "artifacts/reading-training/v3"
_arg = lambda k, d: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d  # noqa: E731
ROWS = int(_arg("--rows", "24000"))
NEG_SHARE = float(_arg("--neg-share", "0.30"))


def deleted(r: dict) -> dict | None:
    lang = r["language"]
    passage, tail = r["prompt"].rsplit("\n\n" + mk.Q[lang], 1)
    spans = mk.sentences(passage)
    kept = [passage[a:b] for a, b in spans if r["answer"] not in passage[a:b]]
    rest = " ".join(kept)
    if not kept or len(kept) == len(spans) or r["answer"] in rest or len(rest.split()) < 8:
        return None
    prompt = f"{rest}\n\n{mk.Q[lang]}{tail}"
    return {"id": hashlib.sha256(("del" + prompt).encode()).hexdigest()[:16], "language": lang,
            "source": r["source"] + "-deleted", "title": r["title"], "split": "train", "kind": "unanswerable",
            "answer": mk.NOT_STATED[lang], "prompt": prompt, "target": " " + mk.NOT_STATED[lang]}


def main() -> int:
    out = Path(sys.argv[1]).resolve()
    out.mkdir(parents=True, exist_ok=False)
    rng = random.Random(20261123)
    v3 = [json.loads(l) for l in (V3 / "train.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    v3_prompts = {r["prompt"] for r in v3}
    ans = {l: [r for r in v3 if r["kind"] == "answerable" and r["language"] == l] for l in ("ar", "en")}
    per_lang = ROWS // 2
    n_neg = int(per_lang * NEG_SHARE)
    n_pos = per_lang - n_neg
    rows = []
    for lang in ("ar", "en"):
        pool = ans[lang][:]
        rng.shuffle(pool)
        rows += pool[:n_pos]
        want_del = n_neg if lang == "ar" else n_neg // 2
        made = 0
        for r in pool[n_pos:] + pool[:n_pos]:
            if made >= want_del:
                break
            d = deleted(r)
            if d:
                rows.append(d)
                made += 1
    squad = [r for r in mk.squad_like(mk.RAW / "squad2/train-v2.0.json", "en", "squad", rng)
             if r["kind"] == "unanswerable" and r["prompt"] not in v3_prompts]
    rng.shuffle(squad)
    en_neg_now = sum(1 for r in rows if r["language"] == "en" and r["kind"] == "unanswerable")
    rows += [dict(r, source="squad-neg", split="train") for r in squad[:n_neg - en_neg_now]]
    rng.shuffle(rows)
    (out / "train.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    shutil.copyfile(V3 / "validation.jsonl", out / "validation.jsonl")
    summary = {"rows": len(rows), "neg_share": NEG_SHARE,
               "by": dict(sorted(Counter(f"{r['language']}:{r['kind']}:{r['source']}" for r in rows).items())),
               "base_data": "v3 train (answerable replay + deleted variants) and SQuAD train native no-answer",
               "validation": "v3 validation (copied)"}
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
