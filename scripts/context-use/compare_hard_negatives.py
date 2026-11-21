"""Compare reading-v3-last and reading-v4-hn on abstaining and extraction (2026-11-21).

Dev (selection allowed): abstain-verifier dev items (gold vs deleted vs distractor, built from v3
validation + SQuAD dev sample + TyDi-ar dev + ARCD test) and the 513 SQuAD native no-answer questions
(written to look answerable; the honest English hard-negative check). Note v4 trained on deleted-sentence
negatives from TRAIN articles, so dev "deleted" is in-distribution for v4; native no-answer is not.
tau per language and model is chosen on dev (best 50/50 score) and frozen to taus.json before `final`.
Final (once): XQuAD fresh gold / deleted / distractor / counterfact.

Usage (.venv-execution):
  python -I compare_hard_negatives.py collect OUT --finetune NAME     (dev margins+spans for NAME)
  python -I compare_hard_negatives.py dev OUT                         (scores both, freezes taus)
  python -I compare_hard_negatives.py collect-final OUT --finetune NAME
  python -I compare_hard_negatives.py final OUT
"""
from __future__ import annotations

import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.stdout.reconfigure(encoding="utf-8")
import abstain_verifier as av  # noqa: E402

AV = ROOT / "artifacts/abstain-verifier-20261120"
XQ = ROOT / "artifacts/reading-independent-20261120"
MODELS = ["reading-v3-last", "reading-v4-hn-last"]  # v4: final step, chosen before scoring
ARG = lambda k: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else None  # noqa: E731


def dev_rows() -> list[dict]:
    rows = [json.loads(l) for l in (AV / "dev_items.jsonl").read_text(encoding="utf-8").splitlines()]
    adv = [json.loads(l) for l in (AV / "squad_adversarial_items.jsonl").read_text(encoding="utf-8").splitlines()]
    for r in adv:
        r.update(condition="squad_native", label=0)
    return rows + adv


def final_rows() -> list[dict]:
    rows = [json.loads(l) for l in (XQ / "items.jsonl").read_text(encoding="utf-8").splitlines()]
    rows = [r for r in rows if r["fresh"] and r["condition"] in ("gold", "deleted", "distractor", "counterfact")]
    for r in rows:
        r["label"] = int(r["condition"] in ("gold", "counterfact"))
    return rows


def collect(out: Path, rows: list[dict], name: str) -> int:
    import run_context_test as rc
    import calibrate_abstain as ca
    import eval_reading_v2 as ev
    rc.GEN_MAX = 48
    scorer = rc.Scorer()
    enc = scorer.w.encoder.encode
    not_firsts = {enc(" " + ev.NOT[l])[0] for l in ev.NOT}
    banned = frozenset(not_firsts | {scorer.eos})
    path = out / name
    done = set()
    if path.exists():
        done = {json.loads(l)["id"] for l in path.read_text(encoding="utf-8").splitlines() if l.strip()}
    with path.open("a", encoding="utf-8") as fh:
        for i, r in enumerate(rows):
            if r["id"] in done:
                continue
            g = ca.collect(scorer, [dict(r, kind="answerable" if r["label"] else "unanswerable")], not_firsts, banned)[0]
            fh.write(json.dumps({"id": r["id"], "margin": g["margin"], "span": g["span"]}, ensure_ascii=False) + "\n")
            if i % 500 == 0:
                fh.flush()
                print(i, len(rows), flush=True)
    return 0


def load(path: Path) -> dict:
    return {g["id"]: g for g in map(json.loads, path.read_text(encoding="utf-8").splitlines())}


