"""Serve one local v4 delta over the existing contained worker protocol."""
from __future__ import annotations

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "execution-integration"))
from model_worker import worker


def apply_delta(trunk, arm: str, state: dict) -> None:
    import torch
    from torch import nn
    from torch.nn import functional as F
    from execution_model.adapters import attach_adapter
    from execution_model.checkpoint import _validate_state
    from model_worker.checkpoints import EngineError, SIDECAR_BYTES

    if any(type(value) is not torch.Tensor for value in state.values()):
        raise EngineError("invalid_checkpoint")

    def validate(expected: dict) -> None:
        _validate_state(state, expected, check_finite=True, limit=SIDECAR_BYTES)

    # The two T1 experiments use the same head, LoRA defaults and last-two-block scope.
    # https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/scripts/heads/t1_head_forms.py (retrieved 2026-11-27)
    if arm == "head":
        class ResidualHead(nn.Module):
            def __init__(self, hidden: int) -> None:
                super().__init__()
                self.down = nn.Linear(hidden, 256)
                self.up = nn.Linear(256, hidden)

            def forward(self, hidden):
                return hidden + self.up(F.gelu(self.down(hidden)))

        head = ResidualHead(trunk.config.hidden_size)
        validate(head.state_dict())
        head.load_state_dict(state)
        head.eval().requires_grad_(False)
        trunk.final_norm.register_forward_hook(lambda _module, _args, output: head(output))
    elif arm == "lora":
        adapter = attach_adapter(trunk, "council-v4")
        container = adapter.state_module()
        validate(container.state_dict())
        container.load_state_dict(state)
        container.requires_grad_(False)
    elif arm == "last2":
        layers = trunk.config.num_layers
        prefixes = (f"blocks.{layers - 2}.", f"blocks.{layers - 1}.", "final_norm.")
        expected = {name: parameter for name, parameter in trunk.named_parameters() if name.startswith(prefixes)}
        validate(expected)
        trunk.load_state_dict(state, strict=False)
    else:
        raise EngineError("invalid_config")


def load_engine(config: dict, *, base_dir: Path, max_output_tokens: int, tokenizer_id: str | None = None):
    from execution_model.errors import ExecutionModelError
    from model_worker.checkpoints import EngineError, SIDECAR_BYTES, fields, load_tensors, local_path, pin, snapshot
    from model_worker.engine import load_engine as load_base_engine

    delta = fields(config.get("delta"), {"arm", "path", "sha256"}, set(), "invalid_config")
    if config.get("device", "cpu") != "cpu" or "quantization" in config:
        raise EngineError("invalid_config")
    path = local_path(base_dir, delta["path"])
    try:
        with snapshot(path, pin(delta["sha256"]), SIDECAR_BYTES) as handle:
            state = load_tensors(handle, SIDECAR_BYTES)
    except (ExecutionModelError, KeyError, OSError, RuntimeError, TypeError, ValueError) as error:
        if isinstance(error, EngineError):
            raise
        raise EngineError("invalid_checkpoint") from error
    engine = load_base_engine({key: value for key, value in config.items() if key != "delta"}, base_dir=base_dir,
                              max_output_tokens=max_output_tokens, tokenizer_id=tokenizer_id)
    try:
        apply_delta(engine.heads["lm"].trunk, delta["arm"], state)
    except (ExecutionModelError, KeyError, RuntimeError, TypeError, ValueError) as error:
        engine.close()
        if isinstance(error, EngineError):
            raise
        raise EngineError("invalid_checkpoint") from error
    return engine


if __name__ == "__main__":
    raise SystemExit(worker.main(engine_loader=load_engine, extra_model_fields=frozenset({"delta"})))
