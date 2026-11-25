"""Fit temperature and abstention thresholds using labelled calibration rows."""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

import torch
from torch import Tensor
from torch.nn.utils.rnn import pad_sequence

LogitRows = Tensor | Sequence[Tensor | Sequence[float]]
TargetRows = Tensor | Sequence[int | Sequence[int]]
_THRESHOLDS = (1e-9, *(index / 20 for index in range(1, 21)))


@dataclass(frozen=True)
class CalibrationResult:
    temperature: float
    min_confidence: float | None
    min_margin: float | None
    count: int
    accepted: int
    accuracy: float | None
    ece_before: float
    ece_after: float
    nll_before: float
    nll_after: float
    bins: int

    @property
    def coverage(self) -> float:
        return self.accepted / self.count

    def as_worker_record(self) -> dict[str, float] | None:
        """An all-abstaining result has no deployable threshold record."""
        if self.min_confidence is None or self.min_margin is None:
            return None
        return {
            "temperature": self.temperature,
            "minConfidence": self.min_confidence,
            "minMargin": self.min_margin,
        }


@dataclass(frozen=True)
class Decision:
    index: int | None
    confidence: float


def decide(logits: Sequence[float], calibration: Mapping[str, float] | None) -> Decision:
    """Apply the provider's confidence and margin policy to a raw worker row."""
    if not logits or any(type(value) not in (int, float) or not math.isfinite(value) for value in logits):
        raise ValueError("Worker logits must be a nonempty row of finite numbers.")
    if len(logits) < 2 or calibration is None:
        return Decision(None, 0.0)
    temperature = calibration.get("temperature", math.nan)
    min_confidence = calibration.get("minConfidence", math.nan)
    min_margin = calibration.get("minMargin", math.nan)
    if (not math.isfinite(temperature) or temperature <= 0
            or not 0 <= min_confidence <= 1 or not 0 <= min_margin <= 1):
        raise ValueError("Invalid worker temperature or abstention thresholds.")

    best = max(logits)
    winner = logits.index(best)
    weights = [math.exp((value - best) / temperature) for value in logits]
    total = 0.0
    for weight in weights:
        total += weight
    runner_up = max(weight for index, weight in enumerate(weights) if index != winner)
    confidence = 1 / total
    margin = (1 - runner_up) / total
    accepted = margin > 0 and margin >= min_margin and confidence >= min_confidence
    return Decision(winner if accepted else None, confidence)


def _prepare(logits: LogitRows, targets: TargetRows) -> tuple[Tensor, Tensor]:
    if (isinstance(logits, Tensor) and logits.ndim != 2) or (isinstance(targets, Tensor) and targets.ndim != 1):
        raise ValueError("Calibration tensors must have shape [rows, classes] and [rows].")
    rows = [torch.as_tensor(row, dtype=torch.float64, device="cpu").detach() for row in logits]
    labels = targets.tolist() if isinstance(targets, Tensor) else targets
    if not rows or len(rows) != len(labels):
        raise ValueError("Calibration needs nonempty, aligned logits and targets.")
    positive_rows = []
    for row, label in zip(rows, labels, strict=True):
        # Candidate rows are unpadded. Padding is introduced only after validation.
        if row.ndim != 1 or len(row) < 2 or not bool(torch.isfinite(row).all()):
            raise ValueError("Each calibration row needs two or more finite logits.")
        indices = (label,) if type(label) is int else label
        if not isinstance(indices, Sequence) or not indices or any(
            type(index) is not int or not 0 <= index < len(row) for index in indices
        ):
            raise ValueError("Calibration targets must identify at least one candidate in each row.")
        positive = torch.zeros(len(row), dtype=torch.bool)
        positive[list(indices)] = True
        positive_rows.append(positive)
    values = pad_sequence(rows, batch_first=True, padding_value=-math.inf)
    return values - values.max(dim=1, keepdim=True).values, pad_sequence(positive_rows, batch_first=True)


