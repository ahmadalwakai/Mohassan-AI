"""Own dense retriever (bi-encoder) from the 38M foundation, 2026-11-21. Owner chose "train our own retriever".

Declared before training (no sweeps):
  base       stage-3-full/selected/best.pt (foundation, no reading fine-tune)
  encoding   final hidden states (after final_norm), mean over tokens, L2-normalised
  inputs     "query: <question>" (<= 64 tokens), "passage: <text>" (<= 256 tokens)
  loss       InfoNCE, temperature 0.05, in-batch negatives + 1 same-article hard negative per pair
  data       answerable rows of reading v5 train (SQuAD, TyDi ar/en, ARCD, Arabic-SQuAD): train articles only
  optimiser  AdamW lr 5e-5, warmup 100, batch 32 questions, 1 epoch over at most 60k pairs, bf16 autocast
  checkpoint the final step (no selection)
Dev (selection not used, sanity only): v3 test splits (TyDi-ar dev, ARCD test, SQuAD dev sample), question -> its
passage among all distinct passages of that split. Test: docs/ original and paraphrased sets, dense alone and
reciprocal-rank fusion with BM25 (variant A), both declared here.

Usage (.venv-execution):
  python -I retriever.py train OUT_DIR [--max-steps N]
  python -I retriever.py dev OUT_DIR [--base]        (--base: untrained foundation, for comparison)
  python -I retriever.py docs OUT_DIR [--base]
"""
from __future__ import annotations

from collections import Counter, defaultdict
import json
import math
from pathlib import Path
import random
import sys
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path[:0] = [str(ROOT / "packages/execution-model"), str(ROOT / "packages/execution-pipeline")]
sys.stdout.reconfigure(encoding="utf-8")
RUN = ROOT / "artifacts/execution-model-runs/text-b4-2026-11-18/stage-3-full"
V5 = ROOT / "artifacts/reading-training/v5"
V3 = ROOT / "artifacts/reading-training/v3"
FS = ROOT / "artifacts/file-search-20261121"
QP = {"en": "\n\nQuestion: ", "ar": "\n\nسؤال: "}
Q_MAX, P_MAX, BATCH, LR, WARMUP, TEMP, MAX_PAIRS = 64, 256, 32, 5e-5, 100, 0.05, 60000
ARG = lambda k, d=None: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d  # noqa: E731


def split_row(r):
    passage, rest = r["prompt"].rsplit(QP[r["language"]], 1)
    return passage, rest.split("\n")[0]


class Encoder:
    def __init__(self, checkpoint: Path | None):
        import torch
        from execution_pipeline.ads_finetune import _load_pretrained
        from execution_pipeline.pretrain import TextEncoder
        import torch.utils.checkpoint  # noqa: F401
        self.torch = torch
        self.model, _, self.config = _load_pretrained(RUN, "cuda", Path("selected/best.pt"))
        if checkpoint is not None:
            self.model.load_state_dict(torch.load(checkpoint, map_location="cuda", weights_only=True), strict=True)
        self.enc = TextEncoder(RUN)

    def ids(self, texts: list[str], prefix: str, limit: int):
        torch = self.torch
        rows = [self.enc.encode(prefix + t)[:limit] for t in texts]
        width = max(map(len, rows))
        x = torch.zeros((len(rows), width), dtype=torch.long)
        m = torch.zeros((len(rows), width), dtype=torch.bool)
        for i, r in enumerate(rows):
            x[i, :len(r)] = torch.tensor(r)
            m[i, :len(r)] = True
        return x.cuda(), m.cuda()

    def embed(self, texts: list[str], prefix: str, limit: int):
        torch, mdl = self.torch, self.model
        x, valid = self.ids(texts, prefix, limit)
        pos = (valid.long().cumsum(-1) - 1).clamp_min(0)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            h = mdl.token_embedding(x).masked_fill(~valid.unsqueeze(-1), 0.0)
            for b in mdl.blocks:
                if mdl.training:  # activation checkpointing: batch 32 + hard negatives must fit in 4 GB
                    h = torch.utils.checkpoint.checkpoint(b, h, valid, pos, use_reentrant=False)
                else:
                    h = b(h, valid, pos)
            h = mdl.final_norm(h)
        h = h.float().masked_fill(~valid.unsqueeze(-1), 0.0).sum(1) / valid.sum(1, keepdim=True)
        return torch.nn.functional.normalize(h, dim=-1)

    def embed_many(self, texts, prefix, limit, bs=32):
        torch = self.torch
        out = []
        with torch.no_grad():
            for i in range(0, len(texts), bs):
                out.append(self.embed(texts[i:i + bs], prefix, limit))
        return torch.cat(out)


