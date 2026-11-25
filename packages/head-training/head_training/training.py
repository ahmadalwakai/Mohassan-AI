"""Deterministic training and development evaluation on local heads."""

from __future__ import annotations

import json
import math
import os
import random
import time
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import cast

import torch
from execution_pipeline.pretrain import _sha256
from torch import Tensor
from torch.amp.grad_scaler import GradScaler
from torch.nn import functional as F

from .model import HeadModel


@dataclass(frozen=True)
class EncodedExample:
    input_ids: tuple[int, ...]
    class_index: int | None = None
    candidate_positions: tuple[int, ...] = ()
    gold: tuple[int, ...] = ()

    @property
    def accepted(self) -> tuple[int, ...]:
        return self.gold if self.class_index is None else (self.class_index,)


@dataclass(frozen=True)
class TrainingConfig:
    seed: int = 0
    device: str = "cpu"
    epochs: int = 20
    batch_size: int = 2
    accumulation: int = 8
    learning_rate: float = 0.003
    patience: int = 4
    mixed_precision: bool = True

    def __post_init__(self) -> None:
        if self.device not in ("cpu", "cuda"):
            raise ValueError("Training device must be cpu or cuda.")
        if type(self.seed) is not int or not 0 <= self.seed < 2**63:
            raise ValueError("Seed must be a nonnegative signed 64-bit integer.")
        for field in ("epochs", "batch_size", "accumulation", "patience"):
            value = getattr(self, field)
            if type(value) is not int or value < 1:
                raise ValueError(f"{field} must be a positive integer.")
        if self.batch_size > 64:
            raise ValueError("Batch size exceeds the trunk's limit of 64.")
        if (type(self.learning_rate) not in (float, int)
                or not math.isfinite(self.learning_rate) or self.learning_rate <= 0):
            raise ValueError("Learning rate must be positive and finite.")
        if type(self.mixed_precision) is not bool:
            raise ValueError("mixed_precision must be boolean.")


@dataclass(frozen=True)
class EpochMetrics:
    epoch: int
    training_loss: float
    development_loss: float


@dataclass(frozen=True)
class TrainingResult:
    history: tuple[EpochMetrics, ...]
    initial_development_loss: float
    best_epoch: int
    checkpoint_path: Path
    checkpoint_sha256: str
    stopped_early: bool


def _validate(
    model: HeadModel, rows: Sequence[EncodedExample], batch_size: int, pad_token_id: int
) -> None:
    config = model.trunk.config
    if not rows or not 1 <= batch_size <= 64 or not 0 <= pad_token_id < config.vocab_size:
        raise ValueError("Require nonempty rows, a valid batch size and a valid pad token.")
    for row in rows:
        if not 1 <= len(row.input_ids) <= config.max_context_length:
            raise ValueError("Each row must fit the trunk's context length.")
        if model.kind == "classification":
            if (row.class_index is None or not 0 <= row.class_index < model.projection.out_features
                    or row.candidate_positions or row.gold):
                raise ValueError("Each classification row needs one valid class index.")
            continue
        count = len(row.candidate_positions)
        if (row.class_index is not None or not row.gold
                or len(set(row.gold)) != len(row.gold)
                or any(not 0 <= index < count for index in row.gold)
                or len(set(row.candidate_positions)) != count
                or any(not 0 <= position < len(row.input_ids) for position in row.candidate_positions)):
            raise ValueError("Each pointer row needs distinct candidate positions and valid gold indices.")
        if model.kind == "pairwise" and len(row.gold) == count:
            raise ValueError("Pairwise training needs a negative candidate for each row.")


def _logits(model: HeadModel, rows: Sequence[EncodedExample], pad_token_id: int) -> Tensor:
    device = model.projection.weight.device
    length = max(len(row.input_ids) for row in rows)
    ids = torch.tensor(
        [row.input_ids + (pad_token_id,) * (length - len(row.input_ids)) for row in rows],
        device=device,
        dtype=torch.long,
    )
    lengths = torch.tensor([len(row.input_ids) for row in rows], device=device)
    valid = torch.arange(length, device=device) < lengths[:, None]
    if model.kind == "classification":
        return cast(Tensor, model(ids, valid))
    width = max(len(row.candidate_positions) for row in rows)
    candidates = torch.tensor(
        [row.candidate_positions + (-1,) * (width - len(row.candidate_positions)) for row in rows],
        device=device,
        dtype=torch.long,
    )
    return cast(Tensor, model(ids, valid, candidates))


