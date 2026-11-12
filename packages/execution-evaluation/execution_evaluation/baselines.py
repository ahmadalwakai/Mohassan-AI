"""Non-neural execution baselines. Candidates are data and are never executed here."""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, replace
import math
import re
import unicodedata
from typing import Any, Iterable, Protocol

from .common import canonical_json, digest, json_copy, to_jsonable
from .dataset import public_input
from .schemas import CandidateOutput, ExecutionRequest
from .splits import CorpusRecord, SplitAudit, corpus_hash


@dataclass(frozen=True)
class CompilerAssurance:
    """Trusted adapter review, not a self-assertion supplied by candidate/model data."""
    adapter_id: str
    compiler_version: str
    review_reference: str
    supported_transformations: tuple[str, ...]
    no_neural_calls: bool
    no_external_reasoning: bool
    no_network: bool
    no_code_execution: bool
    no_private_oracle_access: bool

    def validate(self) -> None:
        if not all(isinstance(value, str) and value.strip() for value in
                   (self.adapter_id, self.compiler_version, self.review_reference)):
            raise ValueError("Compiler adapter needs versioned identity and independent review.")
        if not self.supported_transformations or any(not isinstance(value, str) or not value for value in self.supported_transformations):
            raise ValueError("Compiler adapter must enumerate supported transformations.")
        if any(getattr(self, name) is not True for name in ("no_neural_calls", "no_external_reasoning", "no_network", "no_code_execution", "no_private_oracle_access")):
            raise ValueError("Compiler adapter does not satisfy deterministic baseline restrictions.")


class DeterministicCompilerBridge(Protocol):
    """Implement as a reviewed Phase 1 translation bridge; never a replacement compiler."""
    assurance: CompilerAssurance

    def supports(self, request: ExecutionRequest) -> bool: ...

    def compile(self, request: ExecutionRequest) -> CandidateOutput: ...


class DeterministicBaseline:
    def __init__(self, compiler: DeterministicCompilerBridge | None = None) -> None:
        self._compiler = compiler
        self._assurance_hash: str | None = None
        if compiler is not None:
            compiler.assurance.validate()
            self._assurance_hash = digest(compiler.assurance)

    @property
    def identity(self) -> dict[str, Any]:
        return {"arm_id": "deterministic-" + digest({"adapter": "deterministic-baseline-v1", "assurance_hash": self._assurance_hash}),
                "adapter_id": "deterministic-baseline-v1", "kind": "deterministic",
                "status": "ready" if self._compiler else "pending_phase1_bridge",
                "compiler": to_jsonable(self._compiler.assurance) if self._compiler else None,
                "assurance_hash": self._assurance_hash}

    def execute(self, request: ExecutionRequest) -> CandidateOutput:
        if self._compiler is None:
            return CandidateOutput("unavailable", reason="PHASE1_COMPILER_ADAPTER_UNAVAILABLE",
                                   metadata={"baseline": "deterministic", "integration_status": "pending"})
        if digest(self._compiler.assurance) != self._assurance_hash:
            return CandidateOutput("error", reason="COMPILER_ASSURANCE_CHANGED")
        if self._compiler.supports(request) is not True:
            return CandidateOutput("unsupported", reason="TRANSFORMATION_NOT_EXPLICITLY_SUPPORTED")
        # The reviewed bridge receives a public request only. This module imports no
        # Phase 1 internals and has no fallback business logic or subprocess launcher.
        result = self._compiler.compile(request)
        if not isinstance(result, CandidateOutput):
            return CandidateOutput("error", reason="INVALID_COMPILER_ADAPTER_RESPONSE")
        return replace(result, metadata={**json_copy(result.metadata), "baseline": "deterministic",
                                        "compiler_assurance_hash": self._assurance_hash})


@dataclass(frozen=True)
class FieldSubstitution:
    """A reviewed mapping from an input scalar to one existing structured JSON leaf.

    It never interpolates source text, templates, paths, operations or mutations.
    Strings require an explicit enumeration or an allowlisted identifier.
    """
    input_path: tuple[str, ...]
    output_path: tuple[str, ...]
    value_kind: str
    validation_reference: str
    allowed_values: tuple[str, ...] = ()
    minimum: int | None = None
    maximum: int | None = None

    def validate(self) -> None:
        if not self.validation_reference or not isinstance(self.validation_reference, str):
            raise ValueError("A substitution requires independent validation provenance.")
        for path in (self.input_path, self.output_path):
            if not path or len(path) > 16 or any(not isinstance(part, str) or not part or part in {"__proto__", "prototype", "constructor"} for part in path):
                raise ValueError("Invalid substitution field path.")
        if self.value_kind not in {"identifier", "enum", "integer", "boolean"}:
            raise ValueError("Only explicitly bounded scalar substitutions are supported.")
        if self.value_kind == "enum" and (not self.allowed_values or any(not isinstance(value, str) for value in self.allowed_values)):
            raise ValueError("String substitution requires explicit allowed values.")
        if self.value_kind == "integer" and (type(self.minimum) is not int or type(self.maximum) is not int or self.minimum > self.maximum):
            raise ValueError("Integer substitution requires ordered finite bounds.")


