"""Bounded single-sequence autoregressive decoding, deliberately without a KV cache."""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from collections.abc import Callable, Iterator, Sequence
from typing import Any

import torch

from .constraints import DecodingConstraint
from .errors import (ConstraintError, ContextLengthError, InvalidRequestError,
                     NumericalError, ResourceError, UnsupportedRequestError)
from .model import ExecutionModel
from .resources import is_out_of_memory


@dataclass(frozen=True)
class GenerationConfig:
    max_new_tokens: int = 128
    do_sample: bool = False
    temperature: float = 1.0
    top_k: int = 0
    top_p: float = 1.0
    seed: int = 0
    stop_token_ids: tuple[int, ...] = ()
    require_deterministic_algorithms: bool = False

    def __post_init__(self) -> None:
        for name, low, high in (("max_new_tokens", 0, 8192), ("top_k", 0, 65536), ("seed", 0, 2**63 - 1)):
            value = getattr(self, name)
            if type(value) is not int or not low <= value <= high:
                raise InvalidRequestError(f"{name} must be an integer in {low}..{high}.")
        for name in ("do_sample", "require_deterministic_algorithms"):
            if type(getattr(self, name)) is not bool:
                raise InvalidRequestError(f"{name} must be boolean.")
        if type(self.temperature) not in (int, float) or not math.isfinite(self.temperature) or not 1e-5 <= self.temperature <= 100:
            raise InvalidRequestError("temperature must be finite and in 0.00001..100.")
        if type(self.top_p) not in (int, float) or not math.isfinite(self.top_p) or not 0 < self.top_p <= 1:
            raise InvalidRequestError("top_p must be in (0, 1].")
        if not isinstance(self.stop_token_ids, tuple) or len(self.stop_token_ids) > 256 or any(type(t) is not int or t < 0 for t in self.stop_token_ids):
            raise InvalidRequestError("stop_token_ids must be a tuple of at most 256 nonnegative integers.")
        if not self.do_sample and (self.temperature != 1.0 or self.top_k != 0 or self.top_p != 1.0):
            raise InvalidRequestError("Sampling parameters require do_sample=True.")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class GenerationResult:
    token_ids: tuple[int, ...]
    input_tokens: int
    output_tokens: int
    stop_reason: str
    terminal_token_id: int | None
    constraint_satisfied: bool | None
    seed: int
    deterministic_algorithms: bool


@dataclass(frozen=True)
class GenerationEvent:
    """Each token event is followed eventually by one final event.

    Terminal tokens count toward output_tokens and appear in token_ids. The
    inference facade omits the terminal token from candidate text/bytes only.
    """
    kind: str
    token_id: int | None = None
    terminal: bool = False
    result: GenerationResult | None = None


def _choose(logits: torch.Tensor, config: GenerationConfig, rng: torch.Generator,
            allowed: set[int] | None, blocked: set[int]) -> int:
    # CPU float32 sampling gives a request-local RNG with no process RNG changes.
    scores = logits.detach().to(device="cpu", dtype=torch.float32).clone()
    if not bool(torch.isfinite(scores).all()):
        raise NumericalError("Model produced nonfinite next-token logits.")
    keep = torch.ones(scores.shape[0], dtype=torch.bool)
    if allowed is not None:
        keep.zero_()
        if allowed:
            keep[list(sorted(allowed))] = True
    if blocked:
        keep[list(sorted(blocked))] = False
    if not bool(keep.any()):
        raise ConstraintError("No legal next token remains after filtering.")
    scores.masked_fill_(~keep, -torch.inf)
    if not config.do_sample:
        return int(torch.argmax(scores).item())
    # Subtract the max before temperature division to avoid positive overflow.
    scores = (scores - scores.max()) / config.temperature
    if config.top_k:
        order = torch.argsort(scores, descending=True, stable=True)
        scores[order[min(config.top_k, scores.numel()):]] = -torch.inf
    if config.top_p < 1.0:
        order = torch.argsort(scores, descending=True, stable=True)
        cumulative = torch.softmax(scores[order], dim=-1).cumsum(dim=-1)
        remove = cumulative > config.top_p
        remove[1:] = remove[:-1].clone()
        remove[0] = False
        scores[order[remove]] = -torch.inf
    probabilities = torch.softmax(scores, dim=-1)
    if not bool(torch.isfinite(probabilities).all()) or float(probabilities.sum()) <= 0:
        raise NumericalError("Sampling distribution is invalid.")
    return int(torch.multinomial(probabilities, 1, generator=rng).item())


