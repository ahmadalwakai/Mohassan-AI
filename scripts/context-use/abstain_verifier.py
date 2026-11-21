"""Abstain verifier for a frozen reading model (no model training), 2026-11-20.

The current rule abstains on one number: the first-token margin against "not stated". On XQuAD it barely
separates "answer present" from "answer removed". This adds a small logistic verifier on cheap signals:
  margin, span mean / min token log-prob, span length, span found in passage, question-word overlap of
  the sentence holding the span, best question-word overlap of any sentence, stop reason, language.
Primary metric: AUC of "answer is in the passage" (gold) vs "it is not" (deleted + distractor), per
language. Threshold is secondary and reported as a curve.

Development data (all already used for selection, so it is fine to select on): v3 validation, SQuAD dev
sample (answerable), TyDi-ar dev, ARCD test. Each answerable row also gets a deleted and a distractor
variant. Fit on dev articles A, check on dev articles B (split by title hash), then refit on all dev.
XQuAD fresh (artifacts/reading-independent-20261120) is touched once, in `final`, after the verifier
is frozen to verifier.json.

Usage (with .venv-execution):
  python -I abstain_verifier.py build OUT_DIR
  python -I abstain_verifier.py collect OUT_DIR --finetune reading-v3-last            (dev items)
  python -I abstain_verifier.py fit OUT_DIR
  python -I abstain_verifier.py collect-final OUT_DIR --finetune reading-v3-last      (XQuAD fresh)
  python -I abstain_verifier.py final OUT_DIR
"""
from __future__ import annotations

from collections import defaultdict
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
V3 = ROOT / "artifacts/reading-training/v3"
XQ = ROOT / "artifacts/reading-independent-20261120"
NOT = {"en": "Not stated in the text", "ar": "غير مذكور في النص"}
QP = {"en": "\n\nQuestion: ", "ar": "\n\nسؤال: "}
SENT = re.compile(r"(?<=[.!?؟])\s+")
FEATS = ["margin", "lp_mean", "lp_min", "n_tok", "in_passage", "sent_overlap", "best_overlap", "overlap_gap",
         "stop_eos", "is_ar", "is_ar_x_margin"]


def sha(t: str) -> str:
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


def split_prompt(prompt: str, lang: str) -> tuple[str, str]:
    passage, rest = prompt.rsplit(QP[lang], 1)
    return passage, rest.split("\n")[0]


def sentences(text: str) -> list[str]:
    return [s for s in SENT.split(text) if s.strip()]


# ---------------- build dev ----------------
def build(out: Path) -> int:
    out.mkdir(parents=True, exist_ok=False)
    rng = random.Random(20261122)
    src = []
    for name in ("validation", "test_squad", "test_tydi_ar", "test_arcd"):
        for line in (V3 / f"{name}.jsonl").read_text(encoding="utf-8").splitlines():
            r = json.loads(line)
            if r["kind"] == "answerable":
                src.append(dict(r, origin=name))
    by_title = defaultdict(list)
    for r in src:
        by_title[(r["origin"], r["title"])].append(split_prompt(r["prompt"], r["language"])[0])
    rows = []
    for r in src:
        lang, ans = r["language"], r["answer"]
        passage, q = split_prompt(r["prompt"], lang)
        head = r["prompt"][len(passage):]
        base = {"language": lang, "origin": r["origin"], "title": r["title"],
                "half": "A" if int(sha(r["title"])[:8], 16) % 2 == 0 else "B"}
        rows.append(dict(base, id=sha(r["id"] + "gold")[:16], condition="gold", label=1, answer=ans, prompt=r["prompt"]))
        kept = [s for s in sentences(passage) if ans not in s]
        rest = " ".join(kept)
        if kept and len(kept) < len(sentences(passage)) and ans not in rest and len(rest.split()) >= 8:
            rows.append(dict(base, id=sha(r["id"] + "deleted")[:16], condition="deleted", label=0, answer=NOT[lang],
                             prompt=rest + head))
        others = [p for p in set(by_title[(r["origin"], r["title"])]) if ans not in p and p != passage]
        if others:
            rows.append(dict(base, id=sha(r["id"] + "distractor")[:16], condition="distractor", label=0,
                             answer=NOT[lang], prompt=rng.choice(sorted(others)) + head))
    text = "".join(json.dumps(x, ensure_ascii=False) + "\n" for x in rows)
    (out / "dev_items.jsonl").write_text(text, encoding="utf-8")
    counts = defaultdict(int)
    for x in rows:
        counts[f"{x['language']}:{x['condition']}:{x['half']}"] += 1
    info = {"dev_items_sha256": sha(text), "n": len(rows), "counts": dict(sorted(counts.items()))}
    (out / "dev_protocol.json").write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(info, ensure_ascii=False, indent=2))
    return 0


