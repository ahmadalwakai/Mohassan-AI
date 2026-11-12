"""Fail-closed held-out project/template and duplicate protection, without model calls."""
from __future__ import annotations

from dataclasses import dataclass
import math
import re
import unicodedata
from typing import Any, Iterable, Mapping

from .common import canonical_json, digest, to_jsonable
from .dataset import immutable_task_hash, public_input
from .schemas import EvaluationTask


@dataclass(frozen=True)
class CorpusRecord:
    record_id: str
    source_split: str
    project_family: str
    template_family: str
    public_input: dict[str, Any]
    response_hash: str
    source_manifest_hash: str
    authorization_reference: str
    authorized_uses: tuple[str, ...]
    evaluation_origin: bool = False
    parent_ids: tuple[str, ...] = ()

    def validate(self) -> None:
        for name in ("record_id", "project_family", "template_family", "authorization_reference"):
            if not isinstance(getattr(self, name), str) or not getattr(self, name).strip():
                raise ValueError(f"Corpus record requires {name}.")
        if self.source_split not in {"training", "reference", "validation", "evaluation", "holdout"}:
            raise ValueError("Unknown corpus split.")
        for name in ("response_hash", "source_manifest_hash"):
            if not isinstance(getattr(self, name), str) or re.fullmatch(r"[a-f0-9]{64}", getattr(self, name)) is None:
                raise ValueError(f"Invalid corpus {name}.")
        if type(self.evaluation_origin) is not bool:
            raise ValueError("evaluation_origin must be explicit boolean.")
        if not isinstance(self.authorized_uses, (list, tuple)) or not self.authorized_uses or any(value not in {"training", "retrieval", "validation"} for value in self.authorized_uses):
            raise ValueError("Corpus authorization must explicitly identify permitted use.")
        if not isinstance(self.parent_ids, (list, tuple)) or any(not isinstance(value, str) or not value for value in self.parent_ids):
            raise ValueError("Invalid corpus parent identifiers.")
        if set(self.public_input) != set(public_input(self.public_input)):
            raise ValueError("Corpus public input contains fields outside the safe projection.")


@dataclass(frozen=True)
class DuplicatePair:
    evaluation_id: str
    other_id: str
    kind: str
    similarity: float


@dataclass(frozen=True)
class SplitAudit:
    schema_version: str
    evaluation_manifest_hash: str
    evaluation_inventory_hash: str
    corpus_hash: str
    inventory_reference: str | None
    inventory_complete: bool
    near_detection_complete: bool
    project_isolation: bool
    template_isolation: bool
    clean: bool
    comparisons: int
    near_threshold: float
    duplicate_pairs: tuple[DuplicatePair, ...]
    issues: tuple[str, ...]
    warnings: tuple[str, ...]
    evaluation_public_inputs: tuple[tuple[str, str], ...]
    corpus_record_hashes: tuple[tuple[str, str], ...]


def corpus_hash(records: Iterable[CorpusRecord]) -> str:
    return digest(sorted((to_jsonable(record) for record in records), key=lambda item: item["record_id"]))


def evaluation_inventory_hash(tasks: Iterable[EvaluationTask]) -> str:
    return digest(sorted(({"task_id": task.task_id, "immutable_hash": immutable_task_hash(task),
                           "public_input_hash": digest(public_input(task))} for task in tasks),
                         key=lambda item: item["task_id"]))


def _shingles(value: Mapping[str, Any], max_tokens: int) -> frozenset[tuple[str, ...]]:
    # Near matching is a contamination screen only: normalized text is never executed.
    tokens = re.findall(r"\w+|[^\w\s]", unicodedata.normalize("NFKC", canonical_json(value)).casefold())
    if len(tokens) > max_tokens:
        raise ValueError("NEAR_DUPLICATE_TOKEN_LIMIT")
    return frozenset(tuple(tokens[index:index + 4]) for index in range(max(1, len(tokens) - 3)))


