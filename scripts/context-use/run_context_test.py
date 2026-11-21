"""Context-use test for the 38M foundation (no SFT): does a passage help it answer?

Three conditions per question: none (question alone), gold (hand-picked passage),
retrieved (top-1 BM25 passage from a pool with confusers).

Readouts, none of them free open-ended generation:
  A. Choice by likelihood (primary). Answerable items: the gold answer against two
     same-type entities that ALSO appear in the passage, so copying any passage word
     does not help. Score = mean log-prob per answer token.
  B. Same choice with the "not stated" option added (4 options). Unanswerable items
     are scored here: correct = "not stated".
  C. PMI-calibrated version of A (log P(opt|ctx,q) - log P(opt|q-free prompt)).
  D. Short greedy answer with stop rules (newline/EOS, no repeated trigram, 20 tokens):
     fixes the loop/no-stop problem at decode time and checks the text.

The protocol (inputs, hashes, primary metric) is written before the model loads.
Usage: python run_context_test.py OUTPUT_DIR [--shots 2]
--shots 2 puts two worked examples (demos.json, same language, with passages) before every
question in every condition; only the target passage differs between conditions.
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
RUN = ROOT / "artifacts/execution-model-runs/text-b4-2026-11-18/stage-3-full"
FINETUNE = "selected"
CHECKPOINT_SHA = "887bb54c58bf93cea2ad04e79b68379d66dd5e40556a0f6d980c4ad6f83ec9fd"
if "--finetune" in sys.argv:
    # A fine-tune folder inside the same run; its own status.json names the selected best checkpoint.
    FINETUNE = sys.argv[sys.argv.index("--finetune") + 1]
    CHECKPOINT_SHA = json.loads((RUN / FINETUNE / "status.json").read_text(encoding="utf-8"))["best_checkpoint_sha256"]
ITEMS = Path(__file__).resolve().parent / "items.json"
TEMPLATE = {
    "en": {"q": "Question: ", "a": "Answer:"},
    "ar": {"q": "سؤال: ", "a": "الجواب:"},
}
GEN_MAX = 20
DEMOS = Path(__file__).resolve().parent / "demos.json"
SHOTS = 2 if "--shots" in sys.argv and sys.argv[sys.argv.index("--shots") + 1] == "2" else 0


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------- text normalisation and BM25 ----------
AR_DIACRITICS = re.compile(r"[ً-ْٰـ]")
EN_STOP = set("the a an of in on at to and is was are for by her his its their who what where which how much does did do time".split())
AR_STOP = set("في من على الى إلى عن ما من أي كم متى أين هو هي التي الذي".split())


def norm(text: str) -> str:
    text = AR_DIACRITICS.sub("", text.lower())
    text = re.sub("[أإآ]", "ا", text).replace("ة", "ه").replace("ى", "ي")
    return re.sub(r"[^\w\s]", " ", text)


def terms(text: str) -> list[str]:
    out = []
    for word in norm(text).split():
        if word in EN_STOP or word in AR_STOP:
            continue
        for prefix in ("وال", "بال", "فال", "كال", "لل", "ال"):
            if word.startswith(prefix) and len(word) - len(prefix) >= 2:
                word = word[len(prefix):]
                break
        else:
            if word.startswith("و") and len(word) > 3:
                word = word[1:]
        out.append(word)
    return out


class BM25:
    def __init__(self, docs: list[str], k1: float = 1.5, b: float = 0.75):
        self.docs = [terms(d) for d in docs]
        self.avg = sum(map(len, self.docs)) / len(self.docs)
        df = Counter(t for d in self.docs for t in set(d))
        n = len(self.docs)
        self.idf = {t: math.log(1 + (n - c + 0.5) / (c + 0.5)) for t, c in df.items()}
        self.k1, self.b = k1, b

    def rank(self, query: str) -> list[tuple[int, float]]:
        q = terms(query)
        scores = []
        for i, d in enumerate(self.docs):
            tf = Counter(d)
            s = 0.0
            for t in q:
                if t in tf:
                    f = tf[t]
                    s += self.idf[t] * f * (self.k1 + 1) / (f + self.k1 * (1 - self.b + self.b * len(d) / self.avg))
            scores.append((i, s))
        return sorted(scores, key=lambda x: -x[1])


# ---------- prompts ----------
def demo_block(language: str) -> str:
    if not SHOTS:
        return ""
    t = TEMPLATE[language]
    demos = json.loads(DEMOS.read_text(encoding="utf-8"))[language][:SHOTS]
    return "".join(f"{d['passage']}\n\n{t['q']}{d['question']}\n{t['a']} {d['answer']}\n\n" for d in demos)


def prefix(item: dict, passage: str | None) -> str:
    t = TEMPLATE[item["language"]]
    body = f"{t['q']}{item['question']}\n{t['a']}"
    return demo_block(item["language"]) + (f"{passage}\n\n{body}" if passage else body)


def null_prefix(item: dict) -> str:
    return TEMPLATE[item["language"]]["a"]


# ---------- model ----------
class Scorer:
    def __init__(self):
        sys.path[:0] = [str(ROOT / "packages/execution-model"), str(ROOT / "packages/execution-pipeline")]
        import torch
        from execution_pipeline.ads_worker import AdsWorker
        self.torch = torch
        self.w = AdsWorker(RUN, "cuda", FINETUNE, CHECKPOINT_SHA)
        if self.w.hint is not None:
            raise ValueError("Expected a raw foundation with no prompt hint.")
        self.eos = self.w.tokenizer.eos_token_id
        self.split_mismatch = 0

    def encode_pair(self, pre: str, cont: str) -> tuple[list[int], int]:
        enc = self.w.encoder.encode
        p, full = enc(pre), enc(pre + cont)
        if full[:len(p)] != p:
            self.split_mismatch += 1
            full = p + enc(cont)
        return full, len(p)

    def logits(self, ids: list[int]):
        torch = self.torch
        x = torch.tensor([ids], device="cuda")
        with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
            out = self.w.model(x).logits
        return out[0].float()

    def logprob(self, pre: str, cont: str) -> tuple[float, int]:
        ids, n = self.encode_pair(pre, cont)
        if len(ids) > self.w.config.max_context_length:
            raise ValueError("prompt exceeds context")
        lp = self.torch.log_softmax(self.logits(ids), dim=-1)
        target = self.torch.tensor(ids[n:], device="cuda")
        picked = lp[n - 1:len(ids) - 1].gather(1, target[:, None]).squeeze(1)
        return float(picked.sum()), len(ids) - n

    def greedy(self, pre: str, banned_first: frozenset[int] = frozenset()) -> dict:
        """banned_first: token ids blocked at the first step only (used to force an answer span)."""
        ids = self.w.encoder.encode(pre)
        start = len(ids)
        stop = "length"
        for _ in range(GEN_MAX):
            row = self.logits(ids)[-1]
            seen = set()
            if len(ids) - start >= 2:
                a, b = ids[-2], ids[-1]
                gen = ids[start:]
                for i in range(len(gen) - 2):
                    if gen[i] == a and gen[i + 1] == b:
                        seen.add(gen[i + 2])
            for t in seen | (set(banned_first) if len(ids) == start else set()):
                row[t] = -float("inf")
            nxt = int(row.argmax())
            if nxt == self.eos:
                stop = "eos"
                break
            ids.append(nxt)
            text = self.w.tokenizer.decode_bytes(ids[start:]).decode("utf-8", "replace")
            if "\n" in text.strip(" ") and text.strip():
                stop = "newline"
                break
        text = self.w.tokenizer.decode_bytes(ids[start:]).decode("utf-8", "replace")
        return {"text": text.split("\n")[0].strip() if text.strip() else text, "raw": text, "stop": stop}


# ---------- statistics ----------
def mcnemar(a: list[bool], b: list[bool]) -> dict:
    b_only = sum(1 for x, y in zip(a, b) if y and not x)
    a_only = sum(1 for x, y in zip(a, b) if x and not y)
    n = a_only + b_only
    if n == 0:
        return {"b_only": 0, "a_only": 0, "p_two_sided": 1.0}
    k = min(a_only, b_only)
    p = min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n)
    return {"b_only": b_only, "a_only": a_only, "p_two_sided": round(p, 5)}


def contains(hay: str, needle: str) -> bool:
    return " ".join(terms(needle)) in " ".join(terms(hay))


def main() -> int:
    out = Path(sys.argv[1]).resolve()
    out.mkdir(parents=True, exist_ok=False)
    data = json.loads(ITEMS.read_text(encoding="utf-8"))
    items = data["items"]
    pool = [(i["id"], i["passage"]) for i in items] + [(d["id"], d["passage"]) for d in data["retrieval_distractors"]]
    protocol = {
        "task": "context_use_test", "prepared_at": now(),
        "checkpoint": {"path": str(RUN / FINETUNE / "best.pt"), "sha256": CHECKPOINT_SHA},
        "items": {"path": str(ITEMS), "sha256": sha256(ITEMS), "answerable": sum(i["answerable"] for i in items),
                  "unanswerable": sum(not i["answerable"] for i in items), "retrieval_pool": len(pool)},
        "script": {"path": str(Path(__file__).resolve()), "sha256": sha256(Path(__file__).resolve())},
        "conditions": ["none", "gold", "retrieved"],
        "shots": SHOTS, "demos": {"path": str(DEMOS), "sha256": sha256(DEMOS)} if SHOTS else None,
        "primary": "answerable items, 3-way choice (gold vs two in-passage entities), mean log-prob per token; compare gold vs none (exact McNemar)",
        "secondary": ["4-way with not-stated (incl. unanswerable)", "PMI 3-way", "greedy with stop rules"],
        "retriever": "BM25 k1=1.5 b=0.75 over all 32 passages, both languages, light Arabic prefix stripping",
        "templates": TEMPLATE, "greedy": {"max_new_tokens": GEN_MAX, "stop": ["eos", "newline"], "no_repeat_ngram": 3},
        "thresholds": "none fixed by Claude; the owner decides what counts as enough",
    }
    (out / "protocol.json").write_text(json.dumps(protocol, ensure_ascii=False, indent=2), encoding="utf-8")

    bm25 = BM25([p for _, p in pool])
    t0 = time.perf_counter()
    scorer = Scorer()
    load_s = time.perf_counter() - t0
    rows = []
    for item in items:
        ranked = bm25.rank(item["question"])
        top_id = pool[ranked[0][0]][0]
        passages = {"none": None, "gold": item["passage"], "retrieved": pool[ranked[0][0]][1]}
        lang = item["language"]
        options = ([item["answer"]] if item["answerable"] else []) + item["distractors"] + [data["not_stated"][lang]]
        gold = item["answer"] if item["answerable"] else data["not_stated"][lang]
        null = {o: scorer.logprob(null_prefix(item), " " + o) for o in options}
        row = {"id": item["id"], "language": lang, "answerable": item["answerable"], "gold": gold,
               "retrieved_id": top_id, "retrieval_hit": top_id == item["id"],
               "retrieval_top3": [pool[i][0] for i, _ in ranked[:3]], "conditions": {}}
        for cond, passage in passages.items():
            pre = prefix(item, passage)
            scores = {}
            for o in options:
                s, n = scorer.logprob(pre, " " + o)
                scores[o] = {"sum": round(s, 4), "tokens": n, "mean": round(s / n, 4),
                             "pmi": round(s - null[o][0], 4)}
            entity_opts = [o for o in options if o != data["not_stated"][lang]]
            pick3 = max(entity_opts, key=lambda o: scores[o]["mean"])
            pick3_pmi = max(entity_opts, key=lambda o: scores[o]["pmi"])
            pick4 = max(options, key=lambda o: scores[o]["mean"])
            gen = scorer.greedy(pre)
            mentioned = [o for o in entity_opts if contains(gen["text"], o)]
            row["conditions"][cond] = {
                "scores": scores, "pick3": pick3, "pick3_pmi": pick3_pmi, "pick4": pick4,
                "correct3": item["answerable"] and pick3 == gold,
                "correct3_pmi": item["answerable"] and pick3_pmi == gold,
                "correct4": pick4 == gold,
                "generation": gen, "gen_mentions": mentioned,
                "gen_correct": item["answerable"] and mentioned == [gold],
            }
        rows.append(row)
        print(item["id"], {c: (v["pick3"], v["generation"]["text"][:40]) for c, v in row["conditions"].items()}, flush=True)

    with (out / "items.jsonl").open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    def acc(key: str, cond: str, sel) -> dict:
        chosen = [r for r in rows if sel(r)]
        k = sum(r["conditions"][cond][key] for r in chosen)
        return {"correct": k, "of": len(chosen)}

    ans = lambda r: r["answerable"]
    summary = {"completed_at": now(), "load_seconds": round(load_s, 2),
               "elapsed_seconds": round(time.perf_counter() - t0, 2),
               "tokenizer_split_mismatch": scorer.split_mismatch,
               "retrieval_top1_hit": {"correct": sum(r["retrieval_hit"] for r in rows), "of": len(rows)},
               "results": {}}
    for cond in protocol["conditions"]:
        summary["results"][cond] = {
            "A_3way_mean": {"all": acc("correct3", cond, ans),
                            "en": acc("correct3", cond, lambda r: ans(r) and r["language"] == "en"),
                            "ar": acc("correct3", cond, lambda r: ans(r) and r["language"] == "ar")},
            "C_3way_pmi": acc("correct3_pmi", cond, ans),
            "B_4way_answerable": acc("correct4", cond, ans),
            "B_4way_unanswerable_says_not_stated": acc("correct4", cond, lambda r: not ans(r)),
            "D_greedy_answerable_correct": acc("gen_correct", cond, ans),
            "D_greedy_stop": dict(Counter(r["conditions"][cond]["generation"]["stop"] for r in rows)),
        }
    vec = lambda cond, key="correct3": [r["conditions"][cond][key] for r in rows if ans(r)]
    summary["tests"] = {"A_gold_vs_none": mcnemar(vec("none"), vec("gold")),
                        "A_retrieved_vs_none": mcnemar(vec("none"), vec("retrieved")),
                        "A_gold_vs_retrieved": mcnemar(vec("retrieved"), vec("gold")),
                        "C_gold_vs_none": mcnemar(vec("none", "correct3_pmi"), vec("gold", "correct3_pmi"))}
    summary["chance"] = {"A_3way": "1/3", "B_4way": "1/4"}
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