@dataclass(frozen=True)
class RetrievalExample:
    record: CorpusRecord
    output: CandidateOutput
    substitutions: tuple[FieldSubstitution, ...] = ()

    @property
    def reuse_hash(self) -> str:
        # Pin validation mappings together with the candidate, not merely its text.
        return retrieval_payload_hash(self.output, self.substitutions)


def retrieval_payload_hash(output: CandidateOutput, substitutions: Iterable[FieldSubstitution] = ()) -> str:
    """Calculate a CorpusRecord.response_hash before constructing its example."""
    return digest({"output": output, "substitutions": tuple(substitutions)})


def _terms(value: dict[str, Any]) -> Counter[str]:
    # Count lexical terms in the complete public projection. No embeddings or API.
    text = unicodedata.normalize("NFKC", canonical_json(value)).casefold()
    return Counter(re.findall(r"\w+", text))


def _cosine(left: Counter[str], right: Counter[str]) -> float:
    numerator = sum(count * right.get(term, 0) for term, count in left.items())
    denominator = math.sqrt(sum(count * count for count in left.values()) * sum(count * count for count in right.values()))
    return numerator / denominator if denominator else 0.0


def _lookup(value: dict[str, Any], path: tuple[str, ...]) -> Any:
    current: Any = value
    for part in path:
        if not isinstance(current, dict) or part not in current:
            raise ValueError("Substitution field is absent.")
        current = current[part]
    return current


def _adapt(example: RetrievalExample, task: dict[str, Any]) -> CandidateOutput:
    output = example.output
    if not isinstance(output.content, dict) or output.output_language not in {"json", "JSON"} or output.mutations or output.operations:
        raise ValueError("Only standalone JSON content admits validated substitution.")
    content = json_copy(output.content)
    seen: set[tuple[str, ...]] = set()
    for rule in example.substitutions:
        rule.validate()
        if rule.output_path in seen:
            raise ValueError("Multiple substitutions target the same field.")
        seen.add(rule.output_path)
        value = _lookup(task["input_specification"], rule.input_path)
        old_value = _lookup(content, rule.output_path)
        if rule.value_kind == "identifier":
            if not isinstance(value, str) or re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]{0,127}", value) is None or value not in task["allowed_symbols"]:
                raise ValueError("Identifier is not an explicitly allowed symbol.")
        elif rule.value_kind == "enum":
            if not isinstance(value, str) or value not in rule.allowed_values:
                raise ValueError("Substitution value is outside its reviewed enumeration.")
        elif rule.value_kind == "integer":
            if type(value) is not int or not rule.minimum <= value <= rule.maximum:  # type: ignore[operator]
                raise ValueError("Integer substitution is outside its reviewed bounds.")
        elif type(value) is not bool:
            raise ValueError("Boolean substitution requires a boolean.")
        if type(old_value) is not type(value):
            raise ValueError("Substitution cannot change a field's scalar type.")
        parent = content if len(rule.output_path) == 1 else _lookup(content, rule.output_path[:-1])
        parent[rule.output_path[-1]] = value
    return replace(output, content=content)


