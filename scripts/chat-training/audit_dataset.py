"""Check conversation framing, split separation and model-context fit before training."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages/execution-pipeline"))
from execution_pipeline.chat import conversation_prompt, sha256_file
from execution_pipeline.ads_finetune import _load_payload, encode_pair


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    payload, encoder, config = _load_payload(args.run, args.run / "pretrain/best.pt")
    del payload
    summaries, prompts, identifiers, targets = {}, {}, set(), {}
    for split in ("train", "validation"):
        file = args.data / f"{split}.jsonl"
        rows = [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines() if line.strip()]
        if not rows:
            raise ValueError("Each split must be nonempty.")
        lengths, prompt_lengths, output_lengths, capabilities, languages = [], [], [], Counter(), Counter()
        prompts[split], targets[split] = set(), set()
        for row in rows:
            if row["id"] in identifiers:
                raise ValueError("Duplicate row ID.")
            identifiers.add(row["id"])
            prompt = conversation_prompt(row["messages"])
            if row["prompt"] != prompt or not isinstance(row["target"], str) or not row["target"].strip():
                raise ValueError("Training prompt differs from inference or target is empty.")
            if prompt in prompts[split]:
                raise ValueError("Duplicate conversation inside split.")
            prompts[split].add(prompt)
            targets[split].add(row["target"])
            tokens, _ = encode_pair(encoder, row)
            lengths.append(len(tokens))
            prompt_lengths.append(len(encoder.encode(prompt)))
            output_lengths.append(len(encoder.encode(row["target"])) + 1)
            if len(tokens) > config.max_context_length:
                raise ValueError(f"Row {row['id']} exceeds model context; no silent dropping.")
            if output_lengths[-1] > 192:
                raise ValueError(f"Row {row['id']} exceeds the runtime answer budget.")
            if prompt_lengths[-1] + 192 > config.max_context_length:
                raise ValueError(f"Row {row['id']} leaves insufficient context for the runtime answer budget.")
            if row["capability"] != "chat.reply.v1" or row["language"] not in {"ar", "en"}:
                raise ValueError("Unexpected capability or language metadata.")
            capabilities[row["capability"]] += 1
            languages[row["language"]] += 1
        summaries[split] = {"rows": len(rows), "sha256": sha256_file(file), "max_tokens": max(lengths),
                            "max_prompt_tokens": max(prompt_lengths),
                            "mean_tokens": round(sum(lengths) / len(lengths), 1),
                            "max_answer_tokens": max(output_lengths),
                            "answers_above_runtime_budget": sum(length > 192 for length in output_lengths),
                            "languages": dict(languages), "capabilities": dict(capabilities)}
    if prompts["train"] & prompts["validation"]:
        raise ValueError("Train/validation conversation leakage.")
    report = {"schemaVersion": 1, "passed": True, "splits": summaries,
              "exact_prompt_overlap": 0, "exact_target_overlap": len(targets["train"] & targets["validation"]),
              "context": config.max_context_length, "tokenizer_identity": encoder.tokenizer.identity,
              "base_checkpoint_sha256": sha256_file(args.run / "pretrain/best.pt"),
              "limits": "Exact split checks do not establish semantic independence or conversational quality."}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2, ensure_ascii=False)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
