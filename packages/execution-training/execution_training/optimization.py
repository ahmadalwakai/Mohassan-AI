"""Optimizer construction and token-budget-aware scheduling without architecture assumptions."""

from __future__ import annotations

import math
from typing import Any

from .configuration import TrainingConfig
from .errors import TrainingError


def create_optimizer(model: Any, config: TrainingConfig) -> Any:
    import torch
    config.validate()
    parameters = [p for p in model.parameters() if p.requires_grad]
    if not parameters:
        raise TrainingError("INVALID_MODEL", "The injected model has no trainable parameters")
    if config.optimizer == "adamw":
        return torch.optim.AdamW(parameters, lr=config.learning_rate, betas=config.adam_betas,
                                 eps=config.adam_eps, weight_decay=config.weight_decay,
                                 foreach=config.optimizer_foreach)
    return torch.optim.SGD(parameters, lr=config.learning_rate, weight_decay=config.weight_decay,
                           momentum=0.0, foreach=config.optimizer_foreach)


class TokenScheduler:
    """Schedule after a committed optimizer step, using nonpadding processed training tokens."""

    def __init__(self, optimizer: Any, config: TrainingConfig):
        self.optimizer = optimizer
        self.config = config
        self.processed_tokens = 0
        self.base_lrs = [group["lr"] for group in optimizer.param_groups]
        self._apply()

    def _ratio(self) -> float:
        warmup = self.config.warmup_tokens
        if warmup and self.processed_tokens < warmup:
            # A nonzero first update; subsequent updates follow the measured token position.
            return max(1, self.processed_tokens) / warmup
        progress = min(1.0, max(0.0, (self.processed_tokens - warmup) /
                               (self.config.max_processed_tokens - warmup)))
        if self.config.scheduler == "constant":
            value = 1.0
        elif self.config.scheduler == "linear":
            value = 1.0 - progress
        else:
            value = 0.5 * (1.0 + math.cos(math.pi * progress))
        return self.config.min_learning_rate_ratio + (1 - self.config.min_learning_rate_ratio) * value

    def _apply(self) -> None:
        ratio = self._ratio()
        for group, base in zip(self.optimizer.param_groups, self.base_lrs):
            group["lr"] = base * ratio

    def step(self, processed_tokens: int) -> None:
        if type(processed_tokens) is not int or not self.processed_tokens <= processed_tokens <= self.config.max_processed_tokens:
            raise TrainingError("INVALID_TOKEN_COUNT", "Scheduler token count must increase within budget")
        self.processed_tokens = processed_tokens
        self._apply()

    def state_dict(self) -> dict[str, Any]:
        return {"schema_version": "token-scheduler-v1", "processed_tokens": self.processed_tokens,
                "base_lrs": self.base_lrs, "config_identity": self.config.resume_identity()}

    def load_state_dict(self, state: dict[str, Any]) -> None:
        if (set(state) != {"schema_version", "processed_tokens", "base_lrs", "config_identity"}
                or state["schema_version"] != "token-scheduler-v1"
                or state["config_identity"] != self.config.resume_identity()
                or state["base_lrs"] != self.base_lrs
                or type(state["processed_tokens"]) is not int
                or not 0 <= state["processed_tokens"] <= self.config.max_processed_tokens):
            raise TrainingError("RESUME_INCOMPATIBLE", "Scheduler configuration or state is incompatible")
        self.processed_tokens = state["processed_tokens"]
        self._apply()


def create_scheduler(optimizer: Any, config: TrainingConfig) -> TokenScheduler:
    return TokenScheduler(optimizer, config)