# ---------------- signals ----------------
def terms(text: str) -> set[str]:
    import run_context_test as rc
    return set(rc.terms(text))


def signals(scorer, r, not_firsts, banned) -> dict:
    import torch
    import eval_reading_v2 as ev
    lang = r["language"]
    ids = scorer.w.encoder.encode(r["prompt"])
    lp = torch.log_softmax(scorer.logits(ids)[-1], dim=-1)
    not_lp = max(float(lp[t]) for t in not_firsts)
    masked = lp.clone()
    for t in banned:
        masked[t] = -float("inf")
    margin = float(masked.max()) - not_lp
    g = scorer.greedy(r["prompt"], banned)
    span = g["text"]
    if span.strip():
        total, n = scorer.logprob(r["prompt"], " " + span)
        full, k = scorer.encode_pair(r["prompt"], " " + span)
        lps = torch.log_softmax(scorer.logits(full), dim=-1)
        tgt = torch.tensor(full[k:], device="cuda")
        per = lps[k - 1:len(full) - 1].gather(1, tgt[:, None]).squeeze(1)
        lp_mean, lp_min = total / max(n, 1), float(per.min())
    else:
        lp_mean, lp_min, n = -20.0, -20.0, 0
    passage, q = split_prompt(r["prompt"], lang)
    qt = terms(q)
    sents = sentences(passage) or [passage]
    ov = [len(qt & terms(s)) / max(len(qt), 1) for s in sents]
    in_p = bool(span.strip()) and " ".join(ev.norm(span, lang)) in " ".join(ev.norm(passage, lang))
    holder = [i for i, s in enumerate(sents) if span.strip() and span.strip() in s]
    sent_ov = ov[holder[0]] if holder else 0.0
    return {"id": r["id"], "margin": round(margin, 4), "span": span, "lp_mean": round(lp_mean, 4),
            "lp_min": round(lp_min, 4), "n_tok": n, "in_passage": int(in_p), "sent_overlap": round(sent_ov, 4),
            "best_overlap": round(max(ov), 4), "stop_eos": int(g["stop"] == "eos")}


def collect(out: Path, items_path: Path, dest: str, keep) -> int:
    import run_context_test as rc
    import eval_reading_v2 as ev
    rc.GEN_MAX = 48
    scorer = rc.Scorer()
    enc = scorer.w.encoder.encode
    not_firsts = {enc(" " + ev.NOT[l])[0] for l in ev.NOT}
    banned = frozenset(not_firsts | {scorer.eos})
    rows = [r for r in map(json.loads, items_path.read_text(encoding="utf-8").splitlines()) if keep(r)]
    path = out / dest
    done = set()
    if path.exists():
        done = {json.loads(l)["id"] for l in path.read_text(encoding="utf-8").splitlines() if l.strip()}
    with path.open("a", encoding="utf-8") as fh:
        for i, r in enumerate(rows):
            if r["id"] in done:
                continue
            fh.write(json.dumps(signals(scorer, r, not_firsts, banned), ensure_ascii=False) + "\n")
            if i % 500 == 0:
                fh.flush()
                print(i, len(rows), flush=True)
    return 0


# ---------------- model ----------------
def featurize(r, s) -> list[float]:
    is_ar = float(r["language"] == "ar")
    return [s["margin"], s["lp_mean"], max(s["lp_min"], -20.0), math.log1p(s["n_tok"]), s["in_passage"],
            s["sent_overlap"], s["best_overlap"], s["best_overlap"] - s["sent_overlap"], s["stop_eos"],
            is_ar, is_ar * s["margin"]]


