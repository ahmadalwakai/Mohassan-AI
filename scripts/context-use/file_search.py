"""File search with source: BM25 over chunks of local files + the frozen reader (reading-v3-last) +
the frozen abstain verifier. Returns an answer, the supporting chunk and its file:lines, or "not stated".
Local experiment only (2026-11-21): no app, no database.

Usage (.venv-execution):
  python -I file_search.py chunks OUT_DIR [--root docs]           chunk the files -> chunks.jsonl
  python -I file_search.py sample OUT_DIR --n-ar 35 --n-en 15      seeded random chunks to write questions from
  python -I file_search.py run OUT_DIR --finetune reading-v3-last  answer questions.json (frozen protocol first)
  python -I file_search.py score OUT_DIR
  python -I file_search.py ask OUT_DIR "question" --finetune reading-v3-last
"""
from __future__ import annotations

from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import random
import re
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.stdout.reconfigure(encoding="utf-8")
ARG = lambda k, d=None: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d  # noqa: E731
CHUNK_CHARS = 700
TOP_K = 3
VERIFIER = ROOT / "artifacts/abstain-verifier-20261120/verifier.json"
NOT = {"en": "Not stated in the text", "ar": "غير مذكور في النص"}
Q = {"en": "Question: ", "ar": "سؤال: "}
A = {"en": "Answer:", "ar": "الجواب:"}


def sha(t: str) -> str:
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


def lang_of(text: str) -> str:
    ar = len(re.findall(r"[؀-ۿ]", text))
    la = len(re.findall(r"[A-Za-z]", text))
    return "ar" if ar >= la else "en"


def clean(line: str) -> str:
    line = re.sub(r"^\s{0,3}(#{1,6}|[-*+]|\d+[.)])\s+", "", line)   # heading / list markers
    line = re.sub(r"[*_`]{1,3}", "", line)                           # emphasis / code ticks
    line = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", line)             # links -> text
    return line.strip()


def chunk_file(path: Path, rel: str) -> list[dict]:
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    out, buf, start, fence = [], [], None, False

    def flush(end: int):
        nonlocal buf, start
        text = " ".join(t for t in buf if t)
        if len(text) >= 60:
            out.append({"id": sha(f"{rel}:{start}")[:12], "file": rel, "line_start": start, "line_end": end,
                        "language": lang_of(text), "text": text})
        buf, start = [], None

    for i, raw in enumerate(lines, 1):
        if raw.strip().startswith("```"):
            fence = not fence
            continue
        if fence or set(raw.strip()) <= set("|-: "):
            continue
        t = clean(raw.replace("|", " "))
        heading = raw.lstrip().startswith("#")
        if heading and buf:
            flush(i - 1)
        if not t:
            if sum(len(x) for x in buf) >= CHUNK_CHARS // 2:
                flush(i - 1)
            continue
        if start is None:
            start = i
        buf.append(t)
        if sum(len(x) for x in buf) >= CHUNK_CHARS:
            flush(i)
    if buf:
        flush(len(lines))
    return out


def chunks(out: Path) -> int:
    out.mkdir(parents=True, exist_ok=True)
    root = ROOT / ARG("--root", "docs")
    import make_reading_data_v2 as mk  # tokenizer
    rows = []
    for p in sorted(root.rglob("*.md")):
        for c in chunk_file(p, p.relative_to(ROOT).as_posix()):
            # Long single lines (tables) can exceed the reader's passage budget: split on words, <= 340 tokens.
            if mk.ntok(c["text"]) <= 340:
                rows.append(c)
                continue
            words, piece, part = c["text"].split(), [], 0
            for w in words:
                if piece and mk.ntok(" ".join(piece + [w])) > 340:
                    rows.append(dict(c, id=c["id"] if part == 0 else f"{c['id']}-{part}", text=" ".join(piece)))
                    piece, part = [], part + 1
                piece.append(w)
            if piece:
                rows.append(dict(c, id=c["id"] if part == 0 else f"{c['id']}-{part}", text=" ".join(piece)))
    text = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)
    (out / "chunks.jsonl").write_text(text, encoding="utf-8")
    info = {"files": len({r["file"] for r in rows}), "chunks": len(rows), "by_language": Counter(r["language"] for r in rows),
            "chunks_sha256": sha(text)}
    (out / "chunks_info.json").write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(info, ensure_ascii=False))
    return 0