class RetrievalBaseline:
    """Deterministic lexical reuse from a pinned authorized reference snapshot.

    A copied nearest-neighbor candidate may be wrong for a new task. Only independent
    verification can establish correctness; retrieval never claims novel generation.
    """
    def __init__(self, examples: Iterable[RetrievalExample], *, split_audit: SplitAudit,
                 pinned_corpus_hash: str, minimum_similarity: float = 0.5, top_k: int = 5) -> None:
        if isinstance(minimum_similarity, bool) or not isinstance(minimum_similarity, (int, float)) or not math.isfinite(minimum_similarity) or not 0 <= minimum_similarity <= 1:
            raise ValueError("minimum_similarity must be in [0, 1].")
        if type(top_k) is not int or not 1 <= top_k <= 100:
            raise ValueError("top_k must be an integer from 1 to 100.")
        snapshot: list[RetrievalExample] = []
        for example in examples:
            record = replace(example.record, public_input=json_copy(example.record.public_input),
                             authorized_uses=tuple(example.record.authorized_uses), parent_ids=tuple(example.record.parent_ids))
            output = CandidateOutput(**to_jsonable(example.output))
            rules = tuple(FieldSubstitution(tuple(rule.input_path), tuple(rule.output_path), rule.value_kind,
                                            rule.validation_reference, tuple(rule.allowed_values), rule.minimum, rule.maximum)
                          for rule in example.substitutions)
            item = RetrievalExample(record, output, rules)
            record.validate()
            if record.source_split not in {"training", "reference"} or "retrieval" not in record.authorized_uses or record.evaluation_origin:
                raise ValueError("Only explicitly authorized training/reference examples may be retrieved.")
            if output.status != "candidate" or record.response_hash != item.reuse_hash:
                raise ValueError("Retrieval output/mapping digest differs from its pinned reference record.")
            for substitution in item.substitutions:
                substitution.validate()
            snapshot.append(item)
        actual_hash = corpus_hash(item.record for item in snapshot)
        if len({item.record.record_id for item in snapshot}) != len(snapshot):
            raise ValueError("Duplicate retrieval IDs.")
        if not split_audit.clean or not split_audit.inventory_complete or not split_audit.inventory_reference or not split_audit.near_detection_complete:
            raise ValueError("A clean, complete and attributable split audit is required.")
        audited_records = dict(split_audit.corpus_record_hashes)
        if (pinned_corpus_hash != split_audit.corpus_hash
                or len(audited_records) != len(split_audit.corpus_record_hashes)
                or any(audited_records.get(item.record.record_id) != digest(item.record) for item in snapshot)):
            raise ValueError("Every retrieval record must belong unchanged to the complete audited corpus.")
        self._examples = tuple(sorted(snapshot, key=lambda item: item.record.record_id))
        self._terms = tuple(_terms(item.record.public_input) for item in self._examples)
        self._public_inputs = dict(split_audit.evaluation_public_inputs)
        self._corpus_hash = actual_hash
        self._audited_corpus_hash = pinned_corpus_hash
        self._audit_hash = digest(split_audit)
        self._minimum_similarity = minimum_similarity
        self._top_k = top_k

    @property
    def identity(self) -> dict[str, Any]:
        configuration = {"adapter": "lexical-retrieval-baseline-v1", "corpus_hash": self._corpus_hash,
                         "minimum_similarity": self._minimum_similarity, "top_k": self._top_k}
        return {"arm_id": "retrieval-" + digest(configuration),
                "adapter_id": "lexical-retrieval-baseline-v1", "kind": "retrieval", "status": "ready",
                "algorithm": "nfkc-casefold-token-count-cosine-v1", "corpus_hash": self._corpus_hash,
                "audited_inventory_hash": self._audited_corpus_hash,
                "split_audit_hash": self._audit_hash, "minimum_similarity": self._minimum_similarity,
                "top_k": self._top_k, "tie_breaker": "record_id_codepoint_order"}

    def execute(self, request: ExecutionRequest) -> CandidateOutput:
        task_input = public_input(request.task)
        if self._public_inputs.get(request.task.get("task_id")) != digest(task_input):
            return CandidateOutput("unavailable", reason="REQUEST_NOT_BOUND_TO_AUDITED_HELDOUT_SET",
                                   metadata={"retrieval_mode": "unsupported", "retrieved": []})
        query = _terms(task_input)
        ranked = sorted(((_cosine(query, terms), example) for terms, example in zip(self._terms, self._examples)),
                        key=lambda item: (-item[0], item[1].record.record_id))
        retrieved = [{"example_id": example.record.record_id, "similarity": score} for score, example in ranked[:self._top_k]]
        metadata = {"baseline": "retrieval", "retrieved": retrieved, "corpus_hash": self._corpus_hash,
                    "novel_generation": False, "retrieval_mode": "unsupported"}
        if not ranked or ranked[0][0] < self._minimum_similarity:
            return CandidateOutput("unsupported", reason="NO_REFERENCE_ABOVE_FIXED_SIMILARITY_THRESHOLD", metadata=metadata)
        score, example = ranked[0]
        if example.output.output_language != request.task["expected_output_language"]:
            return CandidateOutput("unsupported", reason="REFERENCE_OUTPUT_LANGUAGE_MISMATCH", metadata=metadata)
        try:
            result = _adapt(example, request.task) if example.substitutions else example.output
        except (ValueError, KeyError, TypeError):
            return CandidateOutput("unsupported", reason="VALIDATED_FIELD_SUBSTITUTION_UNAVAILABLE", metadata=metadata)
        # A fresh JSON copy prevents returned candidate metadata/content from mutating
        # the authorized reference snapshot for the next arm/task.
        result = CandidateOutput(**to_jsonable(result))
        return replace(result, metadata={**metadata, "selected_example_id": example.record.record_id,
                                        "selected_similarity": score,
                                        "retrieval_mode": "adapted" if example.substitutions else "copied"})
