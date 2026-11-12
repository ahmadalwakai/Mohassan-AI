"""Delegate checkpoint placement to the model owner, retaining a verifiable capability handshake."""

from __future__ import annotations

from typing import Any, Callable

from .errors import TrainingError


def configure_activation_checkpointing(
    model: Any, enabled: bool, hook: Callable[[Any, bool], bool] | None = None,
) -> bool:
    """The injected hook must enable recomputation and return the actual enabled state.

    Phase 2 owns block boundaries and should use torch.utils.checkpoint.checkpoint with
    use_reentrant=False and preserve_rng_state=True. This layer never guesses module names.
    """
    if type(enabled) is not bool:
        raise TrainingError("INVALID_CONFIGURATION", "Activation checkpointing must be boolean")
    if hook is None:
        if enabled:
            raise TrainingError("ACTIVATION_CHECKPOINTING_UNAVAILABLE", "Phase 2 must supply an activation checkpoint hook")
        return False
    actual = hook(model, enabled)
    if type(actual) is not bool or actual != enabled:
        raise TrainingError("ACTIVATION_CHECKPOINTING_UNAVAILABLE", "Model did not confirm the requested checkpointing state")
    return actual
