"""Discriminative heads on the frozen local execution trunk."""

from __future__ import annotations

import math
import re
from contextlib import ExitStack
from pathlib import Path
from typing import Literal, cast

import torch
from execution_model.adapters import (
    AdapterHandle,
    active_adapter,
    attach_adapter,
    expected_parameters,
)
from execution_model.checkpoint import (
    _check_torch_loader,
    _local_directory,
    _open_file,
    _sha256,
    _validate_archive,
    _validate_state,
)
from execution_model.config import ModelConfig
from execution_model.model import ExecutionModel
from execution_pipeline.pretrain import TextEncoder
from torch import Tensor, nn

HeadKind = Literal["classification", "pairwise", "selection"]
MAX_LORA_PARAMETERS = 600_000
_CHECKPOINT_BYTES = 2_147_483_648  # PR #19's training checkpoint limit


def _verify_pin(path: Path, digest: str, limit: int) -> None:
    with ExitStack() as stack:
        source = _open_file(stack, _local_directory(path.parent), path.name, limit)
        if _sha256(source, limit) != digest:
            raise ValueError(f"SHA-256 mismatch for {path.name}.")


def load_trunk(
    checkpoint: Path,
    checkpoint_sha256: str,
    tokenizer_path: Path,
    tokenizer_sha256: str,
    *,
    tokenizer_report_sha256: str | None = None,
) -> tuple[ExecutionModel, TextEncoder]:
    """Load the v5 selected/best.pt training format and its tokenizer on CPU."""
    pins = [checkpoint_sha256, tokenizer_sha256]
    if tokenizer_report_sha256 is not None:
        pins.append(tokenizer_report_sha256)
    if any(re.fullmatch(r"[0-9a-f]{64}", digest) is None for digest in pins):
        raise ValueError("Every pin must be a lowercase SHA-256 digest.")
    if tokenizer_path.name != "tokenizer.json":
        raise ValueError("The pinned execution tokenizer must be named tokenizer.json.")
    report = tokenizer_path.with_name("tokenizer-report.json")
    if tokenizer_report_sha256 is None and (report.exists() or report.is_symlink()):
        raise ValueError("The existing tokenizer-report.json also requires a SHA-256 pin.")

    def verify_tokenizer() -> None:
        _verify_pin(tokenizer_path, tokenizer_sha256, 4_194_304)
        if tokenizer_report_sha256 is not None:
            _verify_pin(report, tokenizer_report_sha256, 65_536)

    verify_tokenizer()
    encoder = TextEncoder(tokenizer_path.parent)
    verify_tokenizer()
    _check_torch_loader()
    with ExitStack() as stack:
        source = _open_file(
            stack, _local_directory(checkpoint.parent), checkpoint.name, _CHECKPOINT_BYTES
        )
        if _sha256(source, _CHECKPOINT_BYTES) != checkpoint_sha256:
            raise ValueError("Trunk checkpoint SHA-256 mismatch.")
        _validate_archive(source, _CHECKPOINT_BYTES)
        payload = torch.load(source, map_location="cpu", weights_only=True)
        if _sha256(source, _CHECKPOINT_BYTES) != checkpoint_sha256:
            raise ValueError("Trunk checkpoint changed during loading.")
    if not isinstance(payload, dict) or not {"config", "model_state"} <= payload.keys():
        raise ValueError("Expected a v5 training checkpoint with config and model_state.")
    config = ModelConfig.from_dict(payload["config"])
    state = payload["model_state"]
    settings = payload.get("settings", {})
    del payload  # Do not retain the optimizer and RNG states in memory.
    if config.vocab_size != encoder.tokenizer.vocab_size:
        raise ValueError("Checkpoint vocabulary size does not match the pinned tokenizer.")
    expected = {
        "external_pretrained_weights": False,
        "config_identity": config.identity,
        "tokenizer_identity": encoder.tokenizer.identity,
        "tokenizer_sha256": tokenizer_sha256,
        "tokenizer_report_sha256": tokenizer_report_sha256,
    }
    if not isinstance(settings, dict) or any(
        key in settings and settings[key] != value for key, value in expected.items()
    ):
        raise ValueError("Training checkpoint settings disagree with the local architecture or tokenizer pins.")
    if not isinstance(state, dict) or any(type(tensor) is not Tensor for tensor in state.values()):
        raise ValueError("The trunk model_state must be a tensor dictionary.")
    with torch.device("meta"):
        trunk = ExecutionModel(config)
    _validate_state(state, trunk.state_dict(), check_finite=True, limit=_CHECKPOINT_BYTES)
    trunk.load_state_dict(state, strict=True, assign=True)
    trunk.weight_origin = "local_checkpoint"
    return trunk.float().requires_grad_(False).eval(), encoder


