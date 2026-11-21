"""Passage mode for file search: show the top-k retrieved passages with file:lines, or "nothing found" when
the top BM25 score is below a per-language threshold. No reader. Uses results.jsonl from file_search.py run.

  python -I file_search_passage.py overlap DIR               question-word overlap with the gold chunk
  python -I file_search_passage.py fit DEV_DIR               choose thresholds on DEV (best balanced) -> thresholds.json
  python -I file_search_passage.py score DIR THRESHOLDS_JSON score passage mode with frozen thresholds
"""
from __future__ import annotations

import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.stdout.reconfigure(encoding="utf-8")


def load(d: Path):
    qs = {q["qid"]: q for q in json.loads((d / "questions.json").read_text(encoding="utf-8"))}
    res = [json.loads(l) for l in (d / "results.jsonl").read_text(encoding="utf-8").splitlines()] if (d / "results.jsonl").exists() else []
    chunks = {c["id"]: c for c in map(json.loads, (d / "chunks.jsonl").read_text(encoding="utf-8").splitlines())}
    return qs, res, chunks


def contains(chunk: dict, q: dict) -> bool:
    import eval_reading_v2 as ev
    lang = q["language"]
    text = " ".join(ev.norm(chunk["text"], lang))
    return any(" ".join(ev.norm(a, lang)) in text for a in [q["answer"]] + q.get("alt", []) if a)


def top(r) -> float:
    return r["candidates"][0]["bm25"] if r["candidates"] else 0.0


def evaluate(qs, res, chunks, thr: dict, k: int) -> dict:
    out = {}
    for lang in ("ar", "en", "all"):
        rr = [r for r in res if lang == "all" or qs[r["qid"]]["language"] == lang]
        pos = [r for r in rr if qs[r["qid"]]["answer"]]
        neg = [r for r in rr if not qs[r["qid"]]["answer"]]
        shown = lambda r: top(r) >= thr[qs[r["qid"]]["language"]]  # noqa: E731
        hit = lambda r: any(contains(chunks[c["chunk"]], qs[r["qid"]]) for c in r["candidates"][:k])  # noqa: E731
        o = {"n_answerable": len(pos), "n_unanswerable": len(neg)}
        if pos:
            o[f"answer_in_top{k}_any_threshold_pct"] = round(100 * sum(hit(r) for r in pos) / len(pos), 1)
            o["useful_shown_pct"] = round(100 * sum(shown(r) and hit(r) for r in pos) / len(pos), 1)
            o["shown_without_answer_pct"] = round(100 * sum(shown(r) and not hit(r) for r in pos) / len(pos), 1)
            o["said_nothing_found_pct"] = round(100 * sum(not shown(r) for r in pos) / len(pos), 1)
        if neg:
            o["unanswerable_nothing_found_pct"] = round(100 * sum(not shown(r) for r in neg) / len(neg), 1)
        out[lang] = o
    return out


def overlap(d: Path) -> int:
    import run_context_test as rc
    qs, _, chunks = load(d)
    vals = {"ar": [], "en": []}
    for q in qs.values():
        if q["answer"]:
            t = set(rc.terms(q["question"]))
            c = set(rc.terms(chunks[q["chunk"]]["text"]))
            vals[q["language"]].append(len(t & c) / max(len(t), 1))
    res = {l: round(100 * sum(v) / len(v), 1) for l, v in vals.items()}
    print(json.dumps({"mean_question_terms_in_gold_chunk_pct": res}))
    (d / "overlap.json").write_text(json.dumps(res), encoding="utf-8")
    return 0


def fit(d: Path) -> int:
    qs, res, chunks = load(d)
    thr = {}
    for lang in ("ar", "en"):
        rr = [r for r in res if qs[r["qid"]]["language"] == lang]
        best = None
        for t in sorted({top(r) for r in rr}) + [1e9]:
            e = evaluate(qs, rr, chunks, {lang: t}, 3)[lang]
            s = 0.5 * e["useful_shown_pct"] + 0.5 * e["unanswerable_nothing_found_pct"]
            if best is None or s > best[1]:
                best = (t, s)
        thr[lang] = best[0]
    (d / "passage_thresholds.json").write_text(json.dumps({"thresholds": thr, "chosen_on": str(d), "k": 3}, indent=2), encoding="utf-8")
    print(json.dumps(thr))
    return 0


def score(d: Path, thr_path: Path) -> int:
    qs, res, chunks = load(d)
    thr = json.loads(thr_path.read_text(encoding="utf-8"))["thresholds"]
    rep = {f"top{k}": evaluate(qs, res, chunks, thr, k) for k in (1, 3)}
    (d / "passage_scores.json").write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(rep, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    mode, d = sys.argv[1], Path(sys.argv[2]).resolve()
    if mode == "score":
        raise SystemExit(score(d, Path(sys.argv[3]).resolve()))
    raise SystemExit({"overlap": overlap, "fit": fit}[mode](d))
