"""Dependency-injected Phase 2 tokenizer contract; no tokenizer is implemented here."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Protocol, Sequence, runtime_checkable

from .common import canonical_json, digest
from .errors import TrainingError
from .schemas import TrainingExample

IGNORE_INDEX = -100


@runtime_checkable
class Phase2Tokenizer(Protocol):
    """An integration wrapper may adapt Phase 2's final concrete interface.

    encode/decode must preserve exact Unicode text, add/remove no implicit special
    tokens, and perform no normalization. Token IDs are stable for this identity
    and vocabulary version. special_tokens requires ``pad`` and ``eos`` and may
    include ``bos``. Shared pad/eos IDs are supported through explicit lengths.
    """
    identity: str
    vocabulary_version: str
    vocabulary_size: int
    special_tokens: Mapping[str, int]

    def encode(self, text: str) -> Sequence[int]: ...
    def decode(self, token_ids: Sequence[int]) -> str: ...


class TokenizerAdapter:
    def __init__(self, tokenizer: Phase2Tokenizer):
        self.tokenizer = tokenizer
        identity = getattr(tokenizer, "identity", None)
        version = getattr(tokenizer, "vocabulary_version", None)
        size = getattr(tokenizer, "vocabulary_size", None)
        special = getattr(tokenizer, "special_tokens", None)
        if type(identity) is not str or not identity or type(version) is not str or not version or type(size) is not int or size <= 0:
            raise TrainingError("INVALID_TOKENIZER", "Tokenizer identity, vocabulary version and positive vocabulary size are required.")
        if not isinstance(special, Mapping) or not {"pad", "eos"}.issubset(special):
            raise TrainingError("INVALID_TOKENIZER", "Tokenizer must declare pad and eos special-token IDs.")
        if any(type(key) is not str or not key or type(value) is not int or not 0 <= value < size for key, value in special.items()):
            raise TrainingError("INVALID_TOKENIZER", "Special-token mappings must contain valid vocabulary IDs.")
        if not callable(getattr(tokenizer, "encode", None)) or not callable(getattr(tokenizer, "decode", None)):
            raise TrainingError("INVALID_TOKENIZER", "Tokenizer encode and decode methods are required.")
        self._identity = {"identity": identity, "vocabulary_version": version,
                          "vocabulary_size": size, "special_tokens": dict(sorted(special.items()))}

    @property
    def identity(self) -> str:
        return self._identity["identity"]

    @property
    def vocabulary_size(self) -> int:
        return self._identity["vocabulary_size"]

    @property
    def pad_token_id(self) -> int:
        return self._identity["special_tokens"]["pad"]

    @property
    def eos_token_id(self) -> int:
        return self._identity["special_tokens"]["eos"]

    @property
    def bos_token_id(self) -> int | None:
        return self._identity["special_tokens"].get("bos")

    @property
    def identity_hash(self) -> str:
        return digest(self.identity_dict())

    def identity_dict(self) -> dict:
        return {**self._identity, "special_tokens": dict(self._identity["special_tokens"])}

    def _check_identity(self) -> None:
        special = getattr(self.tokenizer, "special_tokens", None)
        if not isinstance(special, Mapping):
            raise TrainingError("TOKENIZER_MISMATCH", "Tokenizer special-token mapping changed after adapter construction.")
        current = {"identity": getattr(self.tokenizer, "identity", None),
                   "vocabulary_version": getattr(self.tokenizer, "vocabulary_version", None),
                   "vocabulary_size": getattr(self.tokenizer, "vocabulary_size", None),
                   "special_tokens": dict(special)}
        if current != self._identity:
            raise TrainingError("TOKENIZER_MISMATCH", "Tokenizer identity or vocabulary changed after adapter construction.")

    def encode(self, text: str) -> tuple[int, ...]:
        self._check_identity()
        if type(text) is not str:
            raise TrainingError("INVALID_TOKENIZER_INPUT", "Tokenizer input must be exact text.")
        try:
            ids = tuple(self.tokenizer.encode(text))
        except Exception as error:
            raise TrainingError("TOKENIZATION_FAILED", "Tokenizer encoding failed; sample text is omitted from this error.") from error
        if any(type(token) is not int or not 0 <= token < self.vocabulary_size for token in ids):
            raise TrainingError("INVALID_TOKEN_ID", "Tokenizer emitted invalid or out-of-vocabulary IDs.")
        if text and not ids:
            raise TrainingError("LOSSY_TOKENIZER", "Tokenizer discarded nonempty text.")
        if self.decode(ids) != text:
            raise TrainingError("LOSSY_TOKENIZER", "Tokenizer roundtrip changed exact text; no sample is silently normalized.")
        return ids

    def decode(self, token_ids: Sequence[int]) -> str:
        self._check_identity()
        if any(type(token) is not int or not 0 <= token < self.vocabulary_size for token in token_ids):
            raise TrainingError("INVALID_TOKEN_ID", "Decode requires valid vocabulary IDs.")
        try:
            value = self.tokenizer.decode(token_ids)
        except Exception as error:
            raise TrainingError("TOKENIZATION_FAILED", "Tokenizer decoding failed.") from error
        if type(value) is not str:
            raise TrainingError("INVALID_TOKENIZER", "Tokenizer decode must return text.")
        return value


@dataclass(frozen=True)
class EncodedExample:
    sample_id: str
    input_ids: tuple[int, ...]
    labels: tuple[int, ...]
    prompt_token_count: int
    target_token_count: int
    objective: str

    @property
    def token_count(self) -> int:
        return len(self.input_ids)

    @property
    def loss_token_count(self) -> int:
        # The trainer predicts position t+1 from position t; the first label is unused.
        return sum(label != IGNORE_INDEX for label in self.labels[1:])


def render_prompt(example: TrainingExample) -> str:
    payload = {
        "task_family": example.task_family,
        "operation_category": example.operation_category,
        "task_specification": example.task_specification,
        "required_context": example.required_context,
        "input_contract": example.input_contract,
        "output_contract": example.output_contract,
        "acceptance_criteria": list(example.acceptance_criteria),
        "language": example.language,
    }
    if example.repair is not None:
        repair = example.to_dict()["repair"]
        payload["repair"] = {key: repair[key] for key in (
            "failed_candidate", "failure_evidence", "failure_category", "verification_method",
            "tests_preserved", "typecheck_bypassed",
        )}
    return render_prompt_payload(payload)


PROMPT_PAYLOAD_KEYS = frozenset({"task_family", "operation_category", "task_specification", "required_context",
                                 "input_contract", "output_contract", "acceptance_criteria", "language"})


def render_prompt_payload(payload: Mapping) -> str:
    """Single source of truth for the model input text, shared by training and inference.

    The local inference worker renders its request through this exact function, so a
    served prompt cannot drift from the prompt format the weights were trained on.
    """
    if (not isinstance(payload, Mapping) or not PROMPT_PAYLOAD_KEYS <= set(payload)
            or set(payload) - PROMPT_PAYLOAD_KEYS - {"repair"}):
        raise TrainingError("INVALID_PROMPT_PAYLOAD", "Prompt payload fields differ from the trained prompt contract.")
    # A plain-text delimiter, not a newly introduced tokenizer special token.
    return "Execution task:\n" + canonical_json(dict(payload)) + "\nExpected execution output:\n"


def encode_example(
    example: TrainingExample, adapter: TokenizerAdapter, context_length: int,
    objective: str = "supervised",
) -> EncodedExample:
    if type(context_length) is not int or context_length < 2 or objective not in ("supervised", "causal_lm"):
        raise TrainingError("INVALID_TOKENIZATION_CONFIG", "Context length must be at least two and objective must be supervised or causal_lm.")
    if example.repair is not None and example.repair.verified_correction != example.expected_output:
        raise TrainingError("INVALID_REPAIR", "A repair target must be the verified correction, never the failed candidate.")
    if example.repair is not None and objective != "supervised":
        raise TrainingError("INVALID_REPAIR_OBJECTIVE", "Repair training requires supervised prompt masking; failed candidates must remain input-only.")
    prompt = render_prompt(example)
    prompt_ids = adapter.encode(prompt)
    target_ids = adapter.encode(example.expected_output)
    if not target_ids:
        raise TrainingError("EMPTY_TARGET", "Every training example requires a nonempty verified target.")
    # Some tokenizers decode independently encoded segments differently when
    # concatenated. Reject those adapters until the integration wrapper fixes it.
    if adapter.decode(prompt_ids + target_ids) != prompt + example.expected_output:
        raise TrainingError("LOSSY_TOKENIZER", "Tokenization changes text at the prompt/target boundary.")
    prefix = () if adapter.bos_token_id is None else (adapter.bos_token_id,)
    input_ids = prefix + prompt_ids + target_ids + (adapter.eos_token_id,)
    if len(input_ids) > context_length:
        raise TrainingError("CONTEXT_OVERFLOW", "A complete task and target exceed the configured context; increase context or curate the sample explicitly.")
    prompt_count = len(prefix) + len(prompt_ids)
    if objective == "supervised":
        labels = (IGNORE_INDEX,) * prompt_count + target_ids + (adapter.eos_token_id,)
    else:
        labels = (IGNORE_INDEX,) + input_ids[1:]
    result = EncodedExample(example.sample_id, input_ids, labels, prompt_count, len(target_ids) + 1, objective)
    if result.loss_token_count == 0:
        raise TrainingError("EMPTY_TARGET", "No shifted target tokens remain for loss computation.")
    return result


def collate_encoded(examples: Sequence[EncodedExample], pad_token_id: int) -> dict[str, list[list[int]]]:
    """Right-pad by length, not token equality; supports pad == eos safely."""
    if not examples or type(pad_token_id) is not int or pad_token_id < 0:
        raise TrainingError("INVALID_BATCH", "Collation requires a nonempty batch and valid pad ID.")
    maximum = max(len(example.input_ids) for example in examples)
    result: dict[str, list[list[int]]] = {"input_ids": [], "labels": [], "attention_mask": []}
    for example in examples:
        if len(example.input_ids) != len(example.labels) or not example.input_ids or example.loss_token_count == 0:
            raise TrainingError("INVALID_BATCH", "Encoded inputs and labels must align and contain supervised tokens.")
        padding = maximum - len(example.input_ids)
        result["input_ids"].append(list(example.input_ids) + [pad_token_id] * padding)
        result["labels"].append(list(example.labels) + [IGNORE_INDEX] * padding)
        result["attention_mask"].append([1] * len(example.input_ids) + [0] * padding)
    return result