def audit_splits(
    tasks: Iterable[EvaluationTask], records: Iterable[CorpusRecord], *,
    evaluation_manifest_hash: str, pinned_corpus_hash: str,
    inventory_complete: bool, inventory_reference: str | None,
    near_threshold: float = 0.92, max_comparisons: int = 250_000,
    max_tokens_per_record: int = 100_000,
) -> SplitAudit:
    """Audit the *complete disclosed* training/reference inventory against evaluation.

    Completeness and authorization are externally attested, never inferred from an
    empty list. A partial near scan remains unclean. No task, answer or failure is
    written to training storage. Every suspicious pair blocks an unqualified clean
    claim; adjudication requires a new, reviewed dataset/inventory version.
    """
    if type(inventory_complete) is not bool:
        raise ValueError("inventory_complete must be explicit boolean.")
    if isinstance(near_threshold, bool) or not isinstance(near_threshold, (int, float)) or not math.isfinite(near_threshold) or not 0 < near_threshold <= 1:
        raise ValueError("near_threshold must be in (0, 1].")
    if type(max_comparisons) is not int or max_comparisons < 1 or type(max_tokens_per_record) is not int or max_tokens_per_record < 1:
        raise ValueError("Duplicate scan limits must be positive integers.")
    for name, value in (("evaluation_manifest_hash", evaluation_manifest_hash), ("pinned_corpus_hash", pinned_corpus_hash)):
        if not isinstance(value, str) or re.fullmatch(r"[a-f0-9]{64}", value) is None:
            raise ValueError(f"Invalid {name}.")
    evaluation = tuple(sorted(tasks, key=lambda item: item.task_id))
    corpus = tuple(sorted(records, key=lambda item: item.record_id))
    issues: list[str] = []
    warnings: list[str] = ["Lexical similarity cannot rule out semantic contamination or undisclosed data."]
    if not evaluation:
        issues.append("EMPTY_EVALUATION_INVENTORY")
    if not inventory_complete or not inventory_reference:
        issues.append("CORPUS_INVENTORY_INCOMPLETE")
    actual_corpus_hash = corpus_hash(corpus)
    if actual_corpus_hash != pinned_corpus_hash:
        issues.append("CORPUS_DIGEST_MISMATCH")
    evaluation_ids = {task.task_id for task in evaluation}
    corpus_ids = {record.record_id for record in corpus}
    if len(evaluation_ids) != len(evaluation) or len(corpus_ids) != len(corpus):
        issues.append("DUPLICATE_RECORD_ID")
    if evaluation_ids & corpus_ids:
        issues.append("CROSS_SPLIT_ID_REUSE")
    eval_projects = {task.project_family for task in evaluation}
    eval_templates = {task.template_family for task in evaluation}
    project_isolation = not bool(eval_projects & {record.project_family for record in corpus})
    template_isolation = not bool(eval_templates & {record.template_family for record in corpus})
    if not project_isolation:
        issues.append("PROJECT_FAMILY_OVERLAP")
    if not template_isolation:
        issues.append("TEMPLATE_FAMILY_OVERLAP")
    for record in corpus:
        record.validate()
        if record.source_split in {"evaluation", "holdout"} or record.evaluation_origin:
            issues.append(f"EVALUATION_ORIGIN_IN_CORPUS:{record.record_id}")
        if evaluation_ids.intersection(record.parent_ids):
            issues.append(f"EVALUATION_DERIVATIVE_IN_CORPUS:{record.record_id}")
    eval_inputs = [(task.task_id, public_input(task)) for task in evaluation]
    corpus_inputs = [(record.record_id, record.public_input) for record in corpus]
    duplicate_pairs: list[DuplicatePair] = []
    comparisons = 0
    near_complete = True
    cache: dict[str, frozenset[tuple[str, ...]]] = {}

    def compare(left_id: str, left: dict[str, Any], right_id: str, right: dict[str, Any]) -> None:
        nonlocal comparisons, near_complete
        if comparisons >= max_comparisons:
            near_complete = False
            return
        comparisons += 1
        left_hash, right_hash = digest(left), digest(right)
        if left_hash == right_hash:
            duplicate_pairs.append(DuplicatePair(left_id, right_id, "exact_public_input", 1.0))
            return
        try:
            if left_hash not in cache:
                cache[left_hash] = _shingles(left, max_tokens_per_record)
            if right_hash not in cache:
                cache[right_hash] = _shingles(right, max_tokens_per_record)
        except ValueError:
            near_complete = False
            return
        left_tokens, right_tokens = cache[left_hash], cache[right_hash]
        union = left_tokens | right_tokens
        similarity = len(left_tokens & right_tokens) / len(union) if union else 1.0
        if similarity >= near_threshold:
            duplicate_pairs.append(DuplicatePair(left_id, right_id, "near_public_input", similarity))

    for index, (left_id, left) in enumerate(eval_inputs):
        for right_id, right in corpus_inputs:
            if comparisons >= max_comparisons:
                near_complete = False
                break
            compare(left_id, left, right_id, right)
        for right_id, right in eval_inputs[index + 1:]:
            if comparisons >= max_comparisons:
                near_complete = False
                break
            compare(left_id, left, right_id, right)
        if comparisons >= max_comparisons and index < len(eval_inputs) - 1:
            near_complete = False
            break
    if duplicate_pairs:
        issues.append("DUPLICATE_OR_NEAR_DUPLICATE_INPUT")
    if not near_complete:
        issues.append("NEAR_DUPLICATE_SCAN_INCOMPLETE")
    return SplitAudit("execution-split-audit-v1", evaluation_manifest_hash,
                      evaluation_inventory_hash(evaluation), actual_corpus_hash, inventory_reference,
                      inventory_complete, near_complete, project_isolation, template_isolation,
                      not issues, comparisons, near_threshold, tuple(duplicate_pairs), tuple(issues), tuple(warnings),
                      tuple((task.task_id, digest(public_input(task))) for task in evaluation),
                      tuple((record.record_id, digest(record)) for record in corpus))
