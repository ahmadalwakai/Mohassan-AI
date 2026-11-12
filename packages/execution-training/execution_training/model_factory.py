"""Phase 2 integration contract. No model architecture or tokenizer lives here."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Protocol

from .errors import TrainingError


@dataclass(frozen=True)
class ModelRequest:
    architecture_id: str
    preset: str
    seed: int
    vocabulary_size: int
    context_length: int
    initialization: str = "random"
    allow_pretrained: bool = False


@dataclass(frozen=True)
class ModelBundle:
    """Trusted factory attestation, checked before optimization or checkpoint load.

    model must be a torch.nn.Module with forward(input_ids=..., attention_mask=...)
    returning logits [batch, sequence, vocabulary], either directly, as .logits,
    or under the mapping key 'logits'. It must implement a causal attention mask.
    configuration_identity must hash the COMPLETE resolved Phase 2 architecture.
    The hook must enable checkpointing with preserved RNG and expose confirmation
    as described by activation.configure_activation_checkpointing.
    """
    model: Any
    architecture_id: str
    configuration_identity: str
    vocabulary_size: int
    context_length: int
    initialization: str
    initialization_seed: int
    factory_identity: str
    activation_checkpointing_hook: Callable[[Any, bool], bool] | None = None


class ModelFactory(Protocol):
    def __call__(self, request: ModelRequest) -> ModelBundle: ...


def validate_bundle(bundle: ModelBundle, request: ModelRequest) -> None:
    import re
    import torch
    if not isinstance(bundle, ModelBundle) or not isinstance(bundle.model, torch.nn.Module):
        raise TrainingError("MODEL_FACTORY_INVALID", "Factory must return a ModelBundle with a PyTorch module.")
    if (bundle.initialization != "random" or type(bundle.initialization_seed) is not int or bundle.initialization_seed != request.seed
            or request.initialization != "random" or request.allow_pretrained):
        raise TrainingError("PRETRAINED_WEIGHTS_FORBIDDEN", "Factory must attest fresh random initialization with the requested seed.")
    if bundle.architecture_id != request.architecture_id:
        raise TrainingError("MODEL_CONFIGURATION_MISMATCH", "Factory architecture identity does not match configuration.")
    if type(bundle.configuration_identity) is not str or not re.fullmatch(r"[a-f0-9]{64}", bundle.configuration_identity):
        raise TrainingError("MODEL_CONFIGURATION_MISMATCH", "Factory must supply the resolved architecture SHA-256 identity.")
    if (type(bundle.vocabulary_size) is not int or type(bundle.context_length) is not int
            or bundle.vocabulary_size != request.vocabulary_size or bundle.context_length < request.context_length
            or not isinstance(bundle.factory_identity, str) or not bundle.factory_identity.strip()):
        raise TrainingError("MODEL_CONFIGURATION_MISMATCH", "Factory vocabulary, context or implementation identity is incompatible.")
    parameters = list(bundle.model.parameters())
    if not parameters or not any(parameter.requires_grad for parameter in parameters):
        raise TrainingError("MODEL_FACTORY_INVALID", "Factory returned no trainable parameters.")
    if any(parameter.device.type == "meta" or not parameter.is_floating_point() for parameter in parameters):
        raise TrainingError("MODEL_FACTORY_INVALID", "Factory must materialize floating point parameters.")

