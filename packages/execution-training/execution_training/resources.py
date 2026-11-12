"""Opt-in measurements and explicit memory estimates; no fabricated throughput figures."""

from __future__ import annotations

import math
import platform
import statistics
import time
from typing import Any, Callable

from .configuration import TrainingConfig
from .errors import TrainingError


def runtime_identity(device: Any) -> dict[str, Any]:
    import torch
    try:
        import numpy as np
    except ImportError:
        numpy_version = None
    else:
        numpy_version = str(np.__version__)
    identity: dict[str, Any] = {
        "python": platform.python_version(), "platform": platform.platform(), "torch": str(torch.__version__),
        "numpy": numpy_version,
        "cuda_available": torch.cuda.is_available(),
        "cuda_runtime": torch.version.cuda, "cudnn": torch.backends.cudnn.version(),
        "device_type": device.type, "device_index": device.index,
        "deterministic_algorithms": torch.are_deterministic_algorithms_enabled(),
        "cudnn_deterministic": torch.backends.cudnn.deterministic,
        "cudnn_benchmark": torch.backends.cudnn.benchmark,
        "cuda_matmul_allow_tf32": torch.backends.cuda.matmul.allow_tf32,
        "cudnn_allow_tf32": torch.backends.cudnn.allow_tf32,
        "torch_num_threads": torch.get_num_threads(),
        "torch_num_interop_threads": torch.get_num_interop_threads(),
    }
    if device.type == "cuda":
        index = device.index if device.index is not None else torch.cuda.current_device()
        props = torch.cuda.get_device_properties(index)
        identity.update(device_index=index, device_name=props.name, device_total_memory=props.total_memory,
                        device_capability=list(torch.cuda.get_device_capability(index)),
                        cuda_device_count=torch.cuda.device_count())
    else:
        identity.update(device_name=platform.processor() or "unknown CPU", cuda_device_count=0)
    return identity


def memory_estimate(parameter_count: int, *, parameter_bytes_per_element: int = 4,
                    gradient_bytes_per_element: int = 4, optimizer: str = "adamw",
                    activations_bytes: int | None = None, cuda_runtime_overhead_bytes: int | None = None,
                    temporary_buffers_bytes: int | None = None) -> dict[str, Any]:
    if type(parameter_count) is not int or parameter_count < 0 or optimizer not in {"adamw", "sgd"}:
        raise TrainingError("INVALID_CONFIGURATION", "Invalid parameter count or optimizer estimate")
    for value in (parameter_bytes_per_element, gradient_bytes_per_element):
        if type(value) is not int or value <= 0:
            raise TrainingError("INVALID_CONFIGURATION", "Invalid element size")
    for value in (activations_bytes, cuda_runtime_overhead_bytes, temporary_buffers_bytes):
        if value is not None and (type(value) is not int or value < 0):
            raise TrainingError("INVALID_CONFIGURATION", "Memory components must be nonnegative or unknown")
    components = {
        "parameters_bytes": parameter_count * parameter_bytes_per_element,
        "gradients_bytes": parameter_count * gradient_bytes_per_element,
        "optimizer_states_bytes": parameter_count * 8 if optimizer == "adamw" else 0,
        "activations_bytes": activations_bytes,
        "cuda_runtime_overhead_bytes": cuda_runtime_overhead_bytes,
        "temporary_buffers_bytes": temporary_buffers_bytes,
    }
    return {"kind": "approximation_not_measurement", "parameter_count": parameter_count,
            "components": components,
            "fp32_adamw_parameter_state_baseline_bytes": parameter_count * 16,
            "known_components_subtotal_bytes": sum(x for x in components.values() if x is not None),
            "total_peak_vram_bytes": sum(components.values()) if all(x is not None for x in components.values()) else None,
            "limitations": "16 bytes/parameter is FP32 parameters + gradients + two Adam moments, not total peak VRAM. "
                           "Optimizer implementation, master copies, allocator fragmentation, attention, batch/context, "
                           "runtime and temporary buffers can increase memory. Activation estimates require measurement."}


def estimate_duration_hours(processed_tokens: int, measured_tokens_per_second: float) -> float:
    if type(processed_tokens) is not int or processed_tokens < 0 or type(measured_tokens_per_second) not in (int, float) or not math.isfinite(measured_tokens_per_second) or measured_tokens_per_second <= 0:
        raise TrainingError("INVALID_MEASUREMENT", "Duration requires a positive measured throughput")
    return processed_tokens / (measured_tokens_per_second * 3600)


