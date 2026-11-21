"""Independent reading evaluation of a frozen reading model on XQuAD (ar + en, parallel), 2026-11-20.

The model and its abstain policy (abstain-policy.json next to the checkpoint) are frozen: nothing here
trains or tunes. Every XQuAD question is asked in both languages under five contexts:
  gold          the paragraph window that contains the answer             -> answer expected
  nopassage     question alone (control: memorised or read?)              -> scored vs the gold answer
  deleted       gold window with every sentence holding the answer cut    -> "not stated" expected
  distractor    another paragraph of the same article without the answer  -> "not stated" expected
  counterfact   gold window with the answer replaced by another question's -> the NEW answer expected
                answer of the same type (same substitute question in both languages)
Fresh flag: XQuAD-en comes from SQuAD v1.1 dev; 35 of its 48 articles are in the 1,000-question SQuAD
sample the English threshold was chosen on. fresh=True marks the 13 articles that are not.
Items, their sha256 and the policy are written to protocol.json BEFORE the model loads.

Usage: python -I independent_eval.py build OUT_DIR
       python -I independent_eval.py run OUT_DIR --finetune reading-v3-last
       python -I independent_eval.py score OUT_DIR
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
RAW = ROOT / "artifacts/reading-data-raw/xquad"
SAMPLE = ROOT / "artifacts/reading-training/v3/test_squad.jsonl"
TRAIN = ROOT / "artifacts/reading-training/v3/train.jsonl"
POLICY = ROOT / "artifacts/execution-model-runs/text-b4-2026-11-18/stage-3-full/reading-v3-last/abstain-policy.json"
NOT = {"en": "Not stated in the text", "ar": "غير مذكور في النص"}
Q = {"en": "Question: ", "ar": "سؤال: "}
A = {"en": "Answer:", "ar": "الجواب:"}
CONDS = ["gold", "nopassage", "deleted", "distractor", "counterfact"]
EXPECT_ANSWER = {"gold": True, "nopassage": True, "deleted": False, "distractor": False, "counterfact": True}


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------- build ----------------
def qtype(q_en: str, a_en: str) -> str:
    a = a_en.strip()
    if re.fullmatch(r"(1[0-9]|20)\d\d", a):
        return "year"
    if re.search(r"\d", a):
        return "number"
    w = q_en.strip().split()[0].lower() if q_en.strip() else ""
    if w in {"who", "whom", "whose"}:
        return "who"
    if w == "where":
        return "where"
    if w == "when":
        return "when"
    n = len(a.split())
    return "other" + ("1" if n == 1 else "2" if n == 2 else "3+")


def build(out: Path) -> int:
    import make_reading_data_v2 as mk  # TextEncoder, window(), sentences(), PASSAGE_BUDGET
    out.mkdir(parents=True, exist_ok=False)
    rng = random.Random(20261121)
    data = {l: json.loads((RAW / f"xquad.{l}.json").read_text(encoding="utf-8"))["data"] for l in ("ar", "en")}
    sample_titles = {json.loads(l)["title"] for l in SAMPLE.read_text(encoding="utf-8").splitlines() if l.strip()}
    train_titles = {json.loads(l)["title"] for l in TRAIN.read_text(encoding="utf-8").splitlines() if l.strip()}

    # parallel questions keyed by qid
    qs = {}
    for ai, (art_en, art_ar) in enumerate(zip(data["en"], data["ar"])):
        for pi, (p_en, p_ar) in enumerate(zip(art_en["paragraphs"], art_ar["paragraphs"])):
            ar_by_id = {q["id"]: q for q in p_ar["qas"]}
            for q_en in p_en["qas"]:
                q_ar = ar_by_id.get(q_en["id"])
                if not q_ar:
                    continue
                qs[q_en["id"]] = {"qid": q_en["id"], "article": ai, "title": art_en["title"], "para": pi,
                                  "en": {"q": q_en["question"], "a": q_en["answers"][0], "ctx": p_en["context"],
                                         "others": [p["context"] for j, p in enumerate(art_en["paragraphs"]) if j != pi]},
                                  "ar": {"q": q_ar["question"], "a": q_ar["answers"][0], "ctx": p_ar["context"],
                                         "others": [p["context"] for j, p in enumerate(art_ar["paragraphs"]) if j != pi]}}
    by_type = defaultdict(list)
    for x in qs.values():
        x["type"] = qtype(x["en"]["q"], x["en"]["a"]["text"])
        by_type[x["type"]].append(x)

    def gold_window(side):
        a, ctx = side["a"], side["ctx"]
        s = a["answer_start"]
        if ctx[s:s + len(a["text"])] != a["text"]:
            s = ctx.find(a["text"])
            if s < 0:
                return None
        return mk.window(ctx, s, s + len(a["text"]), rng)

    def prompt(lang, passage, q):
        q = " ".join(q.split())
        return (f"{passage}\n\n" if passage is not None else "") + f"{Q[lang]}{q}\n{A[lang]}"

    rows, skipped = [], defaultdict(int)
    for x in qs.values():
        fresh = x["title"] not in sample_titles
        # substitute question: same type, other article, its answers absent from both gold windows
        cands = [y for y in by_type[x["type"]] if y["article"] != x["article"]]
        rng.shuffle(cands)
        wins = {l: gold_window(x[l]) for l in ("ar", "en")}
        for lang in ("ar", "en"):
            side, win = x[lang], wins[lang]
            ans = " ".join(side["a"]["text"].split())
            base = {"qid": x["qid"], "language": lang, "title": x["title"], "fresh": fresh, "type": x["type"]}
            if not win or ans not in win:
                skipped[f"{lang}:no_gold_window"] += 1
                continue
            add = lambda cond, passage, answer, **kw: rows.append(dict(  # noqa: E731
                base, id=sha(f"{x['qid']}|{lang}|{cond}")[:16], condition=cond,
                kind="answerable" if EXPECT_ANSWER[cond] else "unanswerable",
                answer=answer, prompt=prompt(lang, passage, side["q"]), **kw))
            add("gold", win, ans)
            add("nopassage", None, ans)
            # deleted: drop every sentence that holds the answer; answer must be gone from the rest
            spans = mk.sentences(win)
            kept = [win[a:b] for a, b in spans if ans not in win[a:b]]
            rest = " ".join(kept)
            if kept and len(kept) < len(spans) and ans not in rest and len(rest.split()) >= 8:
                add("deleted", rest, NOT[lang], original_answer=ans)
            else:
                skipped[f"{lang}:deleted"] += 1
            others = [c for c in side["others"] if ans not in c]
            if others:
                d = mk.window(rng.choice(others), None, None, rng)
                if d and ans not in d:
                    add("distractor", d, NOT[lang], original_answer=ans)
                else:
                    skipped[f"{lang}:distractor"] += 1
            else:
                skipped[f"{lang}:distractor"] += 1
        # counterfact: one substitute question used for both languages
        sub = next((y for y in cands
                    if all(wins[l] and " ".join(y[l]["a"]["text"].split()) not in wins[l]
                           and " ".join(x[l]["a"]["text"].split()) not in " ".join(y[l]["a"]["text"].split())
                           and " ".join(y[l]["a"]["text"].split()) not in " ".join(x[l]["a"]["text"].split())
                           for l in ("ar", "en"))), None)
        for lang in ("ar", "en"):
            win = wins[lang]
            ans = " ".join(x[lang]["a"]["text"].split())
            if not sub or not win or ans not in win:
                skipped[f"{lang}:counterfact"] += 1
                continue
            new = " ".join(sub[lang]["a"]["text"].split())
            cf = win.replace(ans, new)
            if mk.ntok(cf) > mk.PASSAGE_BUDGET + 40:
                skipped[f"{lang}:counterfact"] += 1
                continue
            rows.append({"qid": x["qid"], "language": lang, "title": x["title"], "fresh": x["title"] not in sample_titles,
                         "type": x["type"], "id": sha(f"{x['qid']}|{lang}|counterfact")[:16], "condition": "counterfact",
                         "kind": "answerable", "answer": new, "original_answer": ans, "substitute_qid": sub["qid"],
                         "prompt": prompt(lang, cf, x[lang]["q"])})

    items = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)
    (out / "items.jsonl").write_text(items, encoding="utf-8")
    counts = defaultdict(int)
    for r in rows:
        counts[f"{r['language']}:{r['condition']}:{'fresh' if r['fresh'] else 'sample-overlap'}"] += 1
    policy = json.loads(POLICY.read_text(encoding="utf-8"))
    protocol = {
        "created": "2026-11-20", "items_sha256": sha(items), "n_items": len(rows), "counts": dict(sorted(counts.items())),
        "skipped": dict(sorted(skipped.items())),
        "raw_sha256": {f.name: hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(RAW.glob("*.json"))},
        "xquad_articles": len(data["en"]), "fresh_articles": sum(a["title"] not in sample_titles for a in data["en"]),
        "articles_in_train": sum(a["title"] in train_titles for a in data["en"]),
        "model": policy["model_folder"], "checkpoint_sha256": policy["checkpoint_sha256"], "tau": policy["tau"],
        "rule": policy["rule"],
        "primary": "fresh articles; per language and condition: answer F1/EM and wrong-refusal on gold and "
                   "counterfact, correct-refusal on deleted and distractor, counterfact follows-new vs keeps-old, "
                   "nopassage F1 as memorisation control; reference systems always-abstain and never-abstain",
        "frozen": "no training, no threshold change; this set is not to be used for selection",
    }
    (out / "protocol.json").write_text(json.dumps(protocol, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(protocol, ensure_ascii=False, indent=2))
    return 0


# ---------------- run ----------------
def run(out: Path) -> int:
    protocol = json.loads((out / "protocol.json").read_text(encoding="utf-8"))
    items = (out / "items.jsonl").read_text(encoding="utf-8")
    assert sha(items) == protocol["items_sha256"], "items changed after the protocol was written"
    import run_context_test as rc
    import calibrate_abstain as ca
    import eval_reading_v2 as ev
    assert rc.CHECKPOINT_SHA == protocol["checkpoint_sha256"], (rc.CHECKPOINT_SHA, protocol["checkpoint_sha256"])
    rc.GEN_MAX = 48
    scorer = rc.Scorer()
    enc = scorer.w.encoder.encode
    not_firsts = {enc(" " + ev.NOT[l])[0] for l in ev.NOT}
    banned = frozenset(not_firsts | {scorer.eos})
    rows = [json.loads(l) for l in items.splitlines() if l.strip()]
    done = {}
    path = out / "margins.jsonl"
    if path.exists():
        done = {json.loads(l)["id"]: 1 for l in path.read_text(encoding="utf-8").splitlines() if l.strip()}
    with path.open("a", encoding="utf-8") as fh:
        for i, r in enumerate(rows):
            if r["id"] in done:
                continue
            got = ca.collect(scorer, [r], not_firsts, banned)[0]
            fh.write(json.dumps({"id": r["id"], "margin": got["margin"], "span": got["span"]}, ensure_ascii=False) + "\n")
            if i % 500 == 0:
                fh.flush()
                print(i, len(rows), flush=True)
    return 0


# ---------------- score ----------------
def wilson(k: int, n: int) -> list[float]:
    if not n:
        return [0.0, 0.0]
    z, p = 1.96, k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(100 * (c - h), 1), round(100 * (c + h), 1)]


def score(out: Path) -> int:
    import eval_reading_v2 as ev
    protocol = json.loads((out / "protocol.json").read_text(encoding="utf-8"))
    tau = protocol["tau"]
    rows = {r["id"]: r for r in map(json.loads, (out / "items.jsonl").read_text(encoding="utf-8").splitlines())}
    got = {g["id"]: g for g in map(json.loads, (out / "margins.jsonl").read_text(encoding="utf-8").splitlines())}
    assert set(got) == set(rows), f"{len(got)} of {len(rows)} scored"

    def same(a, b, lang):
        return ev.norm(a, lang) == ev.norm(b, lang)

    res = {}
    for subset in ("fresh", "all"):
        for lang in ("ar", "en"):
            for cond in CONDS:
                sel = [r for r in rows.values() if r["language"] == lang and r["condition"] == cond
                       and (subset == "all" or r["fresh"])]
                n = len(sel)
                if not n:
                    continue
                k = {"refused": 0, "em": 0.0, "f1": 0.0, "forced_em": 0.0, "forced_f1": 0.0, "old": 0}
                for r in sel:
                    g = got[r["id"]]
                    abstain = g["margin"] < tau[lang]
                    k["refused"] += abstain
                    if r["kind"] == "answerable":
                        p, t = ev.norm(g["span"], lang), ev.norm(r["answer"], lang)
                        fem, ff = float(p == t), ev.f1(p, t)
                        k["forced_em"] += fem
                        k["forced_f1"] += ff
                        if not abstain:
                            k["em"] += fem
                            k["f1"] += ff
                    if r.get("original_answer") and not abstain:
                        k["old"] += ev.f1(ev.norm(g["span"], lang), ev.norm(r["original_answer"], lang)) >= 0.5
                c = {"n": n, "refused_pct": round(100 * k["refused"] / n, 1), "refused_ci95": wilson(k["refused"], n)}
                if EXPECT_ANSWER[cond]:
                    c.update(em_pct=round(100 * k["em"] / n, 1), f1_pct=round(100 * k["f1"] / n, 1),
                             em_ci95=wilson(round(k["em"]), n),
                             forced_em_pct=round(100 * k["forced_em"] / n, 1), forced_f1_pct=round(100 * k["forced_f1"] / n, 1))
                if cond in ("deleted", "distractor", "counterfact"):
                    c["gave_original_answer_pct"] = round(100 * k["old"] / n, 1)
                res[f"{subset}:{lang}:{cond}"] = c
            # combined SQuAD-2-style score over gold + deleted, and the two reference systems
            g_rows = [r for r in rows.values() if r["language"] == lang and r["condition"] in ("gold", "deleted")
                      and (subset == "all" or r["fresh"])]
            if g_rows:
                tot = {"policy": 0.0, "always_abstain": 0.0, "never_abstain": 0.0}
                for r in g_rows:
                    g = got[r["id"]]
                    abstain = g["margin"] < tau[lang]
                    if r["kind"] == "unanswerable":
                        tot["policy"] += abstain
                        tot["always_abstain"] += 1
                    else:
                        f = ev.f1(ev.norm(g["span"], lang), ev.norm(r["answer"], lang))
                        tot["policy"] += 0 if abstain else f
                        tot["never_abstain"] += f
                n = len(g_rows)
                res[f"{subset}:{lang}:gold+deleted_f1"] = {"n": n, **{k2: round(100 * v / n, 1) for k2, v in tot.items()}}
    # counterfact split by substitute quality: typed (year/number/who/where/when) vs other (may read oddly)
    for subset in ("fresh", "all"):
        for lang in ("ar", "en"):
            for grp in ("typed", "other"):
                sel = [r for r in rows.values() if r["language"] == lang and r["condition"] == "counterfact"
                       and (subset == "all" or r["fresh"]) and (r["type"].startswith("other") == (grp == "other"))]
                if not sel:
                    continue
                new = old = ref = 0
                for r in sel:
                    g = got[r["id"]]
                    if g["margin"] < tau[lang]:
                        ref += 1
                        continue
                    p = ev.norm(g["span"], lang)
                    new += ev.f1(p, ev.norm(r["answer"], lang)) >= 0.5
                    old += ev.f1(p, ev.norm(r["original_answer"], lang)) >= 0.5
                n = len(sel)
                res[f"{subset}:{lang}:counterfact_{grp}"] = {
                    "n": n, "follows_new_pct": round(100 * new / n, 1), "keeps_old_pct": round(100 * old / n, 1),
                    "refused_pct": round(100 * ref / n, 1), "follows_new_ci95": wilson(new, n)}
    (out / "scores.json").write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    mode, target = sys.argv[1], Path(sys.argv[2]).resolve()
    raise SystemExit({"build": build, "run": run, "score": score}[mode](target))
