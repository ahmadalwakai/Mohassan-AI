"""Small CPU-only development probe. Never reads final assessment cases or executes generated code."""
import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages/execution-pipeline"))
from execution_pipeline.ads_worker import AdsWorker


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--finetune", default="bilingual-code-v1")
    parser.add_argument("--per-group", type=int, default=4)
    parser.add_argument("--data-dir", default="artifacts/ads-training/bilingual-v1")
    args = parser.parse_args()
    if not 1 <= args.per_group <= 10:
        raise ValueError("Probe is bounded to 1-10 examples per group")
    import torch
    torch.set_num_threads(1)
    run = ROOT / "artifacts/execution-model-runs/text-b2-2026-11-12"
    data = (ROOT / args.data_dir / "validation.jsonl").resolve()
    groups = defaultdict(list)
    for line in data.read_text(encoding="utf-8").splitlines():
        record = json.loads(line)
        if record["capability"] == "ads.site.v2":
            continue
        group = ("code" if record["capability"].startswith("code.") else "ads", record["language"])
        groups[group].append(record)
    selected = []
    for group in sorted(groups):
        selected.extend(sorted(groups[group], key=lambda row: hashlib.sha256(row["id"].encode()).hexdigest())[:args.per_group])
    worker = AdsWorker(run.resolve(), "cpu", args.finetune)
    started, results = time.monotonic(), []
    for record in selected:
        candidate = worker.sample({"prompt": record["prompt"], "input": record["input"], "candidates": 1,
                                   "max_new_tokens": 160 if record["capability"].startswith("code.") else 96})[0]
        results.append({"id": record["id"], "language": record["language"], "capability": record["capability"],
                        "input": record["input"], "expected": record["output"], "target": record["target"],
                        "answer_text": candidate["text"], "finished": candidate["finished"],
                        "exact_source": candidate["finished"] and candidate["text"] == record["target"]})
        print(json.dumps({"done": len(results), "total": len(selected), "seconds": round(time.monotonic() - started, 1)}), flush=True)
    output = run / args.finetune / "development-probes"
    output.mkdir(exist_ok=True)
    path = output / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + ".json")
    payload = {"purpose": "development_only", "notFinalAssessment": True, "model": worker.handshake(),
               "dataset_sha256": hashlib.sha256(data.read_bytes()).hexdigest(),
               "exact_source_matches": sum(row["exact_source"] for row in results), "cases": len(results),
               "seconds": round(time.monotonic() - started, 1), "results": results}
    with path.open("x", encoding="utf-8") as stream:
        json.dump(payload, stream, ensure_ascii=False, indent=2)
    print(json.dumps({"output": str(path), "step": worker.step, "exact_source_matches": payload["exact_source_matches"], "cases": len(results)}))


if __name__ == "__main__":
    main()