def _negative_log_likelihood(logits: Tensor, positive: Tensor, log_temperature: float) -> float:
    values = logits / math.exp(log_temperature)
    all_candidates = values.logsumexp(dim=1)
    correct_candidates = values.masked_fill(~positive, -math.inf).logsumexp(dim=1)
    return float((all_candidates - correct_candidates).mean())


def _fit_temperature(logits: Tensor, positive: Tensor) -> tuple[float, float, float]:
    # A coarse search followed by local refinement also handles multiple acceptable candidates.
    grid = [index / 4 for index in range(-24, 25)]
    losses = [_negative_log_likelihood(logits, positive, value) for value in grid]
    best = min(range(len(grid)), key=lambda index: (losses[index], abs(grid[index])))
    left, right = grid[max(0, best - 1)], grid[min(len(grid) - 1, best + 1)]
    for _ in range(30):
        lower = left + (right - left) / 3
        upper = right - (right - left) / 3
        if _negative_log_likelihood(logits, positive, lower) < _negative_log_likelihood(logits, positive, upper):
            right = upper
        else:
            left = lower
    refined = (left + right) / 2
    refined_loss = _negative_log_likelihood(logits, positive, refined)
    if refined_loss < losses[best]:
        return math.exp(refined), losses[len(grid) // 2], refined_loss
    return math.exp(grid[best]), losses[len(grid) // 2], losses[best]


def _confidence(logits: Tensor, temperature: float) -> tuple[Tensor, Tensor]:
    weights = (logits / temperature).exp()
    totals = weights.sum(dim=1)
    runner_up = weights.topk(2, dim=1).values[:, 1]
    return totals.reciprocal(), (1 - runner_up) / totals


def _ece(confidence: Tensor, correct: Tensor, bins: int) -> float:
    # Use the gate runner's half-open equal-width bins, with 1.0 in the last bin.
    boundaries = torch.arange(1, bins, dtype=torch.float64) / bins
    indices = torch.bucketize(confidence.contiguous(), boundaries, right=True)
    errors = torch.zeros(bins, dtype=torch.float64)
    errors.scatter_add_(0, indices, confidence - correct.to(torch.float64))
    return float(errors.abs().sum() / len(correct))


def fit_calibration(
    logits: LogitRows,
    targets: TargetRows,
    *,
    min_accuracy: float,
    bins: int = 15,
) -> CalibrationResult:
    """Minimise NLL, then choose the threshold grid point with the widest acceptable coverage."""
    if type(bins) is not int or bins < 1 or not 0 <= min_accuracy <= 1:
        raise ValueError("Calibration needs positive bins and a minimum accuracy in [0, 1].")
    values, positive = _prepare(logits, targets)
    temperature, nll_before, nll_after = _fit_temperature(values, positive)
    confidence, margin = _confidence(values, temperature)
    correct = positive.gather(1, values.argmax(dim=1, keepdim=True)).flatten()
    best: tuple[int, int, float, float] | None = None
    for min_confidence in _THRESHOLDS:
        confident = confidence >= min_confidence
        for min_margin in _THRESHOLDS:
            accepted = confident & (margin >= min_margin)
            count = int(accepted.sum())
            successes = int((accepted & correct).sum())
            if count and successes / count >= min_accuracy:
                candidate = (count, successes, -min_confidence, -min_margin)
                if best is None or candidate > best:
                    best = candidate

    return CalibrationResult(
        temperature=temperature,
        min_confidence=-best[2] if best else None,
        min_margin=-best[3] if best else None,
        count=len(values),
        accepted=best[0] if best else 0,
        accuracy=best[1] / best[0] if best else None,
        ece_before=_ece(_confidence(values, 1)[0], correct, bins),
        ece_after=_ece(confidence, correct, bins),
        nll_before=nll_before,
        nll_after=nll_after,
        bins=bins,
    )
