"""Local Python facade for future adapters; generated candidates are untrusted data."""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from threading import Lock
from typing import Any

from .checkpoint import load_checkpoint
from .config import ModelConfig
from .constraints import DecodingConstraint, constraint_from_spec
from .errors import (ConfigurationError, ContextLengthError, ExecutionModelError,
                     InvalidRequestError, ModelNotLoadedError, ResourceError,
                     UnsupportedRequestError)
from .generation import GenerationConfig, GenerationResult, stream_generate
from .metadata import ModelMetadata
from .model import ExecutionModel
from .resources import ResourceConfig, ResolvedResources, is_out_of_memory, place_model
from .tokenizer import ByteBPETokenizer


@dataclass(frozen=True)
class CandidateOutput:
    text: str | None
    output_bytes: bytes
    utf8_valid: bool
    generation: GenerationResult
    model_metadata: ModelMetadata
    resources: dict[str, Any]
    generation_config: dict[str, Any]
    trusted: bool = False
    independently_verified: bool = False


@dataclass(frozen=True)
class InferenceResponse:
    """completed means decoding ended, never successful task execution.

    Inspect generation.stop_reason and constraint_satisfied before forwarding a
    candidate to the independent verifier. Error responses have no candidate.
    """
    status: str
    candidate: CandidateOutput | None = None
    error: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        # Python-native bytes are intentional; a future wire adapter must choose
        # an explicit reversible byte encoding (such as base64).
        return asdict(self)


@dataclass(frozen=True)
class InferenceEvent:
    kind: str
    token_id: int | None = None
    output_bytes: bytes = b""
    terminal: bool = False
    response: InferenceResponse | None = None


