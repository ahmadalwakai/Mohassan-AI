"""Optional early-exit head for a frozen ExecutionModel trunk (nested-architecture plan, P1).

The head reads the hidden state after block `exit_layer`, normalizes it, and
reuses the trunk's tied embedding as the output head. Variant "norm" adds one
scale-only RMSNorm (hidden_size parameters). Variant "projection" adds a zero-
initialized residual hidden_size x hidden_size projection before the norm.

Nothing here edits the trunk module, its forward pass, or its checkpoint; the
trunk forward is re-traced step by step with the trunk's own submodules.
"""

from __future__ import annotations

from dataclasses import dataclass

import torch
from torch import Tensor, nn
from torch.nn import functional as F

from .errors import ConfigurationError, InvalidRequestError, NumericalError
from .model import ExecutionModel
from .normalization import RMSNorm

VARIANTS = ("norm", "projection")


class EarlyExitHead(nn.Module):
    def __init__(self, model: ExecutionModel, exit_layer: int, variant: str = "norm") -> None:
        super().__init__()
        if not isinstance(model, ExecutionModel):
            raise ConfigurationError("EarlyExitHead requires an ExecutionModel trunk.")
        if type(exit_layer) is not int or not 1 <= exit_layer < model.config.num_layers:
            raise ConfigurationError("exit_layer must be in [1, num_layers - 1].")
        if variant not in VARIANTS:
            raise ConfigurationError(f"variant must be one of {VARIANTS}.")
        width = model.config.hidden_size
        self.exit_layer = exit_layer
        self.variant = variant
        self.projection = nn.Linear(width, width, bias=False, dtype=torch.float32) if variant == "projection" else None
        if self.projection is not None:
            nn.init.zeros_(self.projection.weight)  # starts as identity residual
        self.norm = RMSNorm(width, model.config.rms_norm_eps)

    def forward(self, hidden: Tensor) -> Tensor:
        if self.projection is not None:
            hidden = hidden + self.projection(hidden)
        return self.norm(hidden)

    @staticmethod
    def expected_parameters(hidden_size: int, variant: str) -> int:
        return hidden_size + (hidden_size * hidden_size if variant == "projection" else 0)


@dataclass(frozen=True)
class ExitOutput:
    exit_logits: Tensor
    full_logits: Tensor | None


def _select_last(hidden: Tensor, valid: Tensor) -> Tensor:
    positions = torch.arange(hidden.shape[1], device=hidden.device).expand(valid.shape)
    last = positions.masked_fill(~valid, -1).max(dim=-1).values
    return hidden[torch.arange(hidden.shape[0], device=hidden.device), last].unsqueeze(1)


def run_with_exit(model: ExecutionModel, head: EarlyExitHead, input_ids: Tensor, attention_mask: Tensor | None = None,
                  *, full: bool = True, last_token_only: bool = False) -> ExitOutput:
    """Trace the trunk forward exactly as ExecutionModel.forward does, tapping block `exit_layer`.

    With full=False only the first `exit_layer` blocks run (the cheap path).
    """
    valid = model._validate_inputs(input_ids, attention_mask)
    position_ids = (valid.long().cumsum(dim=-1) - 1).clamp_min(0)
    hidden = model.embedding_dropout(model.token_embedding(input_ids))
    hidden = hidden.masked_fill(~valid.unsqueeze(-1), 0.0)
    exit_hidden = None
    for index, block in enumerate(model.blocks, start=1):
        hidden = block(hidden, valid, position_ids)
        if index == head.exit_layer:
            exit_hidden = hidden
            if not full:
                break
    weight = model.token_embedding.weight
    exit_state = head(exit_hidden)
    if last_token_only:
        exit_state = _select_last(exit_state, valid)
    exit_logits = F.linear(exit_state, weight)
    full_logits = None
    if full:
        final = model.final_norm(hidden)
        if last_token_only:
            final = _select_last(final, valid)
        full_logits = F.linear(final, weight)
    for logits in (exit_logits, full_logits):
        if logits is not None and not bool(torch.isfinite(logits).all()):
            raise NumericalError("Early-exit tracing produced non-finite logits.")
    return ExitOutput(exit_logits=exit_logits, full_logits=full_logits)


def freeze_trunk(model: ExecutionModel) -> None:
    for parameter in model.parameters():
        parameter.requires_grad_(False)


def assert_trunk_frozen(model: ExecutionModel) -> None:
    if any(parameter.requires_grad for parameter in model.parameters()):
        raise InvalidRequestError("P1 trains the exit head only; the trunk must be frozen.")


def distillation_loss(exit_logits: Tensor, full_logits: Tensor, labels: Tensor | None, *,
                      ignore_index: int, temperature: float = 1.0, kl_weight: float = 1.0) -> Tensor:
    """CE(exit, labels) + kl_weight * T^2 * KL(full || exit), teacher detached.

    Logits are [batch, sequence, vocab]; labels are unshifted like ExecutionModel.forward.
    """
    if not (temperature > 0 and kl_weight >= 0):
        raise InvalidRequestError("temperature must be positive and kl_weight nonnegative.")
    student = exit_logits[:, :-1, :].float()
    teacher = full_logits[:, :-1, :].detach().float()
    vocab = student.shape[-1]
    if labels is not None:
        targets = labels[:, 1:].reshape(-1)
        mask = targets != ignore_index
        ce = F.cross_entropy(student.reshape(-1, vocab), targets, ignore_index=ignore_index) if bool(mask.any()) \
            else student.reshape(-1)[:0].sum()
    else:
        mask = torch.ones(student.shape[0] * student.shape[1], dtype=torch.bool, device=student.device)
        ce = student.reshape(-1)[:0].sum()
    log_student = F.log_softmax(student.reshape(-1, vocab) / temperature, dim=-1)[mask]
    log_teacher = F.log_softmax(teacher.reshape(-1, vocab) / temperature, dim=-1)[mask]
    kl = (F.kl_div(log_student, log_teacher, log_target=True, reduction="batchmean") * temperature ** 2
          if log_student.shape[0] else student.reshape(-1)[:0].sum())
    loss = ce + kl_weight * kl
    if not bool(torch.isfinite(loss)):
        raise NumericalError("Distillation produced a non-finite loss.")
    return loss
