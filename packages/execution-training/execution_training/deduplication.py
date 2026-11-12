"""Deterministic content deduplication without changing code, labels or identifiers.

Unicode normalization, case folding and whitespace rewriting are deliberately NOT
used for exact hashes: they can change execution semantics. Near matches are
grouping evidence, never permission to discard a verified target.
"""
from __future__ import annotations

from dataclasses import dataclass
import math
import re
from typing import Iterable

from .common import canonical_json, digest
from .errors import TrainingError
from .schemas import TrainingExample
from .tokenization import render_prompt


def content_payload(example: TrainingExample, *, include_target: bool = True) -> dict:
    """Use EXACTLY the rendered model input; evidence cannot distinguish labels.

    This shared renderer prevents verification-only metadata (including repair
    regression evidence) from making identical prompts appear to be different
    tasks. Full provenance and evidence still live in immutable sample hashes and
    preparation audit metadata, separately from this semantic identity.
    """
    result = {"prompt": render_prompt(example)}
    if include_target:
        result["expected_output"] = example.expected_output
    return result


def canonical_sample_hash(example: TrainingExample) -> str:
    return digest(content_payload(example))


def family_keys(example: TrainingExample) -> tuple[str, str]:
    return ("project:" + example.project_family, "template:" + example.template_family)


@dataclass(frozen=True)
class DeduplicationResult:
    kept: tuple[TrainingExample, ...]
    exact_duplicates: dict[str, str]
    near_duplicate_pairs: tuple[tuple[str, str], ...]
    family_links: tuple[tuple[str, str], ...]
    near_detection_complete: bool
    comparisons: int

    def audit_dict(self) -> dict:
        return {
            "algorithm": "exact-canonical-json-and-token-shingle-jaccard-v1",
            "kept_ids": [sample.sample_id for sample in self.kept],
            "exact_duplicates": dict(sorted(self.exact_duplicates.items())),
            "near_duplicate_pairs": [list(pair) for pair in self.near_duplicate_pairs],
            "family_links": [list(pair) for pair in self.family_links],
            "near_detection_complete": self.near_detection_complete,
            "comparisons": self.comparisons,
        }


def _shingles(example: TrainingExample, width: int = 4) -> frozenset[tuple[str, ...]]:
    # Whitespace may vary in near matches; names, values and punctuation survive.
    tokens = re.findall(r"\w+|[^\w\s]", canonical_json(content_payload(example)))
    if len(tokens) > 100_000:
        raise TrainingError("NEAR_DEDUP_LIMIT", "A sample exceeds the bounded shingle token limit.")
    if len(tokens) < width:
        return frozenset({tuple(tokens)})
    return frozenset(tuple(tokens[i:i + width]) for i in range(len(tokens) - width + 1))


def deduplicate(
    examples: Iterable[TrainingExample], *, near_threshold: float | None = 0.92,
    max_comparisons: int = 250_000,
) -> DeduplicationResult:
    """Keep one exact task/target; link near matches for leakage-safe splitting.

    Conflicting targets fail the preparation run instead of picking a label.
    Candidate comparisons are bounded; exceeding the limit fails explicitly.
    Disabling near detection is explicit and is recorded in the audit result.
    Pass ``family_links`` and ``near_duplicate_pairs`` to split construction.
    """
    if near_threshold is not None and (type(near_threshold) not in (int, float) or not math.isfinite(near_threshold) or not 0 < near_threshold <= 1):
        raise TrainingError("INVALID_DEDUP_CONFIG", "near_threshold must be in (0, 1].")
    if type(max_comparisons) is not int or max_comparisons < 1:
        raise TrainingError("INVALID_DEDUP_CONFIG", "max_comparisons must be a positive integer.")
    records = sorted(examples, key=lambda item: item.sample_id)
    ids = [item.sample_id for item in records]
    if len(ids) != len(set(ids)):
        raise TrainingError("DUPLICATE_SAMPLE_ID", "Sample identifiers must be unique before deduplication.")
    by_content: dict[str, TrainingExample] = {}
    input_targets: dict[str, str] = {}
    duplicates: dict[str, str] = {}
    links: set[tuple[str, str]] = set()
    for example in records:
        input_hash = digest(content_payload(example, include_target=False))
        target_hash = digest(example.expected_output)
        if input_hash in input_targets and input_targets[input_hash] != target_hash:
            raise TrainingError("CONFLICTING_LABELS", "Identical task inputs have different verified targets; manual adjudication is required.")
        input_targets[input_hash] = target_hash
        content_hash = canonical_sample_hash(example)
        existing = by_content.get(content_hash)
        if existing is None:
            by_content[content_hash] = example
            continue
        duplicates[example.sample_id] = existing.sample_id
        for key in family_keys(example):
            links.add(tuple(sorted((family_keys(existing)[0], key))))

    kept = tuple(sorted(by_content.values(), key=lambda item: item.sample_id))
    if near_threshold is None:
        return DeduplicationResult(kept, duplicates, (), tuple(sorted(links)), False, 0)

    fingerprints = [_shingles(example) for example in kept]
    inverted: dict[tuple[str, ...], list[int]] = {}
    pairs: list[tuple[str, str]] = []
    comparisons = 0
    for index, fingerprint in enumerate(fingerprints):
        candidates: set[int] = set()
        for shingle in fingerprint:
            candidates.update(inverted.get(shingle, ()))
        for previous in sorted(candidates):
            other = fingerprints[previous]
            if min(len(fingerprint), len(other)) / max(len(fingerprint), len(other), 1) < near_threshold:
                continue
            comparisons += 1
            if comparisons > max_comparisons:
                raise TrainingError("NEAR_DEDUP_LIMIT", "Near-duplicate comparison budget exhausted; increase it explicitly or use an audited external grouper.")
            union = fingerprint | other
            similarity = len(fingerprint & other) / max(len(union), 1)
            if similarity >= near_threshold:
                pairs.append((kept[previous].sample_id, kept[index].sample_id))
        for shingle in fingerprint:
            inverted.setdefault(shingle, []).append(index)
    return DeduplicationResult(kept, duplicates, tuple(pairs), tuple(sorted(links)), True, comparisons)
