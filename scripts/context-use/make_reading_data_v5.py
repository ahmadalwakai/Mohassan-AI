"""Reading data v5: v3 train + Arabic-SQuAD (machine-translated SQuAD 1.1 train, MIT, SOQAL repo), 2026-11-21.

Why: the independent check found Arabic reading works on TyDi-style questions (F1 61) but not on
SQuAD-style ones (ARCD 29, XQuAD-ar 18). The only SQuAD-style Arabic in v3 was ARCD train (690 rows).
Arabic-SQuAD shares no article with XQuAD, ARCD test or the SQuAD dev sample (checked at download).
Same windowing and prompt shape as v2/v3. Validation = v3 validation unchanged.
Usage: python -I make_reading_data_v5.py OUT_DIR [--arabic-squad 20000]
"""
from __future__ import annotations

from collections import Counter
import json
from pathlib import Path
import random
import shutil
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import make_reading_data_v2 as mk  # noqa: E402

V3 = mk.ROOT / "artifacts/reading-training/v3"
N = int(sys.argv[sys.argv.index("--arabic-squad") + 1]) if "--arabic-squad" in sys.argv else 20000


def main() -> int:
    out = Path(sys.argv[1]).resolve()
    out.mkdir(parents=True, exist_ok=False)
    rng = random.Random(20261124)
    v3 = [json.loads(l) for l in (V3 / "train.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    asq = mk.squad_like(mk.RAW / "arabic-squad/Arabic-SQuAD.json", "ar", "arabic-squad", rng, keep_impossible=False)
    available = len(asq)
    rng.shuffle(asq)
    asq = [dict(r, split="train") for r in asq[:N]]
    rows = v3 + asq
    rng.shuffle(rows)
    (out / "train.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    shutil.copyfile(V3 / "validation.jsonl", out / "validation.jsonl")
    summary = {"rows": len(rows), "arabic_squad_available_after_window": available, "arabic_squad_used": len(asq),
               "by": dict(sorted(Counter(f"{r['language']}:{r['kind']}:{r['source']}" for r in rows).items())),
               "raw_sha256": (mk.RAW / "arabic-squad/SHA256SUMS").read_text(encoding="utf-8").strip()}
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