class HeadModel(nn.Module):
    """Use PR #19's last valid token/classifier and candidate-position/pointer projections."""

    def __init__(
        self,
        trunk: ExecutionModel,
        *,
        kind: HeadKind,
        num_classes: int | None = None,
        seed: int = 0,
        lora_rank: int = 0,
        lora_budget: int = MAX_LORA_PARAMETERS,
    ) -> None:
        super().__init__()
        if kind not in ("classification", "pairwise", "selection"):
            raise ValueError("Unknown head kind.")
        if kind == "classification":
            if type(num_classes) is not int or not 2 <= num_classes <= 256:
                raise ValueError("Classification heads require 2–256 classes.")
            width = num_classes
        else:
            if num_classes is not None:
                raise ValueError("Pointer heads use one score per candidate.")
            width = 1
        if type(seed) is not int or not 0 <= seed < 2**63:
            raise ValueError("Seed must be a nonnegative signed 64-bit integer.")
        if type(lora_rank) is not int or not 0 <= lora_rank <= 256:
            raise ValueError("LoRA rank must be in 0–256.")
        if type(lora_budget) is not int or not 0 <= lora_budget <= MAX_LORA_PARAMETERS:
            raise ValueError(f"LoRA budget must be in 0–{MAX_LORA_PARAMETERS}.")
        if active_adapter(trunk) is not None:
            raise ValueError("HeadModel requires a trunk without an attached adapter.")
        if expected_parameters(trunk, lora_rank) > lora_budget:
            raise ValueError("LoRA exceeds the parameter budget.")
        self.kind = kind
        self.trunk = trunk.requires_grad_(False).eval()
        self.adapter: AdapterHandle | None = None
        # Use a local CPU generator, leaving the caller's RNG untouched.
        generator = torch.Generator(device="cpu").manual_seed(seed)
        self.projection = nn.Linear(trunk.config.hidden_size, width, device="meta")
        self.projection.to_empty(device="cpu")
        bound = 1 / math.sqrt(trunk.config.hidden_size)
        with torch.no_grad():
            self.projection.weight.uniform_(-bound, bound, generator=generator)
            self.projection.bias.uniform_(-bound, bound, generator=generator)
        self.projection.to(trunk.token_embedding.weight.device)
        if lora_rank:
            self.adapter = attach_adapter(
                trunk, "head-training", rank=lora_rank, alpha=2 * lora_rank, seed=seed
            )

    def train(self, mode: bool = True) -> HeadModel:
        super().train(mode)
        # The shared trunk always uses its inference paths. Only the projection
        # and optional adapter require derivatives.
        self.trunk.eval()
        return self

    def forward(
        self,
        input_ids: Tensor,
        attention_mask: Tensor | None = None,
        candidate_positions: Tensor | None = None,
    ) -> Tensor:
        valid = self.trunk._validate_inputs(input_ids, attention_mask)
        positions = (valid.long().cumsum(dim=-1) - 1).clamp_min(0)
        # Match ExecutionModel.forward without its tied vocabulary projection.
        hidden = self.trunk.embedding_dropout(self.trunk.token_embedding(input_ids))
        hidden = hidden.masked_fill(~valid.unsqueeze(-1), 0.0)
        for block in self.trunk.blocks:
            hidden = block(hidden, valid, positions)

        if self.kind == "classification":
            if candidate_positions is not None:
                raise ValueError("Classification uses the last valid token.")
            sequence_positions = torch.arange(input_ids.shape[1], device=input_ids.device)
            last = sequence_positions.masked_fill(~valid, -1).amax(dim=-1)
            pooled = hidden[torch.arange(input_ids.shape[0], device=input_ids.device), last]
            return cast(Tensor, self.projection(self.trunk.final_norm(pooled)))

        if (candidate_positions is None or candidate_positions.dtype != torch.long
                or candidate_positions.ndim != 2 or candidate_positions.shape[0] != input_ids.shape[0]):
            raise ValueError("Pointer heads require a rank-two candidate position tensor.")
        if bool(((candidate_positions < -1) | (candidate_positions >= input_ids.shape[1])).any()):
            raise ValueError("Candidate positions must index the input sequence.")
        indices = candidate_positions.clamp_min(0)
        present = candidate_positions >= 0
        if bool((present & ~valid.gather(1, indices)).any()) or not bool(present.any(dim=1).all()):
            raise ValueError("Each pointer input needs candidates at valid token positions.")
        projected = cast(Tensor, self.projection(self.trunk.final_norm(hidden)))
        scores = projected.squeeze(-1).gather(1, indices)
        return scores.masked_fill(~present, -torch.inf)

    def merged_trunk_state(self) -> dict[str, Tensor] | None:
        """Materialize an adapter's effective weights for a new worker checkpoint."""
        if self.adapter is None:
            return None
        state = {
            name: value.detach().cpu()
            for name, value in self.trunk.state_dict().items()
            if not name.endswith((".base.weight", ".lora_a", ".lora_b"))
        }
        with torch.no_grad():
            for name, module in self.adapter.modules.items():
                delta = module.lora_b.cpu() @ module.lora_a.cpu()
                state[f"{name}.weight"] = module.base.weight.detach().cpu() + delta * module.scaling
        return state