def _losses(model: HeadModel, rows: Sequence[EncodedExample], pad_token_id: int) -> Tensor:
    logits = _logits(model, rows, pad_token_id).float()
    if model.kind == "classification":
        target = torch.tensor([row.class_index for row in rows], device=logits.device)
        return F.cross_entropy(logits, target, reduction="none")
    gold = torch.tensor(
        [[index in row.gold for index in range(logits.shape[1])] for row in rows],
        device=logits.device,
    )
    if model.kind == "selection":
        accepted = logits.masked_fill(~gold, -torch.inf)
        return logits.logsumexp(dim=1) - accepted.logsumexp(dim=1)
    # Pairwise logistic loss for every gold/non-gold pair in the same example.
    lengths = torch.tensor([len(row.candidate_positions) for row in rows], device=logits.device)
    valid = torch.arange(logits.shape[1], device=logits.device) < lengths[:, None]
    pairs = gold[:, :, None] & (valid & ~gold)[:, None, :]
    present = logits.masked_fill(~valid, 0.0)
    differences = present[:, None, :] - present[:, :, None]
    loss = F.softplus(differences).masked_fill(~pairs, 0.0)
    return loss.sum(dim=(1, 2)) / pairs.sum(dim=(1, 2))


@contextmanager
def _deterministic(device: str) -> Iterator[None]:
    if device == "cuda":
        # PyTorch requires this workspace setting for reproducible CUDA matmuls.
        os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA was requested but is unavailable.")
    previous = torch.are_deterministic_algorithms_enabled()
    warn_only = torch.is_deterministic_algorithms_warn_only_enabled()
    torch.use_deterministic_algorithms(True)
    try:
        yield
    finally:
        torch.use_deterministic_algorithms(previous, warn_only=warn_only)


@torch.inference_mode()
def _development_loss(
    model: HeadModel,
    rows: Sequence[EncodedExample],
    batch_size: int,
    pad_token_id: int,
    progress_check: Callable[[], None] | None,
) -> float:
    model.eval()
    total = 0.0
    for start in range(0, len(rows), batch_size):
        if progress_check is not None:
            progress_check()
        total += float(_losses(model, rows[start:start + batch_size], pad_token_id).sum())
    if not math.isfinite(total):
        raise ValueError("Development loss is not finite.")
    return total / len(rows)


@torch.no_grad()
def predict(
    model: HeadModel,
    rows: Sequence[EncodedExample],
    *,
    batch_size: int = 2,
    pad_token_id: int = 0,
    progress_check: Callable[[], None] | None = None,
) -> list[tuple[Tensor, tuple[int, ...]]]:
    """Return one unpadded, FP32 CPU logit vector and accepted-index tuple per row."""
    _validate(model, rows, batch_size, pad_token_id)
    model.eval()
    predictions = []
    for start in range(0, len(rows), batch_size):
        if progress_check is not None:
            progress_check()
        batch = rows[start:start + batch_size]
        logits = _logits(model, batch, pad_token_id).float().cpu()
        for row, scores in zip(batch, logits, strict=True):
            width = len(row.candidate_positions) or scores.numel()
            scores = scores[:width].clone()
            if not bool(torch.isfinite(scores).all()):
                raise ValueError("Head produced nonfinite logits.")
            predictions.append((scores, row.accepted))
    return predictions


