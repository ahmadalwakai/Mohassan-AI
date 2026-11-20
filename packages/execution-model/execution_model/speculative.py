"""Greedy self-speculative decoding with an early-exit draft (nested-architecture plan, P1).

Greedy only. A drafted token is accepted iff it equals the full model's argmax
at that position; the first mismatch is replaced by the full model's token, and
if every draft is accepted the full pass also yields one bonus token. With exact
arithmetic the output equals `generation.generate(..., GenerationConfig())`.
Floating-point differences between a long verification pass and step-by-step
passes can still flip a near-tie, so equality is an acceptance test (AT-SPEC),
not an assumption. Sampling, constraints and blocked tokens are unsupported.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import torch

from .early_exit import EarlyExitHead, run_with_exit
from .errors import ContextLengthError, InvalidRequestError, NumericalError
from .model import ExecutionModel


@dataclass(frozen=True)
class SpeculativeResult:
    token_ids: tuple[int, ...]
    stop_reason: str  # "eos" | "stop_token" | "length"
    terminal_token_id: int | None
    drafted: int
    accepted: int
    full_passes: int
    draft_passes: int

    @property
    def acceptance_rate(self) -> float:
        return self.accepted / self.drafted if self.drafted else 0.0


def _argmax(logits: torch.Tensor) -> int:
    # Same rule as generation._choose with do_sample=False: CPU float32 argmax.
    scores = logits.detach().to(device="cpu", dtype=torch.float32)
    if not bool(torch.isfinite(scores).all()):
        raise NumericalError("Model produced nonfinite next-token logits.")
    return int(torch.argmax(scores).item())


def speculative_generate_greedy(model: ExecutionModel, head: EarlyExitHead, input_ids: Sequence[int], *,
                                max_new_tokens: int, draft_tokens: int = 4, eos_token_id: int | None = None,
                                stop_token_ids: Sequence[int] = (), max_context_length: int | None = None) -> SpeculativeResult:
    if model.training or head.training:
        raise InvalidRequestError("Speculative decoding requires eval mode for trunk and head.")
    if type(max_new_tokens) is not int or not 0 <= max_new_tokens <= 8192:
        raise InvalidRequestError("max_new_tokens must be in 0..8192.")
    if type(draft_tokens) is not int or not 1 <= draft_tokens <= 32:
        raise InvalidRequestError("draft_tokens must be in 1..32.")
    if not isinstance(input_ids, (list, tuple)) or not input_ids:
        raise InvalidRequestError("input_ids must be a nonempty list or tuple.")
    vocab, limit = model.config.vocab_size, model.config.max_context_length
    if max_context_length is not None:
        if type(max_context_length) is not int or not 1 <= max_context_length <= limit:
            raise InvalidRequestError("Requested context limit exceeds the model configuration.")
        limit = max_context_length
    if len(input_ids) + max_new_tokens > limit:
        raise ContextLengthError("Prompt and requested output budget exceed the context window.",
                                 details={"input_tokens": len(input_ids), "requested_output_tokens": max_new_tokens,
                                          "max_context_length": limit})
    stops = {int(t) for t in stop_token_ids}
    if eos_token_id is not None:
        stops.add(eos_token_id)
    if any(type(t) is not int or not 0 <= t < vocab for t in list(input_ids) + sorted(stops)):
        raise InvalidRequestError("Token id is outside the vocabulary.")
    device = next(model.parameters()).device
    prompt = list(input_ids)
    generated: list[int] = []
    drafted = accepted = full_passes = draft_passes = 0
    terminal = None
    with torch.inference_mode():
        while len(generated) < max_new_tokens and terminal is None:
            remaining = max_new_tokens - len(generated)
            # Drafting k tokens plus one verified token never exceeds the budget.
            k = min(draft_tokens, remaining - 1)
            drafts: list[int] = []
            for _ in range(k):
                tensor = torch.tensor([prompt + generated + drafts], dtype=torch.long, device=device)
                out = run_with_exit(model, head, tensor, full=False, last_token_only=True)
                draft_passes += 1
                token = _argmax(out.exit_logits[0, -1])
                drafts.append(token)
                if token in stops:
                    break
            tensor = torch.tensor([prompt + generated + drafts], dtype=torch.long, device=device)
            logits = model(tensor).logits[0]
            full_passes += 1
            base = len(prompt) + len(generated) - 1
            drafted += len(drafts)
            for offset in range(len(drafts) + 1):
                target = _argmax(logits[base + offset])
                generated.append(target)
                matched = offset < len(drafts) and drafts[offset] == target
                accepted += int(matched)
                if target in stops:
                    terminal = target
                    break
                if not matched or len(generated) >= max_new_tokens:
                    break
    if terminal is not None:
        reason = "eos" if terminal == eos_token_id else "stop_token"
    else:
        reason = "length"
    return SpeculativeResult(tuple(generated), reason, terminal, drafted, accepted, full_passes, draft_passes)
