"""Bounded, reproducible local experiment: data -> scratch tokenizer -> training -> export.

Every step writes into one explicit run directory (under the git-ignored
``artifacts/``) and records hashes. Nothing is downloaded and nothing is published.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import PACKAGES_ROOT  # noqa: F401

from execution_model.config import ARCHITECTURE_VERSION
from execution_model.tokenizer import ByteBPETokenizer
from execution_training.common import atomic_json, digest
from execution_training.configuration import preset_config
from execution_training.curriculum import CurriculumPlan
from execution_training.deduplication import canonical_sample_hash
from execution_training.dataset import PreparedDataset, load_dataset, prepare_dataset
from execution_training.privacy import PrivacyPolicy
from execution_training.provenance import LocalEvidenceStore
from execution_training.schemas import TrainingExample, UsageAuthorization
from execution_training.synthetic import DOMAINS, generate_synthetic, synthetic_family_plan
from execution_training.tokenization import TokenizerAdapter, encode_example, render_prompt
from execution_training.training import train

from .bridge import Phase2TokenizerBridge, execution_model_factory, resolve_model_config
from .repair import generate_repairs

COLLECTED_AT = "2026-11-12T00:00:00Z"
DATASET_VERSION = "execution-synthetic-2026-11-12"
SPLIT_SEED = 17
# Owner-run local experiment over generated, non-customer synthetic data. This is the
# authorization *record*; publication of the dataset still needs explicit approval.
AUTHORIZATION = UsageAuthorization(
    license_id="mohassan-project-synthetic", authorization_reference="docs/EXECUTION-MODEL-REPORT-2026-11-12.md#data",
    authorized_by="repository-owner-local-experiment", permitted_uses=("training", "validation", "evaluation"),
    rights_verified=True, privacy_classification="synthetic", privacy_approval_reference=None, expires_at=None)
# Variants are value-disjoint instance sets of the same templates; offsets keep
# generated identifiers disjoint too.
VARIANTS = {"train": ("training", 0, 1001), "validation": ("validation", 50_000, 2002), "heldout": ("test", 90_000, 3003)}


@dataclass(frozen=True)
class DataCounts:
    train_per_domain: int = 300
    validation_per_domain: int = 10
    heldout_per_domain: int = 25


def _reservations() -> dict[str, str]:
    result: dict[str, str] = {}
    split = {"train": "train", "validation": "validation", "heldout": "test"}
    for variant in VARIANTS:
        for families in synthetic_family_plan().values():
            for key in ("project_family", "template_family"):
                result[key.split("_")[0] + ":" + families[key] + ":" + variant] = split[variant]
        result["project:synthetic-repair-v1:" + variant] = split[variant]
        result["template:synthetic-repair-v1:" + variant] = split[variant]
    return result


def build_dataset(run: Path, counts: DataCounts) -> dict[str, Any]:
    store = LocalEvidenceStore(run / "evidence")
    examples: list[TrainingExample] = []
    seen_content: set[str] = set()
    dropped: dict[str, dict[str, int]] = {}
    started = time.perf_counter()
    for variant, (scope, offset, seed) in VARIANTS.items():
        count = {"train": counts.train_per_domain, "validation": counts.validation_per_domain,
                 "heldout": counts.heldout_per_domain}[variant]
        batch = list(generate_synthetic(seed=seed, count_per_domain=count, authorization=AUTHORIZATION,
                                        evidence_store=store, collected_at=COLLECTED_AT,
                                        evidence_scope_by_domain={domain: scope for domain in DOMAINS},
                                        family_variant=variant, index_start=offset))
        batch += generate_repairs(seed=seed, count=count, authorization=AUTHORIZATION, evidence_store=store,
                                  collected_at=COLLECTED_AT, family_variant=variant, scope=scope, index_start=offset)
        # Low-cardinality domains (e.g. 3 missing-context variants) cannot have unseen
        # instances. An exact repeat of an earlier split's task is dropped from the
        # later split and counted, never presented as held-out.
        for example in batch:
            content = canonical_sample_hash(example)
            if variant != "train" and content in seen_content:
                dropped.setdefault(variant, {}).setdefault(example.task_family, 0)
                dropped[variant][example.task_family] += 1
                continue
            seen_content.add(content)
            examples.append(example)
    # Near-duplicate linking is explicitly disabled and recorded in the audit: variants
    # are the SAME templates with different values by design. Exact duplicates are
    # still detected, and any exact duplicate across splits fails as SPLIT_LEAKAGE.
    dataset = prepare_dataset(examples, dataset_version=DATASET_VERSION, evidence_resolver=store,
                              privacy_policy=PrivacyPolicy(), seed=SPLIT_SEED,
                              reserved_families=_reservations(), near_threshold=None)
    dataset.write(run / "dataset")
    targets = {split: {e.target_hash for e in dataset.for_split(split)} for split in ("train", "validation", "test")}
    summary = {
        "dataset_version": DATASET_VERSION, "dataset_identity": dataset.identity,
        "generated_examples": len(examples), "kept_examples": len(dataset.examples),
        "dropped_exact_repeats_of_earlier_split": dropped,
        "exact_duplicates_removed": len(dataset.preparation_audit["deduplication"]["exact_duplicates"]),
        "splits": {split: len(dataset.for_split(split)) for split in ("train", "validation", "test")},
        "families": sorted({e.task_family for e in dataset.examples}),
        "target_overlap_train_test": len(targets["train"] & targets["test"]),
        "target_overlap_train_validation": len(targets["train"] & targets["validation"]),
        "near_duplicate_detection": "disabled (same-template value variants; recorded in preparation audit)",
        "generation_seconds": round(time.perf_counter() - started, 2),
        "provenance": "local deterministic generators execution-synthetic-v1 and execution-repair-v1; no external source",
    }
    atomic_json(run / "dataset-summary.json", summary, immutable=True)
    return summary


def load_run_dataset(run: Path) -> tuple[PreparedDataset, LocalEvidenceStore]:
    store = LocalEvidenceStore(run / "evidence")
    return load_dataset(run / "dataset", evidence_resolver=store, privacy_policy=PrivacyPolicy()), store


def train_tokenizer(run: Path, target_vocab_size: int = 8192, *, max_token_bytes: int = 256,
                    isolate_digits: bool = False) -> dict[str, Any]:
    """Learned ONLY from training-split text; validation and test never reach it."""
    dataset, _ = load_run_dataset(run)
    corpus = [render_prompt(example) + example.expected_output for example in dataset.for_split("train")]
    started = time.perf_counter()
    tokenizer = ByteBPETokenizer.train(corpus, target_vocab_size=target_vocab_size, max_corpus_bytes=33_554_432,
                                       max_token_bytes=max_token_bytes, isolate_digits=isolate_digits)
    tokenizer.save((run / "tokenizer.json").resolve())
    summary = {"identity": tokenizer.identity, "vocab_size": tokenizer.vocab_size,
               "target_vocab_size": target_vocab_size, "max_token_bytes": max_token_bytes,
               "isolate_digits": isolate_digits, "corpus_records": len(corpus),
               "corpus_bytes": sum(len(text.encode("utf-8")) for text in corpus),
               "training_seconds": round(time.perf_counter() - started, 2), "source": "training split only"}
    atomic_json(run / "tokenizer-summary.json", summary, immutable=True)
    return summary


def load_tokenizer(run: Path) -> ByteBPETokenizer:
    return ByteBPETokenizer.load((run / "tokenizer.json").resolve())


def token_lengths(run: Path, context_length: int = 1024) -> dict[str, Any]:
    dataset, _ = load_run_dataset(run)
    adapter = TokenizerAdapter(Phase2TokenizerBridge(load_tokenizer(run)))
    lengths = {}
    for split in ("train", "validation", "test"):
        values = sorted(len(encode_example(e, adapter, context_length).input_ids) for e in dataset.for_split(split))
        lengths[split] = {"count": len(values), "min": values[0], "median": values[len(values) // 2], "max": values[-1],
                          "total": sum(values)}
    return lengths


def run_training(run: Path, *, preset: str = "17m", processed_tokens: int, context_length: int,
                 output_name: str = "training", step_limit: int | None = None, **overrides: Any) -> dict[str, Any]:
    dataset, store = load_run_dataset(run)
    adapter = TokenizerAdapter(Phase2TokenizerBridge(load_tokenizer(run)))
    curriculum = CurriculumPlan.for_budget(processed_tokens, ("A", "B", "C"))
    settings = dict(device="cuda", precision="auto", max_processed_tokens=processed_tokens,
                    context_length=context_length, warmup_tokens=max(1, processed_tokens // 50),
                    checkpoint_interval_steps=1_000_000, validation_interval_steps=250, validation_batches=16,
                    deterministic_algorithms=False, profile_enabled=True, gradient_accumulation_steps=8,
                    microbatch_size=1)
    settings.update(overrides)
    config = preset_config(preset, architecture_id=ARCHITECTURE_VERSION, **settings)
    started = time.perf_counter()
    report = train(config=config, dataset=dataset, evidence_resolver=store, privacy_policy=PrivacyPolicy(),
                   curriculum=curriculum, tokenizer=adapter, model_factory=execution_model_factory,
                   output_directory=run / output_name, handle_signals=False, optimizer_step_limit=step_limit)
    report["wall_seconds_measured_by_pipeline"] = round(time.perf_counter() - started, 2)
    atomic_json(run / output_name / "pipeline-wall-time.json",
                {"wall_seconds": report["wall_seconds_measured_by_pipeline"]})
    return report


def model_config_for(run: Path, *, preset: str, context_length: int, seed: int = 1729):
    from execution_training.model_factory import ModelRequest
    tokenizer = load_tokenizer(run)
    return resolve_model_config(ModelRequest(ARCHITECTURE_VERSION, preset, seed, tokenizer.vocab_size, context_length))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, default=str) + "\n", encoding="utf-8")


def fingerprint(value: Any) -> str:
    return digest(value)