def stream_generate(model: ExecutionModel, input_ids: Sequence[int], config: GenerationConfig,
                    *, max_context_length: int | None = None, eos_token_id: int | None = None,
                    blocked_token_ids: Sequence[int] = (), constraint: DecodingConstraint | None = None,
                    cancelled: Callable[[], bool] | None = None) -> Iterator[GenerationEvent]:
    """No truncation, no batching, no writes, no caching, no model-mode mutation.

    The caller must put the model in eval mode. inference_mode is entered only
    around tensor work, never across a yield into caller code.
    """
    if not isinstance(model, ExecutionModel):
        raise InvalidRequestError("model must be ExecutionModel.")
    if not isinstance(config, GenerationConfig):
        raise InvalidRequestError("config must be GenerationConfig.")
    if model.training:
        raise InvalidRequestError("Generation requires model.eval().")
    if not isinstance(input_ids, (list, tuple)) or not input_ids:
        raise InvalidRequestError("input_ids must be a nonempty list or tuple.")
    vocab_size = model.config.vocab_size
    limit = model.config.max_context_length
    if max_context_length is not None:
        if type(max_context_length) is not int or not 1 <= max_context_length <= limit:
            raise InvalidRequestError("Requested context limit exceeds the model configuration.")
        limit = max_context_length
    if cancelled is not None and not callable(cancelled):
        raise InvalidRequestError("cancelled must be a trusted callable.")
    if constraint is not None and not isinstance(constraint, DecodingConstraint):
        raise UnsupportedRequestError("Unsupported in-process constraint implementation.")
    budget = config.max_new_tokens
    if constraint is not None and constraint.token_budget is not None:
        if type(constraint.token_budget) is not int or not 1 <= constraint.token_budget <= 8192:
            raise InvalidRequestError("Constraint returned an invalid token budget.")
        budget = min(budget, constraint.token_budget)
    if len(input_ids) > limit or len(input_ids) + budget > limit:
        raise ContextLengthError("Prompt and requested output budget exceed the context window.",
                                 details={"input_tokens": len(input_ids), "requested_output_tokens": budget, "max_context_length": limit})
    if any(type(t) is not int or not 0 <= t < vocab_size for t in input_ids):
        raise InvalidRequestError("Input token id is outside the vocabulary.")
    if eos_token_id is not None and (type(eos_token_id) is not int or not 0 <= eos_token_id < vocab_size):
        raise InvalidRequestError("EOS token id is outside the vocabulary.")
    stops = set(config.stop_token_ids)
    if eos_token_id is not None:
        stops.add(eos_token_id)
    if not isinstance(blocked_token_ids, (tuple, list)) or len(blocked_token_ids) > vocab_size:
        raise InvalidRequestError("blocked_token_ids must be a bounded list or tuple.")
    if any(type(t) is not int or not 0 <= t < vocab_size for t in blocked_token_ids):
        raise InvalidRequestError("Blocked token id is outside the vocabulary.")
    blocked = set(blocked_token_ids)
    if any(type(t) is not int or not 0 <= t < vocab_size for t in stops | blocked):
        raise InvalidRequestError("Stop or blocked token id is outside the vocabulary.")
    if stops & blocked:
        raise InvalidRequestError("A token cannot be both blocked and a stop token.")
    if constraint is not None:
        constraint.validate(vocab_size, frozenset(stops), frozenset(blocked))
    deterministic = torch.are_deterministic_algorithms_enabled()
    if config.require_deterministic_algorithms and (not deterministic or torch.is_deterministic_algorithms_warn_only_enabled()):
        raise UnsupportedRequestError("Strict deterministic algorithms must be enabled by the host before generation.")
    rng = torch.Generator(device="cpu").manual_seed(config.seed)
    generated: list[int] = []
    terminal = None
    reason = "token_budget" if budget < config.max_new_tokens else "length"
    device = next(model.parameters()).device
    for _ in range(budget):
        if cancelled is not None and cancelled():
            reason = "cancelled"
            break
        prefix = tuple(generated)
        if constraint is not None and constraint.is_complete(prefix):
            reason = "constraint_complete"
            break
        allowed = None
        if constraint is not None:
            candidates = constraint.allowed_token_ids(prefix, vocab_size)
            if candidates is not None:
                allowed = set()
                for index, token in enumerate(candidates):
                    if index >= vocab_size or type(token) is not int or not 0 <= token < vocab_size:
                        raise InvalidRequestError("Constraint returned invalid or excessive token ids.")
                    allowed.add(token)
        try:
            with torch.inference_mode():
                tensor = torch.tensor([list(input_ids) + generated], dtype=torch.long, device=device)
                output = model(tensor, last_token_only=True)
                next_token = _choose(output.logits[0, -1], config, rng, allowed, blocked)
                del output, tensor
        except torch.OutOfMemoryError as exc:
            raise ResourceError("Memory allocation failed during generation; no device fallback was attempted.",
                                details={"reason": "out_of_memory", "device": str(device), "generated_tokens": len(generated)}) from exc
        except RuntimeError as exc:
            reason = "out_of_memory" if is_out_of_memory(exc) else "runtime_failure"
            raise ResourceError("PyTorch could not complete a generation step.", details={"reason": reason, "device": str(device)}) from exc
        # Cancellation during a forward pass discards that step's proposed token.
        if cancelled is not None and cancelled():
            reason = "cancelled"
            break
        generated.append(next_token)
        if next_token in stops:
            terminal = next_token
            reason = "eos" if next_token == eos_token_id else "stop_token"
        yield GenerationEvent("token", token_id=next_token, terminal=terminal is not None)
        if terminal is not None:
            break
        if constraint is not None and constraint.is_complete(tuple(generated)):
            reason = "constraint_complete"
            break
    # Cancellation also takes precedence for a zero-token request.
    if cancelled is not None and cancelled():
        reason = "cancelled"
    accepted_prefix = tuple(generated[:-1] if terminal is not None else generated)
    accepted = constraint.accepts(accepted_prefix) if constraint is not None else None
    yield GenerationEvent("final", result=GenerationResult(
        token_ids=tuple(generated), input_tokens=len(input_ids), output_tokens=len(generated),
        stop_reason=reason, terminal_token_id=terminal, constraint_satisfied=accepted,
        seed=config.seed, deterministic_algorithms=deterministic,
    ))


def generate(model: ExecutionModel, input_ids: Sequence[int], config: GenerationConfig, **kwargs: Any) -> GenerationResult:
    for event in stream_generate(model, input_ids, config, **kwargs):
        if event.result is not None:
            return event.result
    raise RuntimeError("Generation ended without a terminal event.")