def fit_logreg(X, y, l2=1e-2, steps=3000, lr=0.1):
    import numpy as np
    X, y = np.asarray(X, float), np.asarray(y, float)
    mu, sd = X.mean(0), X.std(0) + 1e-6
    Z = (X - mu) / sd
    w, b = np.zeros(Z.shape[1]), 0.0
    for _ in range(steps):
        p = 1 / (1 + np.exp(-(Z @ w + b)))
        g = p - y
        w -= lr * (Z.T @ g / len(y) + l2 * w)
        b -= lr * g.mean()
    return {"mu": mu.tolist(), "sd": sd.tolist(), "w": w.tolist(), "b": float(b)}


def predict(m, X):
    import numpy as np
    Z = (np.asarray(X, float) - np.asarray(m["mu"])) / np.asarray(m["sd"])
    return (1 / (1 + np.exp(-(Z @ np.asarray(m["w"]) + m["b"])))).tolist()


def auc(scores, labels) -> float:
    pos = [s for s, l in zip(scores, labels) if l]
    neg = [s for s, l in zip(scores, labels) if not l]
    if not pos or not neg:
        return float("nan")
    order = sorted([(s, 1) for s in pos] + [(s, 0) for s in neg])
    rank, i, sum_pos = 1, 0, 0.0
    while i < len(order):
        j = i
        while j < len(order) and order[j][0] == order[i][0]:
            j += 1
        avg = (rank + rank + (j - i) - 1) / 2
        sum_pos += avg * sum(1 for k in range(i, j) if order[k][1])
        rank += j - i
        i = j
    return round((sum_pos - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)), 4)


def operating(rows, sigs, scores, thr, lang):
    """At threshold thr: gold answered/refused and F1, negatives refused; plus 50/50 combined F1."""
    import eval_reading_v2 as ev
    g = [(r, s, p) for r, s, p in zip(rows, sigs, scores) if r["label"] == 1]
    n = [(r, s, p) for r, s, p in zip(rows, sigs, scores) if r["label"] == 0]
    f1g = sum(ev.f1(ev.norm(s["span"], lang), ev.norm(r["answer"], lang)) for r, s, p in g if p >= thr) / max(len(g), 1)
    ref_g = sum(p < thr for _, _, p in g) / max(len(g), 1)
    ref_n = sum(p < thr for _, _, p in n) / max(len(n), 1)
    return {"gold_f1": round(100 * f1g, 1), "gold_refused_pct": round(100 * ref_g, 1),
            "neg_refused_pct": round(100 * ref_n, 1), "balanced_f1": round(50 * f1g + 50 * ref_n, 1)}


