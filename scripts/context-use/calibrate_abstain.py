"""Abstain calibration for a reading model, no training.

At the first answer step the model either starts the not-stated phrase or starts a span. Greedy
abstains when the not-stated first token is the top token. Here:
  margin = log p(best other first token) - log p(not-stated first token)   [EOS excluded]
  answer  = forced span (not-stated first tokens and EOS blocked at step one), if margin >= tau
          = not stated, otherwise.
tau = 0 is close to plain greedy. One tau per language is chosen on the VALIDATION split only
(max mean F1), written to thresholds.json, and only then applied to the test splits.
Usage: python calibrate_abstain.py OUT_DIR --finetune NAME
"""
from __future__ import annotations

import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_context_test as rc  # noqa: E402
import eval_reading_v2 as ev  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")
DATA = ev.DATA  # --data DIR (default v2); its validation split picks tau, its test splits are scored
TESTS = ["test_squad", "test_tydi_ar", "test_arcd", "frozen24"]


def frozen_rows() -> list[dict]:
    items = json.loads(rc.ITEMS.read_text(encoding="utf-8"))
    out = []
    for it in items["items"]:
        lang = it["language"]
        out.append({"id": it["id"], "language": lang, "kind": "answerable" if it["answerable"] else "unanswerable",
                    "answer": it["answer"] if it["answerable"] else ev.NOT[lang],
                    "prompt": rc.prefix(it, it["passage"])})
    return out


def collect(scorer, rows, not_firsts, banned) -> list[dict]:
    import torch
    out = []
    for r in rows:
        ids = scorer.w.encoder.encode(r["prompt"])
        lp = torch.log_softmax(scorer.logits(ids)[-1], dim=-1)
        not_lp = max(float(lp[t]) for t in not_firsts)
        masked = lp.clone()
        for t in banned:
            masked[t] = -float("inf")
        margin = float(masked.max()) - not_lp
        span = scorer.greedy(r["prompt"], banned)["text"]
        out.append({"id": r["id"], "language": r["language"], "kind": r["kind"], "answer": r["answer"],
                    "margin": round(margin, 4), "span": span})
    return out


def score(rows, taus: dict[str, float]) -> dict:
    tot = {"all": [0, 0.0, 0.0], "answerable": [0, 0.0, 0.0], "unanswerable": [0, 0.0, 0.0]}
    said_not = 0
    for r in rows:
        lang = r["language"]
        abstain = r["margin"] < taus[lang]
        if r["kind"] == "unanswerable":
            em = f = float(abstain)
        else:
            said_not += abstain
            g, p = ev.norm(r["answer"], lang), ev.norm(r["span"], lang)
            em, f = (0.0, 0.0) if abstain else (float(p == g), ev.f1(p, g))
        for k in ("all", r["kind"]):
            tot[k][0] += 1
            tot[k][1] += em
            tot[k][2] += f
    res = {k: {"n": n, "em_pct": round(100 * e / n, 1), "f1_pct": round(100 * f / n, 1)} for k, (n, e, f) in tot.items() if n}
    res["answerable_said_not_stated"] = said_not
    return res


def best_tau(rows) -> tuple[float, float]:
    cands = sorted({r["margin"] for r in rows})
    grid = [cands[0] - 1] + [(a + b) / 2 for a, b in zip(cands, cands[1:])] + [cands[-1] + 1]
    best = None
    for t in grid:
        f = score(rows, {r["language"]: t for r in rows})["all"]["f1_pct"]
        if best is None or f > best[1] or (f == best[1] and abs(t) < abs(best[0])):
            best = (t, f)
    return round(best[0], 4), best[1]


def main() -> int:
    out = Path(sys.argv[1]).resolve()
    out.mkdir(parents=True, exist_ok=False)
    scorer = rc.Scorer()
    enc = scorer.w.encoder.encode
    not_firsts = {enc(" " + ev.NOT[l])[0] for l in ev.NOT}
    banned = frozenset(not_firsts | {scorer.eos})
    load = lambda s: [json.loads(l) for l in (DATA / f"{s}.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]  # noqa: E731
    started = time.perf_counter()

    # 1) validation only -> thresholds, frozen before any test row is scored
    val = collect(scorer, load("validation"), not_firsts, banned)
    (out / "validation.margins.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in val), encoding="utf-8")
    taus, val_f1 = {}, {}
    for lang in ("ar", "en"):
        taus[lang], val_f1[lang] = best_tau([r for r in val if r["language"] == lang])
    thresholds = {"finetune": rc.FINETUNE, "checkpoint_sha256": rc.CHECKPOINT_SHA, "chosen_on": "validation",
                  "tau": taus, "validation_f1_at_tau": val_f1,
                  "validation_at_tau0": score(val, {"ar": 0.0, "en": 0.0}),
                  "validation_at_tau": score(val, taus), "not_first_token_ids": sorted(not_firsts)}
    (out / "thresholds.json").write_text(json.dumps(thresholds, ensure_ascii=False, indent=2), encoding="utf-8")
    print("thresholds", json.dumps(thresholds["tau"]), "val f1", val_f1, flush=True)

    # 2) tests with the fixed thresholds
    report = {"thresholds": thresholds, "tests": {}}
    for split in TESTS:
        rows = frozen_rows() if split == "frozen24" else load(split)
        got = collect(scorer, rows, not_firsts, banned)
        (out / f"{split}.margins.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in got), encoding="utf-8")
        report["tests"][split] = {"tau0": score(got, {"ar": 0.0, "en": 0.0}), "tau_validation": score(got, taus)}
        print(split, json.dumps(report["tests"][split], ensure_ascii=False), flush=True)
    report["elapsed_seconds"] = round(time.perf_counter() - started, 1)
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