def table(rows, got, tau, lang) -> dict:
    import eval_reading_v2 as ev
    rr = [r for r in rows if r["language"] == lang]
    out = {}
    pos = [r for r in rr if r["label"] == 1]
    if pos:
        out["forced_f1_answerable"] = round(100 * sum(ev.f1(ev.norm(got[r["id"]]["span"], lang), ev.norm(r["answer"], lang))
                                                      for r in pos) / len(pos), 1)
    for cond in sorted({r["condition"] for r in rr}):
        sel = [r for r in rr if r["condition"] == cond]
        out[f"refused_pct:{cond}"] = round(100 * sum(got[r["id"]]["margin"] < tau for r in sel) / len(sel), 1)
        if cond != "gold" and sel[0]["label"] == 0:
            lab = [1] * len(pos) + [0] * len(sel)
            out[f"auc_gold_vs:{cond}"] = av.auc([got[r["id"]]["margin"] for r in pos + sel], lab)
    if pos:
        f1 = sum(0 if got[r["id"]]["margin"] < tau else ev.f1(ev.norm(got[r["id"]]["span"], lang), ev.norm(r["answer"], lang))
                 for r in pos) / len(pos)
        neg = [r for r in rr if r["label"] == 0]
        ref = sum(got[r["id"]]["margin"] < tau for r in neg) / max(len(neg), 1)
        out["answerable_f1_policy"] = round(100 * f1, 1)
        out["negatives_refused_pct"] = round(100 * ref, 1)
        out["balanced_50_50"] = round(50 * f1 + 50 * ref, 1)
    return out


def best_tau(rows, got, lang) -> float:
    import eval_reading_v2 as ev
    rr = [r for r in rows if r["language"] == lang]
    pos = [r for r in rr if r["label"] == 1]
    neg = [r for r in rr if r["label"] == 0]
    f = {r["id"]: ev.f1(ev.norm(got[r["id"]]["span"], lang), ev.norm(r["answer"], lang)) for r in pos}
    ms = sorted({got[r["id"]]["margin"] for r in rr})
    best = None
    for t in ms[::max(1, len(ms) // 600)]:
        s = 50 * sum(f[r["id"]] for r in pos if got[r["id"]]["margin"] >= t) / len(pos) + \
            50 * sum(got[r["id"]]["margin"] < t for r in neg) / len(neg)
        if best is None or s > best[1]:
            best = (t, s)
    return round(best[0], 4)


def dev(out: Path) -> int:
    rows = dev_rows()
    res, taus = {}, {}
    for m in MODELS:
        got = load(out / f"dev.{m}.jsonl")
        assert all(r["id"] in got for r in rows), m
        taus[m] = {l: best_tau(rows, got, l) for l in ("ar", "en")}
        res[m] = {l: table(rows, got, taus[m][l], l) for l in ("ar", "en")}
        res[m]["tau"] = taus[m]
    (out / "taus.json").write_text(json.dumps(taus, indent=2), encoding="utf-8")
    (out / "dev_scores.json").write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return 0


def final(out: Path) -> int:
    taus = json.loads((out / "taus.json").read_text(encoding="utf-8"))
    rows = final_rows()
    res = {}
    for m in MODELS:
        got = load(out / f"final.{m}.jsonl")
        res[m] = {l: table(rows, got, taus[m][l], l) for l in ("ar", "en")}
        for l in ("ar", "en"):
            cf = [r for r in rows if r["language"] == l and r["condition"] == "counterfact" and not r["type"].startswith("other")]
            import eval_reading_v2 as ev
            res[m][l]["counterfact_typed_follows_new_pct"] = round(100 * sum(
                got[r["id"]]["margin"] >= taus[m][l] and ev.f1(ev.norm(got[r["id"]]["span"], l), ev.norm(r["answer"], l)) >= 0.5
                for r in cf) / len(cf), 1)
    (out / "final_scores.json").write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    mode, out = sys.argv[1], Path(sys.argv[2]).resolve()
    out.mkdir(parents=True, exist_ok=True)
    if mode == "collect":
        raise SystemExit(collect(out, dev_rows(), f"dev.{ARG('--finetune')}.jsonl"))
    if mode == "collect-final":
        assert (out / "taus.json").exists(), "freeze taus on dev first"
        raise SystemExit(collect(out, final_rows(), f"final.{ARG('--finetune')}.jsonl"))
    raise SystemExit({"dev": dev, "final": final}[mode](out))