def best_thr(rows, sigs, scores, lang):
    cands = sorted(set(round(p, 4) for p in scores))
    best = None
    for t in cands[::max(1, len(cands) // 400)]:
        o = operating(rows, sigs, scores, t, lang)
        if best is None or o["balanced_f1"] > best[1]["balanced_f1"]:
            best = (t, o)
    return best


def load(out: Path, items: Path, sigs_name: str):
    rows = {r["id"]: r for r in map(json.loads, items.read_text(encoding="utf-8").splitlines())}
    sigs = {s["id"]: s for s in map(json.loads, (out / sigs_name).read_text(encoding="utf-8").splitlines())}
    ids = [i for i in rows if i in sigs]
    return [rows[i] for i in ids], [sigs[i] for i in ids]


def fit(out: Path) -> int:
    rows, sigs = load(out, out / "dev_items.jsonl", "dev_signals.jsonl")
    report = {"n": len(rows), "check_on_half_B": {}, "features": FEATS}
    A = [(r, s) for r, s in zip(rows, sigs) if r["half"] == "A"]
    B = [(r, s) for r, s in zip(rows, sigs) if r["half"] == "B"]
    m = fit_logreg([featurize(r, s) for r, s in A], [r["label"] for r, _ in A])
    pb = predict(m, [featurize(r, s) for r, s in B])
    for lang in ("ar", "en"):
        idx = [i for i, (r, _) in enumerate(B) if r["language"] == lang]
        rr, ss, pp = [B[i][0] for i in idx], [B[i][1] for i in idx], [pb[i] for i in idx]
        lab = [r["label"] for r in rr]
        report["check_on_half_B"][lang] = {
            "n": len(rr), "auc_margin": auc([s["margin"] for s in ss], lab), "auc_verifier": auc(pp, lab),
            "auc_by_negative": {c: {"margin": auc([s["margin"] for r, s in zip(rr, ss) if r["label"] or r["condition"] == c],
                                                  [r["label"] for r in rr if r["label"] or r["condition"] == c]),
                                    "verifier": auc([p for r, p in zip(rr, pp) if r["label"] or r["condition"] == c],
                                                    [r["label"] for r in rr if r["label"] or r["condition"] == c])}
                                for c in ("deleted", "distractor")}}
    # freeze: refit on all dev, threshold per language at best balanced F1 on all dev
    full = fit_logreg([featurize(r, s) for r, s in zip(rows, sigs)], [r["label"] for r in rows])
    pall = predict(full, [featurize(r, s) for r, s in zip(rows, sigs)])
    thr = {}
    for lang in ("ar", "en"):
        idx = [i for i, r in enumerate(rows) if r["language"] == lang]
        t, o = best_thr([rows[i] for i in idx], [sigs[i] for i in idx], [pall[i] for i in idx], lang)
        thr[lang] = {"threshold": t, "dev": o}
    frozen = {"model": full, "features": FEATS, "thresholds": thr, "fitted_on": "dev_items.jsonl (all)",
              "dev_items_sha256": json.loads((out / "dev_protocol.json").read_text(encoding="utf-8"))["dev_items_sha256"]}
    (out / "verifier.json").write_text(json.dumps(frozen, ensure_ascii=False, indent=2), encoding="utf-8")
    report["frozen_thresholds"] = thr
    report["weights"] = dict(zip(FEATS, [round(w, 3) for w in full["w"]]))
    (out / "fit_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def final(out: Path) -> int:
    v = json.loads((out / "verifier.json").read_text(encoding="utf-8"))
    tau = json.loads((XQ / "protocol.json").read_text(encoding="utf-8"))["tau"]
    rows, sigs = load(out, XQ / "items.jsonl", "xquad_signals.jsonl")
    for r in rows:
        r["label"] = int(r["condition"] == "gold")
    res = {}
    p = predict(v["model"], [featurize(r, s) for r, s in zip(rows, sigs)])
    for lang in ("ar", "en"):
        idx = [i for i, r in enumerate(rows) if r["language"] == lang]
        rr, ss, pp = [rows[i] for i in idx], [sigs[i] for i in idx], [p[i] for i in idx]
        lab = [r["label"] for r in rr]
        old = operating(rr, ss, [s["margin"] for s in ss], tau[lang], lang)
        new = operating(rr, ss, pp, v["thresholds"][lang]["threshold"], lang)
        res[lang] = {"n": len(rr), "auc_margin": auc([s["margin"] for s in ss], lab), "auc_verifier": auc(pp, lab),
                     "old_policy": old, "verifier": new,
                     "always_abstain_balanced_f1": 50.0,
                     "never_abstain_balanced_f1": operating(rr, ss, [1.0] * len(rr), 0.5, lang)["balanced_f1"]}
    (out / "final_xquad.json").write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    mode, target = sys.argv[1], Path(sys.argv[2]).resolve()
    if mode == "build":
        raise SystemExit(build(target))
    if mode == "collect":
        raise SystemExit(collect(target, target / "dev_items.jsonl", "dev_signals.jsonl", lambda r: True))
    if mode == "collect-final":
        assert (target / "verifier.json").exists(), "freeze the verifier first"
        raise SystemExit(collect(target, XQ / "items.jsonl", "xquad_signals.jsonl",
                                 lambda r: r["fresh"] and r["condition"] in ("gold", "deleted", "distractor")))
    raise SystemExit({"fit": fit, "final": final}[mode](target))