def pairs() -> list[dict]:
    rows = [json.loads(l) for l in (V5 / "train.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    by_title = defaultdict(set)
    out = []
    for r in rows:
        if r["kind"] != "answerable":
            continue
        p, q = split_row(r)
        by_title[(r["source"], r["title"])].add(p)
        out.append({"q": q, "p": p, "a": r["answer"], "key": (r["source"], r["title"]), "lang": r["language"]})
    rng = random.Random(20261125)
    for x in out:
        cands = [p for p in by_title[x["key"]] if p != x["p"] and x["a"] not in p]
        x["neg"] = rng.choice(sorted(cands)) if cands else None
    rng.shuffle(out)
    return out[:MAX_PAIRS]


def train(out: Path) -> int:
    torch = __import__("torch")
    out.mkdir(parents=True, exist_ok=False)
    random.seed(5)
    torch.manual_seed(5)
    data = pairs()
    enc = Encoder(None)
    model = enc.model
    model.train()
    opt = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=0.01)
    batches, cur, seen = [], [], set()
    for x in data:  # no duplicate passage inside a batch (they would be false negatives)
        if x["p"] in seen or (x["neg"] and x["neg"] in seen):
            continue
        cur.append(x)
        seen |= {x["p"]} | ({x["neg"]} if x["neg"] else set())
        if len(cur) == BATCH:
            batches.append(cur)
            cur, seen = [], set()
    steps = min(len(batches), int(ARG("--max-steps", len(batches))))
    sched = lambda s: min(1.0, (s + 1) / WARMUP) * max(0.0, 1 - s / steps)  # noqa: E731
    log = (out / "log.jsonl").open("w", encoding="utf-8")
    started, run_loss = time.perf_counter(), 0.0
    for step, b in enumerate(batches[:steps]):
        for g in opt.param_groups:
            g["lr"] = LR * sched(step)
        qv = enc.embed([x["q"] for x in b], "query: ", Q_MAX)
        passages = [x["p"] for x in b] + [x["neg"] for x in b if x["neg"]]
        pv = enc.embed(passages, "passage: ", P_MAX)
        logits = qv @ pv.T / TEMP
        loss = torch.nn.functional.cross_entropy(logits, torch.arange(len(b), device="cuda"))
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        run_loss += float(loss.detach())
        if (step + 1) % 100 == 0 or step + 1 == steps:
            rec = {"step": step + 1, "loss": round(run_loss / ((step % 100) + 1), 4), "minutes": round((time.perf_counter() - started) / 60, 1),
                   "max_mem_mib": round(torch.cuda.max_memory_allocated() / 2**20)}
            log.write(json.dumps(rec) + "\n")
            log.flush()
            print(rec, flush=True)
            run_loss = 0.0
    torch.save(model.state_dict(), out / "final.pt")
    settings = {"base": "selected/best.pt", "pairs": len(data), "batches": len(batches), "steps": steps, "batch": BATCH, "lr": LR,
                "temperature": TEMP, "q_max": Q_MAX, "p_max": P_MAX, "by_language": Counter(x["lang"] for x in data),
                "with_hard_negative": sum(1 for x in data if x["neg"])}
    (out / "settings.json").write_text(json.dumps(settings, indent=2), encoding="utf-8")
    return 0


def load_encoder(out: Path) -> Encoder:
    return Encoder(None if "--base" in sys.argv else out / "final.pt")


def recall(ranks: list[list[int]], gold: list[set[int]], k: int) -> float:
    return round(100 * sum(bool(set(r[:k]) & g) for r, g in zip(ranks, gold)) / len(gold), 1)


def dev(out: Path) -> int:
    torch = __import__("torch")
    enc = load_encoder(out)
    enc.model.eval()
    res = {}
    for split in ("test_tydi_ar", "test_arcd", "test_squad"):
        rows = [json.loads(l) for l in (V3 / f"{split}.jsonl").read_text(encoding="utf-8").splitlines()]
        rows = [r for r in rows if r["kind"] == "answerable"]
        ps = sorted({split_row(r)[0] for r in rows})
        idx = {p: i for i, p in enumerate(ps)}
        pv = enc.embed_many(ps, "passage: ", P_MAX)
        qv = enc.embed_many([split_row(r)[1] for r in rows], "query: ", Q_MAX)
        ranks = (qv @ pv.T).topk(10, dim=-1).indices.tolist()
        gold = [{idx[split_row(r)[0]]} for r in rows]
        res[split] = {"questions": len(rows), "passages": len(ps), **{f"recall@{k}": recall(ranks, gold, k) for k in (1, 3, 10)}}
        print(split, res[split], flush=True)
    name = "dev_base.json" if "--base" in sys.argv else "dev.json"
    (out / name).write_text(json.dumps(res, indent=2), encoding="utf-8")
    return 0


def docs(out: Path) -> int:
    import retrieval_variants as rv
    import abstain_verifier as av
    enc = load_encoder(out)
    enc.model.eval()
    chunks = [json.loads(l) for l in (FS / "chunks.jsonl").read_text(encoding="utf-8").splitlines()]
    pv = enc.embed_many([rv.doc_text(c) for c in chunks], "passage: ", P_MAX)
    bm = rv.Variants(chunks)
    res = {}
    for d in (FS, FS / "paraphrased"):
        qs = json.loads((d / "questions.json").read_text(encoding="utf-8"))
        qv = enc.embed_many([q["question"] for q in qs], "query: ", Q_MAX)
        sims = (qv @ pv.T)
        res[d.name] = {}
        for mode in ("dense", "hybrid"):
            r = {}
            ranked = {}
            for i, q in enumerate(qs):
                dense = sims[i].topk(50).indices.tolist()
                if mode == "dense":
                    ranked[q["qid"]] = (dense, float(sims[i].max()))
                else:
                    fused = Counter()
                    for lst in (dense, [j for _, j in bm.rank("A", q["question"])[:50]]):
                        for pos, j in enumerate(lst):
                            fused[j] += 1 / (60 + pos + 1)
                    order = [j for j, _ in fused.most_common()]
                    ranked[q["qid"]] = (order, float(sims[i].max()))
            for lang in ("ar", "en", "all"):
                sel = [q for q in qs if lang == "all" or q["language"] == lang]
                pos = [q for q in sel if q["answer"]]
                hit = lambda q, k: any(rv.contains(chunks[j], q) for j in ranked[q["qid"]][0][:k])  # noqa: E731
                r[lang] = {"n": len(pos), "top1_pct": round(100 * sum(hit(q, 1) for q in pos) / len(pos), 1),
                           "top3_pct": round(100 * sum(hit(q, 3) for q in pos) / len(pos), 1),
                           "top10_pct": round(100 * sum(hit(q, 10) for q in pos) / len(pos), 1),
                           "auc_top_dense_score": av.auc([ranked[q["qid"]][1] for q in sel], [int(bool(q["answer"])) for q in sel])}
            res[d.name][mode] = r
            print(d.name, mode, json.dumps(r), flush=True)
    name = "docs_base.json" if "--base" in sys.argv else "docs.json"
    (out / name).write_text(json.dumps(res, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    mode, target = sys.argv[1], Path(sys.argv[2]).resolve()
    raise SystemExit({"train": train, "dev": dev, "docs": docs}[mode](target))
