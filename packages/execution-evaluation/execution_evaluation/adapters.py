"""Dependency injection for Phase 2. No imports of an unfinished model or training engine."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
import time
from typing import Any, Protocol

from .common import digest, json_copy, to_jsonable
from .schemas import CandidateOutput, ExecutionRequest


class ExecutorAdapter(Protocol):
    @property
    def identity(self) -> dict[str, Any]: ...
    def execute(self, request: ExecutionRequest) -> CandidateOutput: ...


@dataclass(frozen=True)
class ModelIdentity:
    model_version: str
    tokenizer_version: str
    checkpoint_identity: str
    context_length: int
    generation_configuration: dict[str, Any]
    parameter_count: int | None = None
    training_dataset_digest: str | None = None
    training_example_count: int | None = None
    initialization: str = "random"

    def __post_init__(self) -> None:
        if any(not isinstance(value, str) or not value for value in (self.model_version, self.tokenizer_version, self.checkpoint_identity)):
            raise ValueError("Model, tokenizer and checkpoint identities required")
        if type(self.context_length) is not int or self.context_length <= 0:
            raise ValueError("Positive context length required")
        for name in ("parameter_count", "training_example_count"):
            value = getattr(self, name)
            if value is not None and (type(value) is not int or value < 0):
                raise ValueError(f"Invalid {name}")
        if self.initialization != "random":
            raise ValueError("This evaluation track is for randomly initialized models")
        if not isinstance(self.generation_configuration, dict):
            raise TypeError("Generation configuration must be a JSON object")
        object.__setattr__(self, "generation_configuration", json_copy(self.generation_configuration))


@dataclass(frozen=True)
class GenerationInvocation:
    request: ExecutionRequest
    model: ModelIdentity
    max_output_tokens: int
    deadline_monotonic: float
    cancelled: Callable[[], bool]


class LocalModelAdapter:
    """A trusted bridge must enforce the deadline/cancellation, context and token limits.

    Callback handles model inference only. It must return data; it never executes
    the generated program. Enforced budgets need independently observed receipts.
    """
    def __init__(self, model: ModelIdentity, generate: Callable[[GenerationInvocation], CandidateOutput] | None = None,
                 *, count_input_tokens: Callable[[dict[str, Any]], int] | None = None,
                 cancelled: Callable[[], bool] = lambda: False):
        self.model = model
        self._generate = generate
        self._count_tokens = count_input_tokens
        self._cancelled = cancelled

    @property
    def identity(self) -> dict[str, Any]:
        metadata = to_jsonable(self.model)
        return {"arm_id": "custom-" + digest(metadata)[:20], "kind": "custom_model", "model": metadata,
                "integration": "pending" if self._generate is None else "injected", "external_reasoning_allowed": False}

    def execute(self, request: ExecutionRequest) -> CandidateOutput:
        if self._generate is None or self._count_tokens is None:
            return CandidateOutput("unavailable", reason="phase2_bridge_or_token_counter_pending")
        if self._cancelled():
            return CandidateOutput("unavailable", reason="cancelled")
        # Counter must tokenize the complete real serialized prompt including bridge
        # wrapper, prior candidate and status; counting only task text is insufficient.
        input_tokens = self._count_tokens(to_jsonable(request))
        if type(input_tokens) is not int or input_tokens < 0:
            raise ValueError("Token counter returned invalid count")
        if input_tokens + request.budget.output_tokens > self.model.context_length:
            return CandidateOutput("unsupported", reason="context_length_exceeded")
        output = self._generate(GenerationInvocation(request, self.model, request.budget.output_tokens,
                               time.monotonic() + request.budget.time_ms / 1000, self._cancelled))
        if not isinstance(output, CandidateOutput):
            raise TypeError("Phase 2 bridge must decode into CandidateOutput")
        return output