def _save_best(
    directory: Path,
    state: dict[str, Tensor],
    model: HeadModel,
    config: TrainingConfig,
    epoch: int,
    development_loss: float,
    development_rows: int,
) -> tuple[Path, str]:
    directory.mkdir(parents=True, exist_ok=False)
    pending = NamedTemporaryFile(dir=directory, delete=False)
    temporary = Path(pending.name)
    try:
        with pending:
            torch.save(state, pending)
        digest = _sha256(temporary)
        checkpoint = directory / f"{digest}.pt"
        temporary.rename(checkpoint)
    finally:
        temporary.unlink(missing_ok=True)
    record = {
        "checkpoint_sha256": digest,
        "checkpoint_file": checkpoint.name,
        "head_kind": model.kind,
        "trunk_config_identity": model.trunk.config.identity,
        "trainable_parameters": sum(tensor.numel() for tensor in state.values()),
        "training_config": asdict(config),
        "epoch": epoch,
        "development_loss": development_loss,
        "development_rows": development_rows,
        "code_sha256": {
            name: _sha256(Path(__file__).with_name(name)) for name in ("model.py", "training.py")
        },
    }
    with (directory / "manifest.json").open("x", encoding="utf-8") as stream:
        json.dump(record, stream, indent=2, sort_keys=True, allow_nan=False)
        stream.write("\n")
    return checkpoint, digest


def train(
    model: HeadModel,
    train_rows: Sequence[EncodedExample],
    development_rows: Sequence[EncodedExample],
    *,
    config: TrainingConfig,
    checkpoint_dir: Path,
    pad_token_id: int = 0,
    progress_check: Callable[[], None] | None = None,
    training_update: Callable[[int, float], None] | None = None,
) -> TrainingResult:
    """Fit supervised rows and restore the head from the best development epoch."""
    for rows in (train_rows, development_rows):
        _validate(model, rows, config.batch_size, pad_token_id)
    if checkpoint_dir.exists():
        raise FileExistsError(checkpoint_dir)
    rng = random.Random(config.seed)
    shuffled = list(range(len(train_rows)))
    amp = config.mixed_precision and config.device == "cuda"
    best_state: dict[str, Tensor] = {}
    best_epoch = 0
    best_loss = math.inf
    history: list[EpochMetrics] = []
    with _deterministic(config.device):
        model.to(config.device)
        parameters = {name: value for name, value in model.named_parameters() if value.requires_grad}
        optimizer = torch.optim.AdamW(parameters.values(), lr=config.learning_rate)
        scaler = GradScaler("cuda", enabled=amp)
        initial = _development_loss(model, development_rows, config.batch_size, pad_token_id, progress_check)
        window_size = config.batch_size * config.accumulation
        for epoch in range(1, config.epochs + 1):
            model.train()
            rng.shuffle(shuffled)
            losses = 0.0
            for start in range(0, len(shuffled), window_size):
                window = shuffled[start:start + window_size]
                started = time.perf_counter()
                optimizer.zero_grad(set_to_none=True)
                update_tokens = 0
                for offset in range(0, len(window), config.batch_size):
                    if progress_check is not None:
                        progress_check()
                    batch = [train_rows[i] for i in window[offset:offset + config.batch_size]]
                    with torch.autocast(device_type=config.device, dtype=torch.float16, enabled=amp):
                        total = _losses(model, batch, pad_token_id).sum()
                    measured = float(total.detach())
                    if not math.isfinite(measured):
                        raise ValueError("Training loss is not finite.")
                    losses += measured
                    torch.autograd.backward(scaler.scale(total / len(window)))
                    update_tokens += sum(len(row.input_ids) for row in batch)
                scaler.step(optimizer)
                scaler.update()
                if training_update is not None:
                    if config.device == "cuda":
                        torch.cuda.synchronize()
                    training_update(update_tokens, time.perf_counter() - started)
            development = _development_loss(
                model, development_rows, config.batch_size, pad_token_id, progress_check
            )
            history.append(EpochMetrics(epoch, losses / len(train_rows), development))
            if development < best_loss:
                best_loss = development
                best_epoch = epoch
                best_state = {name: value.detach().cpu().clone() for name, value in parameters.items()}
            if epoch - best_epoch >= config.patience:
                break
        with torch.no_grad():
            for name, parameter in parameters.items():
                parameter.copy_(best_state[name])
    path, digest = _save_best(
        checkpoint_dir, best_state, model, config, best_epoch, best_loss, len(development_rows)
    )
    return TrainingResult(tuple(history), initial, best_epoch, path, digest, len(history) < config.epochs)
