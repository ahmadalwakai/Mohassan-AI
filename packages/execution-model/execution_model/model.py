"""Dense decoder-only causal language model with a teacher-forced training API."""

from __future__ import annotations

from dataclasses import dataclass

import torch
from torch import Tensor, nn
from torch.nn import functional as F

from .attention import CausalSelfAttention
from .config import ModelConfig
from .errors import ConfigurationError, ContextLengthError, InvalidRequestError, NumericalError
from .feed_forward import SwiGLU
from .initialization import initialize_model_weights, seeded_initialization
from .normalization import RMSNorm


@dataclass(frozen=True)
class ModelOutput:
    """Logits [batch, sequence, vocabulary] (or [batch, 1, vocabulary]); scalar loss."""

    logits: Tensor
    loss: Tensor | None = None


class TransformerBlock(nn.Module):
    def __init__(self, config: ModelConfig) -> None:
        super().__init__()
        self.attention_norm = RMSNorm(config.hidden_size, config.rms_norm_eps)
        self.attention = CausalSelfAttention(config)
        self.ffn_norm = RMSNorm(config.hidden_size, config.rms_norm_eps)
        self.feed_forward = SwiGLU(config)
        self.residual_dropout = nn.Dropout(config.dropout)

    def forward(self, hidden: Tensor, valid_tokens: Tensor, position_ids: Tensor) -> Tensor:
        hidden = hidden + self.residual_dropout(self.attention(self.attention_norm(hidden), valid_tokens, position_ids))
        hidden = hidden + self.residual_dropout(self.feed_forward(self.ffn_norm(hidden)))
        return hidden.masked_fill(~valid_tokens.unsqueeze(-1), 0.0)


