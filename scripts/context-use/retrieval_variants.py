"""Retrieval variants for file search, no model (2026-11-21). Declared before scoring, no parameter sweeps:
  A  words      BM25 on the existing terms (baseline, file_search.BM25 tokenisation)
  B  stems      BM25 on light-stemmed words (Arabic prefixes/suffixes, English suffixes)
  C  ngrams     BM25 on character 3-5 grams of normalised words
  D  fused      reciprocal rank fusion of B and C (k = 60)
Metric: answer string inside the top-1 / top-3 chunks (answerable questions only), and the AUC of the top
score between answerable and unanswerable questions.
Usage: python -I retrieval_variants.py score QUESTIONS_DIR [QUESTIONS_DIR ...]   (each dir has questions.json; chunks from --chunks)
"""
from __future__ import annotations

from collections import Counter
import json
import math
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.stdout.reconfigure(encoding="utf-8")
ROOT = HERE.parents[1]
CHUNKS = ROOT / "artifacts/file-search-20261121/chunks.jsonl"
DIAC = re.compile(r"[ً-ْٰـ]")
AR_PRE = ("وال", "بال", "كال", "فال", "لل", "ال", "و", "ف", "ب", "ك", "ل", "س")
AR_SUF = ("تهما", "كما", "هما", "ات", "ان", "ون", "ين", "يه", "ها", "هم", "كم", "نا", "ته", "تي", "ه", "ي")
STOP = set("the a an of in on at to and is was are for by with from what which who how many much does did do this that be "
           "في من على الى إلى عن ما ماذا متى أين اين كم كيف هل هو هي التي الذي أي اي مع او أو ثم قد لا لم".split())


def norm(text: str) -> list[str]:
    text = DIAC.sub("", text.lower())
    text = re.sub("[أإآ]", "ا", text).replace("ة", "ه").replace("ى", "ي")
    return [w for w in re.sub(r"[^\w\s]", " ", text).split() if w not in STOP]


def stem(w: str) -> str:
    if re.fullmatch(r"[a-z]+", w):
        for s in ("ing", "edly", "ed", "es", "ly", "s"):
            if w.endswith(s) and len(w) - len(s) >= 3:
                return w[: -len(s)]
        return w
    if re.search(r"[؀-ۿ]", w):
        for p in AR_PRE:
            if w.startswith(p) and len(w) - len(p) >= 3:
                w = w[len(p):]
                break
        for s in AR_SUF:
            if w.endswith(s) and len(w) - len(s) >= 3:
                w = w[: -len(s)]
                break
    return w


def grams(w: str) -> list[str]:
    w = stem(w)
    if len(w) <= 3:
        return [f"#{w}#"]
    x = f"#{w}#"
    return [x[i:i + n] for n in (3, 4, 5) for i in range(len(x) - n + 1)]


class BM25:
    def __init__(self, docs: list[list[str]]):
        self.tf = [Counter(d) for d in docs]
        self.len = [len(d) or 1 for d in docs]
        self.avg = sum(self.len) / len(self.len)
        df = Counter(w for t in self.tf for w in t)
        n = len(docs)
        self.idf = {w: math.log(1 + (n - c + 0.5) / (c + 0.5)) for w, c in df.items()}

    def scores(self, q: list[str]) -> list[float]:
        out = []
        for i, tf in enumerate(self.tf):
            s = 0.0
            for w in q:
                f = tf.get(w, 0)
                if f:
                    s += self.idf[w] * f * 2.2 / (f + 1.2 * (0.25 + 0.75 * self.len[i] / self.avg))
            out.append(s)
        return out


def doc_text(c: dict) -> str:
    return c["file"].rsplit("/", 1)[-1].replace("-", " ") + " " + c["text"]


class Variants:
    def __init__(self, chunks: list[dict]):
        import run_context_test as rc
        self.rc = rc
        self.chunks = chunks
        self.A = BM25([rc.terms(doc_text(c)) for c in chunks])
        self.B = BM25([[stem(w) for w in norm(doc_text(c))] for c in chunks])
        self.C = BM25([[g for w in norm(doc_text(c)) for g in grams(w)] for c in chunks])

    def rank(self, name: str, q: str) -> list[tuple[float, int]]:
        if name == "A":
            s = self.A.scores(self.rc.terms(q))
        elif name == "B":
            s = self.B.scores([stem(w) for w in norm(q)])
        elif name == "C":
            s = self.C.scores([g for w in norm(q) for g in grams(w)])
        else:
            rb, rc_ = self.rank("B", q), self.rank("C", q)
            fused = Counter()
            for r in (rb, rc_):
                for pos, (_, i) in enumerate(r):
                    fused[i] += 1 / (60 + pos + 1)
            return sorted(((v, i) for i, v in fused.items()), reverse=True)
        return sorted(((v, i) for i, v in enumerate(s) if v > 0), reverse=True)


def contains(chunk: dict, q: dict) -> bool:
    import eval_reading_v2 as ev
    lang = q["language"]
    text = " ".join(ev.norm(chunk["text"], lang))
    return any(" ".join(ev.norm(a, lang)) in text for a in [q["answer"]] + q.get("alt", []) if a)


def main() -> int:
    import abstain_verifier as av
    chunks = [json.loads(l) for l in Path(sys.argv[sys.argv.index("--chunks") + 1] if "--chunks" in sys.argv else CHUNKS)
              .read_text(encoding="utf-8").splitlines()]
    v = Variants(chunks)
    dirs = [Path(a).resolve() for a in sys.argv[2:] if not a.startswith("--") and a.endswith(("paraphrased", "21", "heldout"))]
    report = {}
    for d in dirs:
        qs = json.loads((d / "questions.json").read_text(encoding="utf-8"))
        report[d.name] = {}
        for name in "ABCD":
            r = {}
            for lang in ("ar", "en", "all"):
                sel = [q for q in qs if lang == "all" or q["language"] == lang]
                pos = [q for q in sel if q["answer"]]
                ranks = {q["qid"]: v.rank(name, q["question"]) for q in sel}
                h1 = sum(any(contains(chunks[i], q) for _, i in ranks[q["qid"]][:1]) for q in pos)
                h3 = sum(any(contains(chunks[i], q) for _, i in ranks[q["qid"]][:3]) for q in pos)
                tops = [ranks[q["qid"]][0][0] if ranks[q["qid"]] else 0.0 for q in sel]
                r[lang] = {"n": len(pos), "top1_pct": round(100 * h1 / len(pos), 1), "top3_pct": round(100 * h3 / len(pos), 1),
                           "auc_top_score": av.auc(tops, [int(bool(q["answer"])) for q in sel])}
            report[d.name][name] = r
            print(d.name, name, json.dumps(r))
    out = ROOT / "artifacts/file-search-20261121/retrieval_variants.json"
    prev = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {}
    prev.update(report)
    out.write_text(json.dumps(prev, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