class ResourceProfiler:
    """Bounded aggregate metrics, with at most 1024 recent samples retained.

    CUDA synchronization deliberately adds profiling overhead. A caller may provide an actual
    temperature reader; absent that, thermal readings and attribution remain unavailable.
    """

    def __init__(self, config: TrainingConfig, device: Any, *,
                 temperature_reader: Callable[[], float | None] | None = None):
        import torch
        self.config = config
        self.device = device
        self.temperature_reader = temperature_reader
        self.started = time.perf_counter()
        self.steps: list[dict[str, Any]] = []
        self.total_step_seconds = 0.0
        self.total_processed_tokens = 0
        self.total_microsteps = 0
        self.step_count = 0
        self.checkpoint_seconds = 0.0
        self.checkpoint_count = 0
        self.identity = runtime_identity(device)
        if config.profile_enabled and device.type == "cuda":
            torch.cuda.reset_peak_memory_stats(device)

    def _sync(self) -> None:
        if self.config.profile_enabled and self.device.type == "cuda":
            import torch
            torch.cuda.synchronize(self.device)

    def start_step(self) -> float:
        self._sync()
        return time.perf_counter()

    def end_step(self, start: float, processed_tokens: int, microsteps: int, *,
                 microbatch_seconds: float | None = None, optimizer_seconds: float | None = None) -> None:
        self._sync()
        elapsed = time.perf_counter() - start
        if not self.config.profile_enabled:
            return
        if elapsed <= 0 or processed_tokens < 0 or microsteps <= 0:
            raise TrainingError("INVALID_MEASUREMENT", "Invalid step measurement")
        temperature: float | None = None
        sensor_status = "not_configured"
        if self.temperature_reader is not None:
            try:
                reading = self.temperature_reader()
                if reading is not None and math.isfinite(reading):
                    temperature = float(reading)
                    sensor_status = "measured"
                else:
                    sensor_status = "unavailable"
            except Exception:
                sensor_status = "unavailable"
        overhead = None
        if microbatch_seconds is not None and optimizer_seconds is not None:
            overhead = max(0.0, elapsed - microbatch_seconds - optimizer_seconds)
        entry = {"step_seconds": elapsed, "processed_tokens": processed_tokens, "microsteps": microsteps,
                 "tokens_per_second": processed_tokens / elapsed, "microbatch_seconds": microbatch_seconds,
                 "optimizer_seconds": optimizer_seconds, "unattributed_step_overhead_seconds": overhead,
                 "temperature_celsius": temperature, "temperature_sensor_status": sensor_status}
        self.steps.append(entry)
        if len(self.steps) > 1024:
            del self.steps[0]
        self.total_step_seconds += elapsed
        self.total_processed_tokens += processed_tokens
        self.total_microsteps += microsteps
        self.step_count += 1

    def record_checkpoint(self, seconds: float) -> None:
        if not math.isfinite(seconds) or seconds < 0:
            raise TrainingError("INVALID_MEASUREMENT", "Invalid checkpoint time")
        if self.config.profile_enabled:
            self.checkpoint_seconds += seconds
            self.checkpoint_count += 1

    def check_limits(self) -> None:
        limits = self.config.resources
        if limits.max_elapsed_seconds is not None and time.perf_counter() - self.started >= limits.max_elapsed_seconds:
            raise TrainingError("RESOURCE_TIME_LIMIT", "Configured elapsed-time limit reached")
        if limits.max_cuda_reserved_bytes is not None and self.device.type == "cuda":
            import torch
            if torch.cuda.memory_reserved(self.device) > limits.max_cuda_reserved_bytes:
                raise TrainingError("RESOURCE_MEMORY_LIMIT", "Configured CUDA reserved-memory limit exceeded")

    def summary(self) -> dict[str, Any]:
        import torch
        if not self.config.profile_enabled:
            return {"enabled": False, "runtime": self.identity, "measurements": None}
        throughput = self.total_processed_tokens / self.total_step_seconds if self.total_step_seconds else None
        recent_rates = [s["tokens_per_second"] for s in self.steps]
        cuda = None
        if self.device.type == "cuda":
            cuda = {"allocated_bytes": torch.cuda.memory_allocated(self.device),
                    "reserved_bytes": torch.cuda.memory_reserved(self.device),
                    "peak_allocated_bytes": torch.cuda.max_memory_allocated(self.device),
                    "peak_reserved_bytes": torch.cuda.max_memory_reserved(self.device)}
        return {"enabled": True, "runtime": self.identity, "cuda": cuda,
                "measured_steps": self.step_count, "measured_microsteps": self.total_microsteps,
                "measured_training_tokens": self.total_processed_tokens, "step_seconds": self.total_step_seconds,
                "measured_tokens_per_second": throughput,
                "mean_step_latency_seconds": self.total_step_seconds / self.step_count if self.step_count else None,
                "checkpoint_seconds": self.checkpoint_seconds, "checkpoint_count": self.checkpoint_count,
                "recent_throughput_stddev": statistics.pstdev(recent_rates) if len(recent_rates) > 1 else None,
                "recent_step_samples": self.steps,
                "thermal_attribution": "observations_only_no_causal_claim",
                "accumulation_note": "Per-window microsteps, microbatch and optimizer times expose accumulation costs. "
                                     "Comparative accumulation overhead requires separate controlled runs.",
                "throughput_scope": "Optimizer-window training time; validation and checkpoint time are excluded."}
