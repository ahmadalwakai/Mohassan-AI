"""Try dynamic int8 CPU projections and retain them only for heads that pass parity."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from copy import copy
from dataclasses import dataclass, field
import math
import sys
from typing import TYPE_CHECKING, Any, Iterator

import torch
from torch import Tensor, nn

from execution_model.errors import NumericalError

if TYPE_CHECKING:
    from .engine import WorkerEngine


_INT8 = ContextVar("worker_int8", default=False)


@contextmanager
def use_int8(active: bool) -> Iterator[None]:
    previous = _INT8.set(active)
    try:
        yield
    finally:
        _INT8.reset(previous)


class _RoutedLinear(nn.Module):
    def __init__(self, original: nn.Linear) -> None:
        super().__init__()
        self.fp32: nn.Linear | None = original
        # Conversion reads qconfig from the source module. Keep its metadata intact.
        configured = copy(original)
        configured.qconfig = torch.ao.quantization.default_dynamic_qconfig
        self.int8 = torch.ao.nn.quantized.dynamic.Linear.from_float(configured)

    def forward(self, inputs: Tensor) -> Tensor:
        if self.fp32 is None or _INT8.get():
            # Dynamic activation ranges are calculated per tensor by PyTorch.
            # Keep one request's range independent of its batch neighbors.
            if inputs.shape[0] == 1:
                return self.int8(inputs)
            return torch.cat([self.int8(row) for row in inputs.split(1)], dim=0)
        return self.fp32(inputs)


@dataclass
class _LinearSite:
    parent: nn.Module
    name: str
    original: nn.Linear
    users: set[str] = field(default_factory=set)
    replacement: _RoutedLinear | None = None


def _linear_sites(module: nn.Module) -> Iterator[tuple[nn.Module, str, nn.Linear]]:
    for name, child in module.named_children():
        if type(child) is nn.Linear:
            if child.weight.device.type == "cpu" and child.weight.dtype == torch.float32:
                yield module, name, child
        elif not isinstance(child, nn.TransformerEncoderLayer):
            # GoalTagger's fused encoder accesses its Linear parameters directly.
            yield from _linear_sites(child)


@dataclass(frozen=True)
class _Probes:
    min_top1: float
    max_difference: float
    min_token_agreement: float | None
    samples: list[tuple[str, Any]]


def _threshold(value: object, maximum: float = sys.float_info.max) -> float:
    if type(value) not in (int, float) or not 0 <= value <= maximum:
        raise ValueError("Invalid worker quantization threshold.")
    return float(value)


def _probes(engine: WorkerEngine, name: str, config: object) -> _Probes:
    if not isinstance(config, dict) or config.keys() != {"thresholds", "probes"}:
        raise ValueError("Invalid worker quantization probe configuration.")
    thresholds = config["thresholds"]
    required = {"minTop1Agreement", "maxAbsoluteLogitDifference"}
    optional = {"minGreedyTokenAgreement"}
    if not isinstance(thresholds, dict) or not required <= thresholds.keys() <= required | optional:
        raise ValueError("Worker quantization requires explicit parity thresholds.")
    min_top1 = _threshold(thresholds["minTop1Agreement"], 1)
    max_difference = _threshold(thresholds["maxAbsoluteLogitDifference"])
    min_token_agreement = None
    if "minGreedyTokenAgreement" in thresholds:
        min_token_agreement = _threshold(thresholds["minGreedyTokenAgreement"], 1)
    operations = set(engine.heads[name].operations)
    if "generate" in operations:
        if min_token_agreement is None:
            raise ValueError("Generation quantization requires a greedy token agreement threshold.")
    elif min_token_agreement is not None:
        raise ValueError("Greedy token agreement applies only to generation heads.")

    probes = config["probes"]
    if not isinstance(probes, list) or not 1 <= len(probes) <= 64:
        raise ValueError("Worker quantization requires between one and 64 probes per head.")
    prepared = []
    for probe in probes:
        if not isinstance(probe, dict) or probe.keys() != {"operation", "payload"}:
            raise ValueError("Invalid worker quantization probe.")
        operation, payload = probe["operation"], probe["payload"]
        if not isinstance(operation, str) or operation not in operations or not isinstance(payload, dict):
            raise ValueError("Worker quantization probe operation is invalid for this head.")
        value = engine.prepare(operation, name, payload)
        if operation == "generate" and (value.config.do_sample or value.config.max_new_tokens < 1):
            raise ValueError("Generation quantization probes must use greedy decoding.")
        prepared.append((operation, value))
    if {operation for operation, _ in prepared} != operations:
        raise ValueError("Worker quantization probes must cover every operation on the head.")
    return _Probes(min_top1, max_difference, min_token_agreement, prepared)


@dataclass
class _Metrics:
    top1_matches: int = 0
    top1_total: int = 0
    max_difference: float = 0.0
    token_matches: int = 0
    token_total: int = 0
    selection_unchanged: bool = True
    cache_tokens_unchanged: bool = True

    def record_logits(self, reference: Tensor | dict[str, Tensor], candidate: Tensor | dict[str, Tensor]) -> None:
        if isinstance(reference, dict) and isinstance(candidate, dict) and reference.keys() == candidate.keys():
            for name in reference:
                self.record_logits(reference[name], candidate[name])
            return
        if not isinstance(reference, Tensor) or not isinstance(candidate, Tensor):
            raise NumericalError("Parity logits have mismatched fields.")
        if reference.shape != candidate.shape or reference.ndim < 1 or reference.numel() == 0:
            raise NumericalError("Parity logits have invalid shapes.")
        difference = (reference.double() - candidate.double()).abs().amax().item()
        if not math.isfinite(difference):
            raise NumericalError("Parity logits have nonfinite values.")
        reference_top1 = reference.argmax(dim=-1)
        candidate_top1 = candidate.argmax(dim=-1)
        self.top1_matches += int((reference_top1 == candidate_top1).sum().item())
        self.top1_total += reference_top1.numel()
        self.max_difference = max(self.max_difference, difference)

    def record_generation(self, head: Any, value: Any) -> None:
        with use_int8(False):
            reference = head.new_generation([value])
        with use_int8(True):
            candidate = head.new_generation([value])
            alternate = head.new_generation([value], use_cache=not candidate.cache_enabled)
        reference_running = candidate_running = same_prefix = True
        while reference_running or candidate_running:
            with use_int8(False):
                fp32 = reference.step([0])[0] if reference_running else None
            with use_int8(True):
                int8 = candidate.step([0])[0] if candidate_running else None
                if int8 is not None and self.cache_tokens_unchanged:
                    other = alternate.step([0])[0]
                    self.cache_tokens_unchanged = (
                        int8.token_id == other.token_id and int8.stop_reason == other.stop_reason
                    )
            reference_running = fp32 is not None and fp32.stop_reason is None
            candidate_running = int8 is not None and int8.stop_reason is None
            if same_prefix and fp32 is not None and int8 is not None:
                # Logits are comparable only while both computations share the same prefix.
                self.record_logits(fp32.logits, int8.logits)
            same_token = fp32 is not None and int8 is not None and fp32.token_id == int8.token_id
            self.token_matches += int(same_token)
            self.token_total += 1
            same_prefix = same_prefix and same_token


def _report(reason: str, samples: int = 0, metrics: _Metrics | None = None) -> dict[str, Any]:
    return {
        "top1Agreement": metrics.top1_matches / metrics.top1_total if metrics and metrics.top1_total else None,
        "maxAbsoluteLogitDifference": metrics.max_difference if metrics and metrics.top1_total else None,
        "greedyTokenAgreement": metrics.token_matches / metrics.token_total if metrics and metrics.token_total else None,
        "adopted": reason == "passed",
        "reason": reason,
        "samples": samples,
    }


def _evaluate(head: Any, probes: _Probes) -> dict[str, Any]:
    metrics = _Metrics()
    samples = 0
    try:
        with torch.inference_mode():
            for operation, value in probes.samples:
                if operation == "generate":
                    metrics.record_generation(head, value)
                else:
                    with use_int8(False):
                        reference = head.logits([value])[0]
                    with use_int8(True):
                        candidate = head.logits([value])[0]
                    metrics.record_logits(reference, candidate)
                    if operation in ("select", "score-options") and head.prediction(value, reference) != head.prediction(value, candidate):
                        metrics.selection_unchanged = False
                samples += 1
    except (RuntimeError, NumericalError):
        return _report("evaluation_failed", samples)

    if not metrics.selection_unchanged:
        return _report("selection_changed", samples, metrics)
    if not metrics.cache_tokens_unchanged:
        return _report("cache_tokens_changed", samples, metrics)
    min_token_agreement = probes.min_token_agreement
    if (
        not metrics.top1_total
        or metrics.top1_matches / metrics.top1_total < probes.min_top1
        or metrics.max_difference > probes.max_difference
        or (
            min_token_agreement is not None
            and (not metrics.token_total or metrics.token_matches / metrics.token_total < min_token_agreement)
        )
    ):
        return _report("thresholds_failed", samples, metrics)
    return _report("passed", samples, metrics)


def apply_quantization(engine: WorkerEngine, config: object) -> dict[str, dict[str, Any]]:
    """Evaluate each configured head and select precision on the existing module graph."""
    if config is None:
        return {}
    if not isinstance(config, dict) or not config.keys() <= engine.heads.keys():
        raise ValueError("Quantization configuration must be keyed by a known worker head.")
    probes = {name: _probes(engine, name, entry) for name, entry in config.items()}
    reports = {name: _report("no_probes") for name in engine.heads if name not in probes}
    if engine.device.type != "cpu":
        reports.update({name: _report("not_cpu") for name in probes})
        return reports

    sites: dict[tuple[int, str], _LinearSite] = {}
    for name, head in engine.heads.items():
        for module in (head.trunk, head.projection):
            if module is None:
                continue
            for parent, attribute, original in _linear_sites(module):
                site = sites.setdefault((id(parent), attribute), _LinearSite(parent, attribute, original))
                site.users.add(name)

    try:
        with torch.no_grad():
            for site in sites.values():
                if site.users.isdisjoint(probes):
                    continue
                try:
                    site.replacement = _RoutedLinear(site.original).eval()
                    setattr(site.parent, site.name, site.replacement)
                except (RuntimeError, AttributeError):
                    # Some CPU builds lack eager dynamic quantization kernels.
                    continue

        adopted = set()
        for name, head_probes in probes.items():
            head_sites = [site for site in sites.values() if name in site.users]
            if not head_sites:
                reports[name] = _report("no_linear_layers")
            elif any(site.replacement is None for site in head_sites):
                reports[name] = _report("unsupported_backend")
            else:
                reports[name] = _evaluate(engine.heads[name], head_probes)
            if reports[name]["adopted"]:
                adopted.add(name)
        engine.quantized_heads.update(adopted)
    finally:
        for site in sites.values():
            if site.replacement is None:
                continue
            if site.users.isdisjoint(engine.quantized_heads):
                setattr(site.parent, site.name, site.original)
            elif site.users <= engine.quantized_heads:
                # Keep float projections only when some head still uses them.
                site.replacement.fp32 = None
    return reports