class ExecutionModel(nn.Module):
    """Randomly initialized model, never a planner, executor, or verifier.

    Construction uses CPU unless an enclosing PyTorch meta device context is
    active. Move the constructed model explicitly to CUDA/dtype afterwards.
    """

    def __init__(self, config: ModelConfig) -> None:
        super().__init__()
        if not isinstance(config, ModelConfig):
            raise ConfigurationError("ExecutionModel requires a validated ModelConfig.")
        if torch.empty(0).device.type not in ("cpu", "meta"):
            raise ConfigurationError("Construct on CPU, then move explicitly to the requested device.")
        self.config = config
        self.weight_origin = "random_initialized"
        self.initialization_seed: int | None = config.seed
        with seeded_initialization(config.seed):
            self.token_embedding = nn.Embedding(config.vocab_size, config.hidden_size, dtype=torch.float32)
            self.embedding_dropout = nn.Dropout(config.dropout)
            self.blocks = nn.ModuleList(TransformerBlock(config) for _ in range(config.num_layers))
            self.final_norm = RMSNorm(config.hidden_size, config.rms_norm_eps)
            initialize_model_weights(self, std=config.init_std, num_layers=config.num_layers)

    def parameter_count(self) -> int:
        """Count actual unique parameter tensors; no hardcoded preset totals."""
        return sum(parameter.numel() for parameter in self.parameters())

    def _validate_inputs(self, input_ids: Tensor, attention_mask: Tensor | None) -> Tensor:
        if not isinstance(input_ids, Tensor) or input_ids.ndim != 2 or input_ids.dtype != torch.long:
            raise InvalidRequestError("input_ids must be a rank-two torch.long tensor.")
        batch, length = input_ids.shape
        if batch < 1 or batch > 64 or length < 1:
            raise InvalidRequestError("Batch size must be 1..64 and sequence length must be positive.")
        if length > self.config.max_context_length:
            raise ContextLengthError(
                "Input exceeds the architecture context limit; no tokens were truncated.",
                details={"input_tokens": length, "max_context_length": self.config.max_context_length},
            )
        if input_ids.device != self.token_embedding.weight.device or input_ids.device.type not in ("cpu", "cuda"):
            raise InvalidRequestError("input_ids and model weights must share a CPU or CUDA device.")
        if bool(((input_ids < 0) | (input_ids >= self.config.vocab_size)).any()):
            raise InvalidRequestError("input_ids contain a token outside the vocabulary.")
        if attention_mask is None:
            return torch.ones_like(input_ids, dtype=torch.bool)
        if not isinstance(attention_mask, Tensor) or attention_mask.shape != input_ids.shape or attention_mask.device != input_ids.device:
            raise InvalidRequestError("attention_mask must match input_ids shape and device.")
        if attention_mask.dtype not in (torch.bool, torch.uint8, torch.int8, torch.int16, torch.int32, torch.int64):
            raise InvalidRequestError("attention_mask must be a boolean or integer 0/1 tensor.")
        if bool(((attention_mask != 0) & (attention_mask != 1)).any()):
            raise InvalidRequestError("attention_mask contains values other than zero and one.")
        valid = attention_mask.bool()
        if bool((~valid.any(dim=-1)).any()):
            raise InvalidRequestError("Every sequence must contain at least one non-padding token.")
        return valid

    def forward(
        self,
        input_ids: Tensor,
        attention_mask: Tensor | None = None,
        labels: Tensor | None = None,
        *,
        last_token_only: bool = False,
    ) -> ModelOutput:
        """Predict next tokens; labels are unshifted and shifted exactly once here.

        Mask zero means padding. Valid queries can attend only to valid keys at
        their own or earlier sequence indices. Position numbering ignores pads.
        Labels at padding positions, and pairs with a padded predicting query,
        are excluded from loss. The caller masks prompt labels with ignore_index
        for response-only training. A one-token/all-ignored batch has zero loss.
        """
        if type(last_token_only) is not bool:
            raise InvalidRequestError("last_token_only must be boolean.")
        valid = self._validate_inputs(input_ids, attention_mask)
        if labels is not None:
            if last_token_only:
                raise InvalidRequestError("last_token_only cannot be combined with training labels.")
            if not isinstance(labels, Tensor) or labels.dtype != torch.long or labels.shape != input_ids.shape or labels.device != input_ids.device:
                raise InvalidRequestError("labels must be torch.long and match input_ids shape and device.")
            invalid = (labels != self.config.ignore_index) & ((labels < 0) | (labels >= self.config.vocab_size))
            if bool(invalid.any()):
                raise InvalidRequestError("labels contain a token outside the vocabulary/ignore index.")
        position_ids = (valid.long().cumsum(dim=-1) - 1).clamp_min(0)
        hidden = self.embedding_dropout(self.token_embedding(input_ids))
        hidden = hidden.masked_fill(~valid.unsqueeze(-1), 0.0)
        for block in self.blocks:
            hidden = block(hidden, valid, position_ids)
        hidden = self.final_norm(hidden)
        if last_token_only:
            sequence_positions = torch.arange(input_ids.shape[1], device=input_ids.device).expand_as(input_ids)
            last_positions = sequence_positions.masked_fill(~valid, -1).max(dim=-1).values
            hidden = hidden[torch.arange(input_ids.shape[0], device=input_ids.device), last_positions].unsqueeze(1)
        # Actual weight tying: there is no separate output-head parameter or state entry.
        logits = F.linear(hidden, self.token_embedding.weight)
        if not bool(torch.isfinite(logits).all()):
            raise NumericalError("Model produced non-finite logits.")
        loss = None
        if labels is not None:
            targets = labels[:, 1:].clone()
            targets.masked_fill_(~(valid[:, :-1] & valid[:, 1:]), self.config.ignore_index)
            supervised = targets != self.config.ignore_index
            if bool(supervised.any()):
                loss = F.cross_entropy(
                    logits[:, :-1, :].float().reshape(-1, self.config.vocab_size),
                    targets.reshape(-1),
                    ignore_index=self.config.ignore_index,
                )
            else:
                # Empty slice produces exact differentiable zero without overflowing a sum.
                loss = logits.reshape(-1)[:0].float().sum()
            if not bool(torch.isfinite(loss)):
                raise NumericalError("Model produced a non-finite training loss.")
        return ModelOutput(logits=logits, loss=loss)