def sample(out: Path) -> int:
    rows = [json.loads(l) for l in (out / "chunks.jsonl").read_text(encoding="utf-8").splitlines()]
    rng = random.Random(20261121)
    picked = []
    for lang, n in (("ar", int(ARG("--n-ar", "35"))), ("en", int(ARG("--n-en", "15")))):
        pool = [r for r in rows if r["language"] == lang and len(r["text"]) >= 200]
        picked += rng.sample(pool, n)
    (out / "sample.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in picked), encoding="utf-8")
    for r in picked:
        print(f"[{r['id']}] {r['file']}:{r['line_start']}-{r['line_end']} ({r['language']})\n{r['text']}\n")
    return 0


# ---------------- retrieval ----------------
class BM25:
    def __init__(self, docs: list[dict]):
        import run_context_test as rc
        self.terms = rc.terms
        self.docs = docs
        self.tf = [Counter(self.terms(d["file"].rsplit("/", 1)[-1].replace("-", " ") + " " + d["text"])) for d in docs]
        self.len = [sum(t.values()) for t in self.tf]
        self.avg = sum(self.len) / len(self.len)
        df = Counter(w for t in self.tf for w in t)
        n = len(docs)
        self.idf = {w: math.log(1 + (n - c + 0.5) / (c + 0.5)) for w, c in df.items()}

    def search(self, query: str, k: int) -> list[tuple[float, dict]]:
        q = self.terms(query)
        scores = []
        for i, tf in enumerate(self.tf):
            s = 0.0
            for w in q:
                f = tf.get(w, 0)
                if f:
                    s += self.idf[w] * f * 2.2 / (f + 1.2 * (0.25 + 0.75 * self.len[i] / self.avg))
            scores.append((s, i))
        scores.sort(reverse=True)
        return [(round(s, 3), self.docs[i]) for s, i in scores[:k] if s > 0]


# ---------------- reader ----------------
class Reader:
    def __init__(self):
        import run_context_test as rc
        import eval_reading_v2 as ev
        import abstain_verifier as av
        rc.GEN_MAX = 48
        self.av, self.ev = av, ev
        self.scorer = rc.Scorer()
        enc = self.scorer.w.encoder.encode
        self.not_firsts = {enc(" " + ev.NOT[l])[0] for l in ev.NOT}
        self.banned = frozenset(self.not_firsts | {self.scorer.eos})
        self.verifier = json.loads(VERIFIER.read_text(encoding="utf-8"))
        self.checkpoint = rc.CHECKPOINT_SHA

    def read(self, question: str, chunk: dict, lang: str) -> dict:
        prompt = f"{chunk['text']}\n\n{Q[lang]}{' '.join(question.split())}\n{A[lang]}"
        r = {"id": chunk["id"], "language": lang, "prompt": prompt}
        s = self.av.signals(self.scorer, r, self.not_firsts, self.banned)
        p = self.av.predict(self.verifier["model"], [self.av.featurize(r, s)])[0]
        return {"span": s["span"], "verifier_p": round(p, 4), "margin": s["margin"]}


def answer(bm: BM25, reader: Reader, question: str) -> dict:
    lang = lang_of(question)
    hits = bm.search(question, TOP_K)
    reads = []
    for score, ch in hits:
        rd = reader.read(question, ch, lang)
        reads.append({"chunk": ch["id"], "file": ch["file"], "lines": [ch["line_start"], ch["line_end"]], "bm25": score, **rd})
    thr = reader.verifier["thresholds"][lang]["threshold"]
    best = max(reads, key=lambda x: x["verifier_p"], default=None)
    if not best or best["verifier_p"] < thr:
        return {"language": lang, "answer": NOT[lang], "abstained": True, "source": None, "candidates": reads}
    ch = next(c for _, c in hits if c["id"] == best["chunk"])
    return {"language": lang, "answer": best["span"], "abstained": False,
            "source": {"file": ch["file"], "lines": [ch["line_start"], ch["line_end"]], "chunk": ch["id"], "passage": ch["text"]},
            "candidates": reads}


def load_chunks(out: Path) -> list[dict]:
    return [json.loads(l) for l in (out / "chunks.jsonl").read_text(encoding="utf-8").splitlines()]


def run(out: Path) -> int:
    qs = json.loads((out / "questions.json").read_text(encoding="utf-8"))
    docs = load_chunks(out)
    protocol = {"questions_sha256": sha((out / "questions.json").read_text(encoding="utf-8")),
                "chunks_sha256": sha((out / "chunks.jsonl").read_text(encoding="utf-8")),
                "verifier_sha256": sha(VERIFIER.read_text(encoding="utf-8")), "top_k": TOP_K, "chunk_chars": CHUNK_CHARS,
                "frozen": "no change to retrieval, reader, verifier or thresholds after this point"}
    (out / "protocol.json").write_text(json.dumps(protocol, indent=2), encoding="utf-8")
    bm, reader = BM25(docs), Reader()
    protocol["checkpoint_sha256"] = reader.checkpoint
    (out / "protocol.json").write_text(json.dumps(protocol, indent=2), encoding="utf-8")
    res = []
    for q in qs:
        a = answer(bm, reader, q["question"])
        gold_chunk = next((c for c in docs if c["id"] == q.get("chunk")), None)
        gold_read = reader.read(q["question"], gold_chunk, a["language"]) if gold_chunk else None
        res.append({"qid": q["qid"], **a, "gold_chunk_read": gold_read})
        print(q["qid"], a["answer"][:60], a["source"]["file"] if a["source"] else "-", flush=True)
    (out / "results.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in res), encoding="utf-8")
    return 0


def score(out: Path) -> int:
    import eval_reading_v2 as ev
    qs = {q["qid"]: q for q in json.loads((out / "questions.json").read_text(encoding="utf-8"))}
    res = [json.loads(l) for l in (out / "results.jsonl").read_text(encoding="utf-8").splitlines()]
    docs = {c["id"]: c for c in load_chunks(out)}
    rep = {}
    for lang in ("ar", "en", "all"):
        rr = [r for r in res if lang == "all" or qs[r["qid"]]["language"] == lang]
        pos = [r for r in rr if qs[r["qid"]]["answer"]]
        neg = [r for r in rr if not qs[r["qid"]]["answer"]]

        def f1(span, q):
            return max(ev.f1(ev.norm(span, q["language"]), ev.norm(a, q["language"])) for a, in [(x,) for x in [q["answer"]] + q.get("alt", [])])

        def has(chunk_id, q):
            return chunk_id in docs and any(ev.norm(a, q["language"]) and " ".join(ev.norm(a, q["language"])) in " ".join(ev.norm(docs[chunk_id]["text"], q["language"]))
                                            for a in [q["answer"]] + q.get("alt", []))
        k = {"n_answerable": len(pos), "n_unanswerable": len(neg)}
        if pos:
            k["retrieval_hit_at_1_pct"] = round(100 * sum(bool(r["candidates"]) and has(r["candidates"][0]["chunk"], qs[r["qid"]]) for r in pos) / len(pos), 1)
            k["retrieval_hit_at_3_pct"] = round(100 * sum(any(has(c["chunk"], qs[r["qid"]]) for c in r["candidates"]) for r in pos) / len(pos), 1)
            k["reader_on_gold_chunk_f1"] = round(100 * sum(f1(r["gold_chunk_read"]["span"], qs[r["qid"]]) for r in pos if r["gold_chunk_read"]) / len(pos), 1)
            k["reader_on_gold_chunk_em_pct"] = round(100 * sum(f1(r["gold_chunk_read"]["span"], qs[r["qid"]]) == 1 for r in pos if r["gold_chunk_read"]) / len(pos), 1)
            k["end_to_end_f1"] = round(100 * sum(0 if r["abstained"] else f1(r["answer"], qs[r["qid"]]) for r in pos) / len(pos), 1)
            k["end_to_end_correct_pct"] = round(100 * sum((not r["abstained"]) and f1(r["answer"], qs[r["qid"]]) >= 0.5 for r in pos) / len(pos), 1)
            k["answered_pct"] = round(100 * sum(not r["abstained"] for r in pos) / len(pos), 1)
            ans = [r for r in pos if not r["abstained"]]
            k["cited_source_contains_answer_pct_of_answered"] = round(100 * sum(has(r["source"]["chunk"], qs[r["qid"]]) for r in ans) / max(len(ans), 1), 1)
            k["wrong_answers_shown_pct"] = round(100 * sum((not r["abstained"]) and f1(r["answer"], qs[r["qid"]]) < 0.5 for r in pos) / len(pos), 1)
        if neg:
            k["unanswerable_refused_pct"] = round(100 * sum(r["abstained"] for r in neg) / len(neg), 1)
        rep[lang] = k
    (out / "scores.json").write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(rep, ensure_ascii=False, indent=2))
    return 0


def ask(out: Path) -> int:
    question = sys.argv[3]
    a = answer(BM25(load_chunks(out)), Reader(), question)
    print(json.dumps({k: v for k, v in a.items() if k != "candidates"}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    mode, target = sys.argv[1], Path(sys.argv[2]).resolve()
    raise SystemExit({"chunks": chunks, "sample": sample, "run": run, "score": score, "ask": ask}[mode](target))
