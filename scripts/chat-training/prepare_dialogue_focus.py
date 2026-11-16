"""Prepare an optional second-stage curriculum from frozen training rows only.

No labels are authored, predictions read, weights loaded, training run or stage
activated. The former development cases become checkpoint-selection validation.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
V3 = ROOT / "artifacts/chat-training/conversation-v3/dataset"
V1 = ROOT / "artifacts/chat-training/conversation-v1"
RUN = ROOT / "artifacts/execution-model-runs/text-b3-ar-2026-11-15"
EXPECTED = {
    "v3_train": "f638f3c8ec90429cc92dd09d3c90562fc4981c6fe7388b48b3ad17b9d294d4e8",
    "v3_validation": "054d3f42a41d1df4302e0fb5bad638b29372fb06ec769a2bc4be3451c0dec23c",
    "v1_validation": "ff2cfc10ee46776db0eb6fb2b5fe99e2055818eca33d4292daf6de1b7e793b6f",
}
KEEP_ALL = {"authored_card", "authored_dialogue", "agent_authored_dialogue_v3", "systematic_template"}


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def text_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def read(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def helpers():
    spec = importlib.util.spec_from_file_location("dialogue_v3_helpers", Path(__file__).with_name("prepare_dialogue_v3.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def choose(rows: list[dict], source: str, language: str, limit: int) -> list[dict]:
    candidates = [row for row in rows if row["source"] == source and row["language"] == language]
    return sorted(candidates, key=lambda row: (text_hash("dialogue-focus-v1-select:" + source + ":" + language + ":" + row["id"]), row["id"]))[:limit]


def quantiles(values: list[int]) -> dict:
    ordered = sorted(values)
    return {str(q): ordered[math.ceil(q * len(ordered)) - 1] for q in (0.5, 0.9, 0.95, 0.99, 1.0)}


def build(destination: Path) -> dict:
    if destination.exists():
        raise RuntimeError("Frozen output must never be overwritten.")
    h = helpers()
    files = {"v3_train": V3 / "train.jsonl", "v3_validation": V3 / "validation.jsonl", "v1_validation": V1 / "dataset/validation.jsonl"}
    source_hashes = {name: digest(path) for name, path in files.items()}
    if source_hashes != EXPECTED:
        raise RuntimeError("Frozen source hash differs from the approved parent datasets.")
    source = {name: read(path) for name, path in files.items()}
    all_authored = [row for row in source["v3_train"] if row["source"] in KEEP_ALL]
    if len(all_authored) != 1062:
        raise RuntimeError("Unexpected authored/replay parent count.")
    oa_arabic = [row for row in source["v3_train"] if row["source"] == "openassistant_human_train" and row["language"] == "ar"]
    if len(oa_arabic) != 5:
        raise RuntimeError("Unexpected Arabic OASST source count.")
    validation, seen_ids, seen_prompts, dedup = [], {}, {}, Counter()
    for origin in ("v3_validation", "v1_validation"):
        for row in source[origin]:
            duplicate = seen_ids.get(row["id"]) or seen_prompts.get(row["prompt"])
            if duplicate is not None:
                if duplicate["target"] != row["target"]:
                    raise RuntimeError("Conflicting labels encountered during validation deduplication.")
                dedup[origin] += 1
                continue
            seen_ids[row["id"]] = row
            seen_prompts[row["prompt"]] = row
            validation.append(dict(row))
    # Read only IDs from former development INPUT cases to prove inclusion.
    # No development predictions or model-output files are opened.
    former_cases_path = V1 / "development-cases.jsonl"
    former_ids = {row["id"] for row in read(former_cases_path)}
    if len(former_ids) != 84 or not former_ids <= {row["id"] for row in validation}:
        raise RuntimeError("The former 84 development cases are not all present in validation.")
    reserved_families = {h.family(m["content"]) for r in validation for m in r["messages"] if m["role"] == "user"}
    reserved_targets = {h.key(r["target"]) for r in validation}
    blocked_groups = {row.get("group", row["id"]) for row in source["v3_train"]
                      if h.key(row["target"]) in reserved_targets or any(h.family(m["content"]) in reserved_families for m in row["messages"] if m["role"] == "user")}
    blocked = [row for row in source["v3_train"] if row.get("group", row["id"]) in blocked_groups]
    eligible = [row for row in source["v3_train"] if row.get("group", row["id"]) not in blocked_groups]
    if any(row.get("group", row["id"]) in blocked_groups for row in all_authored + oa_arabic):
        raise RuntimeError("A mandatory row conflicts with the requested validation union.")
    train = (all_authored + choose(eligible, "openassistant_human_train", "en", 256) + oa_arabic
             + choose(eligible, "aya_train", "ar", 128) + choose(eligible, "aya_train", "en", 128))
    encoder = h.TextEncoder(RUN)
    if encoder.tokenizer.identity != "e8f06d0cfbf0c37723d64d9c1076d6a6f0cb7ced706ea19ea50ba82f775ec448":
        raise RuntimeError("Unexpected tokenizer identity.")
    for split, rows in (("train", train), ("validation", validation)):
        if len({row["id"] for row in rows}) != len(rows) or len({row["prompt"] for row in rows}) != len(rows):
            raise RuntimeError(f"Duplicate {split} ID or exact prompt.")
        for row in rows:
            if h.conversation_prompt(row["messages"]) != row["prompt"]:
                raise RuntimeError("Conversation framing changed.")
            tokens_in, tokens_out = len(encoder.encode(row["prompt"])), len(encoder.encode(row["target"])) + 1
            if tokens_in + 192 > 1024 or tokens_out > 192 or tokens_in + tokens_out > 1024:
                raise RuntimeError(f"Full row exceeds default runtime reserve: {row['id']}")
            row.update(input_tokens=tokens_in, answer_tokens=tokens_out, total_tokens=tokens_in + tokens_out)
        rows.sort(key=lambda row: text_hash("dialogue-focus-v1-order:" + row["id"]))
    checks = {
        "exact_id_overlap": len({r["id"] for r in train} & {r["id"] for r in validation}),
        "normalized_prompt_overlap": len({h.key(r["prompt"]) for r in train} & {h.key(r["prompt"]) for r in validation}),
        "normalized_target_overlap": len({h.key(r["target"]) for r in train} & {h.key(r["target"]) for r in validation}),
        "normalized_user_family_overlap": len({h.family(m["content"]) for r in train for m in r["messages"] if m["role"] == "user"}
                                              & {h.family(m["content"]) for r in validation for m in r["messages"] if m["role"] == "user"}),
        "source_group_overlap": len({r["group"] for r in train if r.get("group")} & {r["group"] for r in validation if r.get("group")}),
        "source_tree_overlap": len({r["source_tree_id"] for r in train if r.get("source_tree_id")} & {r["source_tree_id"] for r in validation if r.get("source_tree_id")}),
    }
    if any(checks.values()):
        raise RuntimeError(f"Train/validation overlap: {checks}")
    # Preserve every selected parent training row's label, source identity and grouping.
    by_id = {row["id"]: row for row in read(files["v3_train"])}
    for row in train:
        if row != by_id[row["id"]]:
            raise RuntimeError("A selected parent training row was changed.")
    if source_hashes != {name: digest(path) for name, path in files.items()}:
        raise RuntimeError("A frozen source changed during preparation.")
    manifest = {
        "schema_version": 1, "curriculum": "mohassan-conversation-v3-dialogue-focus", "stage_status": "optional_prepared_only",
        "created_at": datetime.now(timezone.utc).isoformat(), "training_run": False, "activated": False, "gpu_used": False,
        "source_files": {name: {"path": str(path.relative_to(ROOT)), "sha256": source_hashes[name], "rows": len(source[name])} for name, path in files.items()},
        "parent_v3_manifest_sha256": digest(V3 / "manifest.json"), "build_script_sha256": digest(Path(__file__)),
        "normalization_helper_sha256": digest(Path(h.__file__)), "tokenizer_identity": encoder.tokenizer.identity,
        "tokenizer_sha256": digest(RUN / "tokenizer.json"),
        "selection": {"all_authored_and_bounded_systematic_rows": 1062, "english_oasst_cap": 256, "arabic_oasst_all": 5,
                      "aya_replay_per_language": 128, "selection_order": "SHA256('dialogue-focus-v1-select:' + source + ':' + language + ':' + id), then id",
                      "before_optional_selection": "Exclude entire source groups sharing any normalized user-message family or normalized target with validation; then deterministically fill the requested caps from eligible rows.",
                      "excluded_source_groups": len(blocked_groups), "excluded_source_rows": len(blocked),
                      "excluded_source_ids": sorted(row["id"] for row in blocked),
                      "eligible_source_language_counts": dict(Counter(row["source"] + ":" + row["language"] for row in eligible)),
                      "validation": "V3 validation followed by V1 validation, exact prompt or ID deduplicated; conflicting duplicate labels abort.",
                      "validation_deduplicated_rows": dict(dedup), "train_rows_unchanged_from_v3": True,
                      "new_labels_created": False, "language_oversampling": False},
        "validation_role": {"use": "checkpoint_selection_and_development_only", "independent_final_test": False,
                            "former_development_cases_included": 84, "former_development_case_ids_all_in_validation": True,
                            "former_development_input_file_sha256": digest(former_cases_path),
                            "explicit_notice": "The previously reused 84 development examples now participate directly in checkpoint selection. They must never be reported as an independent final test."},
        "audit": checks, "context": 1024, "reserved_generation_tokens": 192, "answer_limit_including_eos": 192,
        "answers_or_histories_truncated": False, "framing": "Mohassan chat v1\\n + compact JSON messages + \\nAssistant:\\n",
        "development_predictions_read": False, "final_holdout_read": False, "active_or_frozen_weights_modified": False,
        "limitations": ["Preparation does not establish improved quality; this optional stage has not been activated or trained.",
                       "The reduced source mix sacrifices broad instruction coverage and increases authored/template concentration.",
                       "Only five human Arabic OASST training examples are available; sampling does not create new language variety.",
                       "Inherited source-quality limitations from V3 remain; annotations are not comprehensively verified.",
                       "Reused development validation can guide checkpoint choice but cannot provide an independent readiness claim.",
                       "Exact, normalized-family and group checks do not rule out all semantic paraphrase overlap."], "splits": {}}
    destination.mkdir(parents=True, exist_ok=False)
    for split, rows in (("train", train), ("validation", validation)):
        data = ("\n".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in rows) + "\n").encode("utf-8")
        (destination / (split + ".jsonl")).write_bytes(data)
        manifest["splits"][split] = {"rows": len(rows), "unique_ids": len({r["id"] for r in rows}),
                                     "unique_exact_prompts": len({r["prompt"] for r in rows}),
                                     "unique_normalized_prompts": len({h.key(r["prompt"]) for r in rows}),
                                     "unique_normalized_targets": len({h.key(r["target"]) for r in rows}),
                                     "unique_existing_groups": len({r["group"] for r in rows if r.get("group")}),
                                     "languages": dict(Counter(r["language"] for r in rows)), "sources": dict(Counter(r["source"] for r in rows)),
                                     "source_language_counts": dict(Counter(r["source"] + ":" + r["language"] for r in rows)),
                                     "history_lengths": dict(Counter(len(r["messages"]) for r in rows)),
                                     "multiturn_rows": sum(len(r["messages"]) > 1 for r in rows),
                                     "max_input_tokens": max(r["input_tokens"] for r in rows), "max_answer_tokens": max(r["answer_tokens"] for r in rows),
                                     "sequence_token_quantiles": quantiles([r["total_tokens"] for r in rows]),
                                     "input_tokens": sum(r["input_tokens"] for r in rows), "answer_tokens": sum(r["answer_tokens"] for r in rows),
                                     "sha256": hashlib.sha256(data).hexdigest()}
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/chat-training/conversation-v3-dialogue-focus/dataset")
    args = parser.parse_args()
    result = build(args.output)
    print(json.dumps({"output": str(args.output), "splits": result["splits"], "audit": result["audit"], "validation_role": result["validation_role"]}, ensure_ascii=True, indent=2))
