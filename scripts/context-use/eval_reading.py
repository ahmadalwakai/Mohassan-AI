"""Exact-match reading score on the generated splits (validation = trained families,
dev_heldout = four families never trained). Greedy with the same stop rules as the context test.
Usage: python eval_reading.py OUT_JSON --finetune NAME [--limit N]
"""
from __future__ import annotations

from collections import defaultdict
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_context_test as rc  # noqa: E402  (reads --finetune from sys.argv)

DATA = rc.ROOT / "artifacts/reading-training/v1"


def same(a: str, b: str) -> bool:
    return " ".join(rc.norm(a).split()) == " ".join(rc.norm(b).split())


def main() -> int:
    out = Path(sys.argv[1]).resolve()
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
    scorer = rc.Scorer()
    report = {"finetune": rc.FINETUNE, "checkpoint_sha256": rc.CHECKPOINT_SHA, "splits": {}}
    samples = []
    for split in ("validation", "dev_heldout"):
        rows = [json.loads(l) for l in (DATA / f"{split}.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
        rows = rows[:limit] if limit else rows
        tally = defaultdict(lambda: [0, 0])
        for r in rows:
            got = scorer.greedy(r["prompt"])["text"]
            ok = same(got, r["answer"])
            unans = r["kind"].startswith("unanswerable")
            for key in ("all", r["language"], "family:" + r["family"],
                        "unanswerable" if unans else "answerable", "kind:" + r["kind"].split(":")[0]):
                tally[key][0] += ok
                tally[key][1] += 1
            # false "not stated" on answerable items
            if not unans:
                said_not = same(got, "غير مذكور في النص" if r["language"] == "ar" else "Not stated in the text")
                tally["answerable_said_not_stated"][0] += said_not
                tally["answerable_said_not_stated"][1] += 1
            if len(samples) < 40 and not ok:
                samples.append({"split": split, "q": r["question"], "expected": r["answer"], "got": got})
        report["splits"][split] = {k: {"correct": v[0], "of": v[1], "pct": round(100 * v[0] / v[1], 1)}
                                   for k, v in sorted(tally.items())}
    report["wrong_samples"] = samples
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    for split, t in report["splits"].items():
        print(split, {k: f"{v['correct']}/{v['of']}" for k, v in t.items()})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