class InferenceEngine:
    """Owns one immutable-for-inference model and permits one active operation.

    Close an abandoned stream to release the engine lock. Other engines may run
    independently; the host must bound their combined memory use. Loading and
    random initialization are explicit operations and raise typed exceptions.
    Generation errors are instead returned as structured final responses.
    """

    def __init__(self, resources: ResourceConfig | None = None):
        self.resources = resources if resources is not None else ResourceConfig()
        if not isinstance(self.resources, ResourceConfig):
            raise ConfigurationError("resources must be ResourceConfig.")
        self._model: ExecutionModel | None = None
        self._tokenizer: ByteBPETokenizer | None = None
        self._metadata: ModelMetadata | None = None
        self._resolved: ResolvedResources | None = None
        self._lock = Lock()

    @staticmethod
    def get_supported_capabilities() -> dict[str, bool]:
        return {
            "text_generation": True, "greedy": True, "sampling": True,
            "token_streaming": True, "allowed_tokens": True,
            "finite_token_sequences": True, "finite_json_choices": True,
            "cancellation": True, "cpu": True, "cuda_when_available": True,
            "json_schema": False, "kv_cache": False, "batch_generation": False,
            "vision": False, "tools": False, "permissions": False,
            "planning": False, "verification": False, "network": False,
        }

    def get_model_info(self) -> dict[str, Any]:
        if not self._lock.acquire(blocking=False):
            raise ResourceError("Engine has an active operation.", details={"reason": "ENGINE_BUSY"})
        try:
            if self._model is None:
                return {"loaded": False, "capabilities": self.get_supported_capabilities()}
            return {
                "loaded": True, "config": self._model.config.to_dict(),
                "parameter_count": self._model.parameter_count(),
                "metadata": self._metadata.to_dict(),
                "resources": self._resolved.to_dict(),
                "limits": self.resources.to_dict(),
                "capabilities": self.get_supported_capabilities(),
            }
        finally:
            self._lock.release()

    def _check_config(self, config: ModelConfig) -> None:
        if not isinstance(config, ModelConfig):
            raise ConfigurationError("Expected configuration must be ModelConfig.")
        if self.resources.max_context_length > config.max_context_length:
            raise ConfigurationError("Resource context limit exceeds model context length.")

    def initialize_random(self, config: ModelConfig, tokenizer: ByteBPETokenizer) -> ModelMetadata:
        """Explicit development/training handoff only; weights have no learned skill."""
        if not self._lock.acquire(blocking=False):
            raise ResourceError("Engine has an active operation.", details={"reason": "ENGINE_BUSY"})
        try:
            self._check_config(config)
            if not isinstance(tokenizer, ByteBPETokenizer) or config.vocab_size != tokenizer.vocab_size:
                raise ConfigurationError("Model vocabulary must equal the tokenizer's actual vocabulary size.")
            resolved = self.resources.resolve()
            try:
                model = place_model(ExecutionModel(config), resolved)
            except (RuntimeError, MemoryError) as exc:
                reason = "OUT_OF_MEMORY" if isinstance(exc, MemoryError) or is_out_of_memory(exc) else "INITIALIZATION_FAILED"
                raise ResourceError("Random model allocation failed.", details={"reason": reason}) from exc
            model.eval().requires_grad_(False)
            metadata = ModelMetadata(
                weight_origin="random_initialized", training_status="random_initialized",
                config_identity=config.identity, tokenizer_identity=tokenizer.identity,
                initialization_seed=config.seed,
            )
            self._model, self._tokenizer, self._metadata, self._resolved = model, tokenizer, metadata, resolved
            return metadata
        finally:
            self._lock.release()

    def load_local_model(self, path: str | Path, *, expected_config: ModelConfig,
                         expected_tokenizer_identity: str) -> ModelMetadata:
        if not self._lock.acquire(blocking=False):
            raise ResourceError("Engine has an active operation.", details={"reason": "ENGINE_BUSY"})
        try:
            self._check_config(expected_config)
            loaded = load_checkpoint(path, expected_config=expected_config,
                                     expected_tokenizer_identity=expected_tokenizer_identity,
                                     resources=self.resources)
            loaded.model.eval().requires_grad_(False)
            self._model, self._tokenizer = loaded.model, loaded.tokenizer
            self._metadata, self._resolved = loaded.metadata, loaded.resolved_resources
            return loaded.metadata
        finally:
            self._lock.release()

    def _encode(self, text: str, framing: str) -> tuple[int, ...]:
        if self._tokenizer is None:
            raise ModelNotLoadedError("Explicitly initialize or load a local model first.")
        if not isinstance(text, str):
            raise InvalidRequestError("Task input must be text.")
        if len(text) > self.resources.max_input_bytes:
            raise InvalidRequestError("Task input exceeds the byte budget.")
        try:
            byte_count = len(text.encode("utf-8"))
        except UnicodeError as exc:
            raise InvalidRequestError("Task input must be valid Unicode without lone surrogates.") from exc
        if byte_count > self.resources.max_input_bytes:
            raise InvalidRequestError("Task input exceeds the byte budget.")
        if framing == "plain":
            ids = self._tokenizer.encode(text, add_bos=True)
        elif framing == "task":
            special = self._tokenizer.special_token_ids
            if any(name not in special for name in ("bos", "task", "input", "output")):
                raise UnsupportedRequestError("Tokenizer lacks the required task delimiters.")
            ids = [special["bos"], special["task"], special["input"]]
            ids.extend(self._tokenizer.encode(text))
            ids.append(special["output"])
        else:
            raise UnsupportedRequestError("Unsupported input framing; use plain or task.")
        if len(ids) > self.resources.max_context_length:
            raise ContextLengthError("Encoded task exceeds the context window.",
                                     details={"input_tokens": len(ids), "max_context_length": self.resources.max_context_length})
        return tuple(ids)

    def encode_task_input(self, text: str, *, framing: str = "plain") -> tuple[int, ...]:
        if not self._lock.acquire(blocking=False):
            raise ResourceError("Engine has an active operation.", details={"reason": "ENGINE_BUSY"})
        try:
            return self._encode(text, framing)
        finally:
            self._lock.release()

    def stream_candidate(self, task_input: str, config: GenerationConfig | None = None, *,
                         framing: str = "plain", constraint_spec: Mapping[str, Any] | None = None,
                         constraint: DecodingConstraint | None = None,
                         requested_capabilities: Sequence[str] = (),
                         cancelled: Callable[[], bool] | None = None) -> Iterator[InferenceEvent]:
        acquired = False
        try:
            acquired = self._lock.acquire(blocking=False)
            if not acquired:
                raise ResourceError("Engine has an active operation.", details={"reason": "ENGINE_BUSY"})
            if self._model is None:
                raise ModelNotLoadedError("Explicitly initialize or load a local model first.")
            config = config if config is not None else GenerationConfig(max_new_tokens=min(128, self.resources.max_output_tokens))
            if not isinstance(config, GenerationConfig):
                raise InvalidRequestError("config must be GenerationConfig.")
            if config.max_new_tokens > self.resources.max_output_tokens:
                raise InvalidRequestError("Requested output exceeds the engine output budget.")
            capabilities = self.get_supported_capabilities()
            if not isinstance(requested_capabilities, (list, tuple)) or len(requested_capabilities) > 64:
                raise InvalidRequestError("Requested capabilities must be a bounded list or tuple.")
            if any(not isinstance(name, str) or not capabilities.get(name, False) for name in requested_capabilities):
                raise UnsupportedRequestError("One or more requested capabilities are unsupported.")
            if constraint_spec is not None and constraint is not None:
                raise InvalidRequestError("Provide a constraint specification or an in-process constraint, not both.")
            effective_constraint = constraint if constraint is not None else constraint_from_spec(constraint_spec, self._tokenizer)
            ids = self._encode(task_input, framing)
            # Delimiters are inserted by the caller, never synthesized implicitly.
            # EOS and explicitly configured stop tokens remain legal.
            stops = set(config.stop_token_ids) | {self._tokenizer.eos_token_id}
            blocked = tuple(token for token in self._tokenizer.special_token_ids.values() if token not in stops)
            stream = stream_generate(
                self._model, ids, config, max_context_length=self.resources.max_context_length,
                eos_token_id=self._tokenizer.eos_token_id, blocked_token_ids=blocked,
                constraint=effective_constraint, cancelled=cancelled,
            )
            for event in stream:
                if event.kind == "token":
                    data = b"" if event.terminal else self._tokenizer.token_bytes(event.token_id)
                    yield InferenceEvent("token", token_id=event.token_id, output_bytes=data, terminal=event.terminal)
                else:
                    result = event.result
                    content_ids = result.token_ids[:-1] if result.terminal_token_id is not None else result.token_ids
                    data = self._tokenizer.decode_bytes(content_ids)
                    try:
                        text = data.decode("utf-8", errors="strict")
                        valid = True
                    except UnicodeDecodeError:
                        text, valid = None, False
                    candidate = CandidateOutput(text, data, valid, result, self._metadata,
                                                self._resolved.to_dict(), config.to_dict())
                    status = "cancelled" if result.stop_reason == "cancelled" else "completed"
                    yield InferenceEvent("final", response=InferenceResponse(status, candidate=candidate))
        except ExecutionModelError as exc:
            yield InferenceEvent("final", response=InferenceResponse("error", error=exc.to_dict()))
        except MemoryError:
            error = ResourceError("Host memory allocation failed.", details={"reason": "OUT_OF_MEMORY"})
            yield InferenceEvent("final", response=InferenceResponse("error", error=error.to_dict()))
        finally:
            if acquired:
                self._lock.release()

    def generate_candidate(self, task_input: str, config: GenerationConfig | None = None, **kwargs: Any) -> InferenceResponse:
        stream = self.stream_candidate(task_input, config, **kwargs)
        try:
            for event in stream:
                if event.response is not None:
                    return event.response
        finally:
            stream.close()
        raise RuntimeError("Inference ended without a final response.")
