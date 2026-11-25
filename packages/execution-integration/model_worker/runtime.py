"""Bounded NDJSON admission and scheduling for a single inference engine."""
from __future__ import annotations

import json
import math
import re
import threading
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:
    from .text import TextStream


PROTOCOL = "mohassan.execution.worker.v1"
MAX_FRAME_BYTES = 16 * 1024 * 1024
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,255}")
OPERATIONS = {"classify", "score", "select", "generate", "score-options"}
REQUEST_CODES = {
    "invalid_request", "unsupported_capability", "invalid_model_output",
    "model_process_failure", "resource_exhaustion", "timeout", "cancelled",
}

# Configuration name, default, minimum, maximum.
_LIMITS = {
    "memory_bytes": ("memoryBytes", 4 * 1024**3, 128 * 1024**2, 1024**4),
    "cpu_rate_percent": ("cpuRatePercent", 75, 1, 100),
    "cpu_time_seconds": ("cpuTimeSeconds", 86_400, 1, 31_536_000),
    "cpu_threads": ("cpuThreads", 1, 1, 16),
    "max_batch_size": ("maxBatchSize", 8, 1, 64),
    "max_batch_wait_ms": ("maxBatchWaitMs", 4, 0, 1_000),
    "max_pending": ("maxPending", 64, 1, 1_024),
    "max_input_bytes": ("maxInputBytes", 256 * 1024, 256, MAX_FRAME_BYTES),
    "max_output_bytes": ("maxOutputBytes", 1024**2, 256, 64 * 1024**2),
    "max_output_tokens": ("maxOutputTokens", 256, 1, 8_192),
    "max_timeout_ms": ("maxTimeoutMs", 120_000, 1, 600_000),
}


@dataclass(frozen=True)
class WorkerLimits:
    memory_bytes: int
    cpu_rate_percent: int
    cpu_time_seconds: int
    cpu_threads: int
    max_batch_size: int
    max_batch_wait_ms: int
    max_pending: int
    max_input_bytes: int
    max_output_bytes: int
    max_output_tokens: int
    max_timeout_ms: int

    @classmethod
    def parse(cls, value: Any) -> WorkerLimits:
        if not isinstance(value, dict) or value.keys() - {entry[0] for entry in _LIMITS.values()}:
            raise ValueError("invalid limits")
        limits = {}
        for field_name, (config_name, default, minimum, maximum) in _LIMITS.items():
            limit = value.get(config_name, default)
            if type(limit) is not int or not minimum <= limit <= maximum:
                raise ValueError("invalid limit")
            limits[field_name] = limit
        if limits["max_batch_size"] > limits["max_pending"]:
            raise ValueError("batch limit exceeds pending limit")
        return cls(**limits)

    def advertised(self) -> dict[str, int]:
        return {entry[0]: getattr(self, field_name) for field_name, entry in _LIMITS.items()
                if field_name.startswith("max_")}


def valid_id(value: Any) -> bool:
    return isinstance(value, str) and IDENTIFIER.fullmatch(value) is not None


def frame(kind: str, **fields: Any) -> bytes:
    value = {"protocol": PROTOCOL, "kind": kind, **fields}
    return (json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")) + "\n").encode("ascii")


def parse_json(data: bytes) -> Any:
    def object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        value = dict(pairs)
        if len(value) != len(pairs):
            raise ValueError("duplicate JSON key")
        return value

    def finite_number(value: str) -> float:
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("nonfinite JSON number")
        return number

    return json.loads(data.decode("utf-8"), object_pairs_hook=object_pairs,
                      parse_float=finite_number, parse_constant=finite_number)


def error_code(error: Exception, default: str) -> str:
    code = getattr(error, "code", None)
    if isinstance(code, str) and code in REQUEST_CODES:
        return code
    if isinstance(error, MemoryError):
        return "resource_exhaustion"
    return default


@dataclass
class Request:
    request_id: str
    operation: str
    head: str
    value: Any
    batch_key: Any
    received: float
    deadline: float
    text_stream: TextStream | None = None
    started: bool = False
    termination: str | None = None
    output_bytes: int = 0
    token_ids: list[int] = field(default_factory=list)


class WorkerRuntime:
    def __init__(self, engine: Any, limits: WorkerLimits, write: Callable[[bytes], None],
                 log: Callable[..., None]):
        self.engine = engine
        self.limits = limits
        self.write = write
        self.log = log
        self._condition = threading.Condition()
        self._pending: dict[str, Request] = {}
        self._stopping = False
        self._failed = False

    def feed(self, data: bytes, received: float) -> bool:
        if len(data) > self.limits.max_input_bytes or not data.endswith(b"\n"):
            return self.stop(failed=True)
        try:
            raw = parse_json(data)
        except (ValueError, RecursionError):
            return self.stop(failed=True)
        if not isinstance(raw, dict) or raw.get("protocol") != PROTOCOL:
            return self.stop(failed=True)

        kind = raw.get("kind")
        if kind == "shutdown" and raw.keys() == {"protocol", "kind"}:
            return self.stop()
        request_id = raw.get("requestId")
        if not valid_id(request_id):
            return self.stop(failed=True)

        with self._condition:
            if self._stopping:
                return False
            if kind == "cancel" and raw.keys() == {"protocol", "kind", "requestId"}:
                request = self._pending.get(request_id)
                if request is not None:
                    self._terminate(request, "cancelled")
                return True
            if request_id in self._pending:
                return self.stop(failed=True)
            self._admit(raw, request_id, received)
        return True

    def _admit(self, raw: dict[str, Any], request_id: str, received: float) -> None:
        head, operation, timeout, payload = (raw.get(key) for key in ("head", "operation", "timeoutMs", "input"))
        if (raw.get("kind") != "request" or raw.keys() != {
            "protocol", "kind", "requestId", "operation", "head", "timeoutMs", "input",
        } or not valid_id(head) or not isinstance(operation, str) or operation not in OPERATIONS
            or type(timeout) is not int or not 1 <= timeout <= self.limits.max_timeout_ms
            or not isinstance(payload, dict)):
            self._error(request_id, "invalid_request")
            return
        if len(self._pending) >= self.limits.max_pending:
            self._error(request_id, "resource_exhaustion")
            return
        try:
            value = self.engine.prepare(operation, head, payload)
            key = self.engine.batch_key(operation, head, value)
            text_stream = self.engine.text.stream() if operation == "generate" and "text" in payload else None
        except Exception as error:
            self._error(request_id, error_code(error, "invalid_request"))
            return
        deadline = received + timeout / 1000
        if time.monotonic() >= deadline:
            self._error(request_id, "timeout")
            return
        self._pending[request_id] = Request(request_id, operation, head, value, key, received, deadline, text_stream)
        self._condition.notify_all()

    def _error(self, request_id: str, code: str) -> None:
        self.write(frame("error", requestId=request_id, code=code))
        self.log("model_worker_request_rejected", code=code)

    def _forget(self, request: Request) -> None:
        del self._pending[request.request_id]
        self._condition.notify_all()

    def _finish_error(self, request: Request, code: str) -> None:
        self._forget(request)
        self._error(request.request_id, code)

    def _terminate(self, request: Request, code: str) -> None:
        if request.termination is not None:
            return
        request.termination = "timeout" if time.monotonic() >= request.deadline else code
        if not request.started:
            self._finish_error(request, request.termination)
        self._condition.notify_all()

    def _can_emit(self, request: Request) -> bool:
        if request.termination is None and time.monotonic() >= request.deadline:
            request.termination = "timeout"
        if request.termination is None:
            return True
        self._finish_error(request, request.termination)
        return False

    def _emit(self, request: Request, kind: str, **fields: Any) -> bool:
        try:
            data = frame(kind, requestId=request.request_id, **fields)
        except (TypeError, ValueError, RecursionError, MemoryError) as error:
            self._finish_error(request, error_code(error, "invalid_model_output"))
            return False
        request.output_bytes += len(data)
        if len(data) > MAX_FRAME_BYTES or request.output_bytes > self.limits.max_output_bytes:
            self._finish_error(request, "resource_exhaustion")
            return False
        self.write(data)
        if kind == "result":
            self._forget(request)
        return True

    def stop(self, *, failed: bool = False) -> bool:
        with self._condition:
            self._failed |= failed
            if not self._stopping:
                self._stopping = True
                for request in list(self._pending.values()):
                    self._terminate(request, "model_process_failure" if failed else "cancelled")
            self._condition.notify_all()
        return False  # The input reader should stop accepting frames.

    def _watch_deadlines(self) -> None:
        with self._condition:
            while not self._stopping:
                now = time.monotonic()
                next_deadline = None
                for request in list(self._pending.values()):
                    if request.termination is not None:
                        continue
                    if request.deadline <= now:
                        self._terminate(request, "timeout")
                    elif next_deadline is None or request.deadline < next_deadline:
                        next_deadline = request.deadline
                self._condition.wait(None if next_deadline is None else max(0, next_deadline - time.monotonic()))

    def _next_batch(self, skip_generation: bool) -> tuple[list[Request], float | None]:
        groups: dict[Any, list[Request]] = {}
        for request in self._pending.values():
            if not request.started and not (skip_generation and request.operation == "generate"):
                groups.setdefault(request.batch_key, []).append(request)
        next_due = None
        now = time.monotonic()
        for group in groups.values():
            due = group[0].received + self.limits.max_batch_wait_ms / 1000
            if len(group) >= self.limits.max_batch_size or now >= due:
                batch = group[:self.limits.max_batch_size]
                for request in batch:
                    request.started = True
                return batch, 0
            if next_due is None or due < next_due:
                next_due = due
        return [], None if next_due is None else max(0, next_due - now)

    def _batch_error(self, batch: list[Request], error: Exception) -> None:
        with self._condition:
            for request in batch:
                if self._pending.get(request.request_id) is request and self._can_emit(request):
                    self._finish_error(request, error_code(error, "model_process_failure"))

    def _start_batch(self, batch: list[Request]) -> tuple[list[Request], Any] | None:
        with self._condition:
            batch = [request for request in batch if self._can_emit(request)]
        if not batch:
            return None
        operation, head = batch[0].operation, batch[0].head
        values = [request.value for request in batch]
        started = time.monotonic()
        try:
            if operation == "generate":
                return batch, self.engine.new_generation(head, values)
            results = self.engine.run_batch(operation, head, values)
            if len(results) != len(batch) or any(not isinstance(value, dict) for value in results):
                raise ValueError("invalid batch result")
        except Exception as error:
            self._batch_error(batch, error)
            return None
        finally:
            self.log("model_worker_batch", operation=operation, size=len(batch),
                     durationMs=round((time.monotonic() - started) * 1000, 3))
        with self._condition:
            for request, result in zip(batch, results):
                if self._can_emit(request):
                    self._emit(request, "result", result=result)
        return None

    def _generation_step(self, generation: tuple[list[Request], Any]) -> bool:
        batch, session = generation
        with self._condition:
            active = [index for index, request in enumerate(batch)
                      if self._pending.get(request.request_id) is request and self._can_emit(request)]
        if not active:
            return False
        try:
            steps = session.step(active)
            if steps.keys() != set(active):
                raise ValueError("invalid generation step")
        except Exception as error:
            self._batch_error(batch, error)
            return False
        with self._condition:
            for index in active:
                request, step = batch[index], steps[index]
                if not self._can_emit(request):
                    continue
                position = len(request.token_ids)
                if (type(step.token_id) is not int or step.token_id < 0
                    or step.stop_reason not in (None, "eos", "length")
                    or (position + 1 >= self.limits.max_output_tokens and step.stop_reason is None)):
                    self._finish_error(request, "invalid_model_output")
                    continue
                text_fields: dict = {}
                if request.text_stream is not None:
                    try:
                        text_fields["text"] = request.text_stream.push(step.token_id, step.stop_reason)
                    except Exception as error:
                        self._finish_error(request, error_code(error, "invalid_model_output"))
                        continue
                if not self._emit(request, "token", token=step.token_id, index=position, **text_fields):
                    continue
                request.token_ids.append(step.token_id)
                if step.stop_reason is not None:
                    result = {"tokenIds": request.token_ids, "stopReason": step.stop_reason}
                    if request.text_stream is not None:
                        result.update(text=request.text_stream.text, inputTokens=len(request.value.input_ids))
                    self._emit(request, "result", result=result)
            return any(self._pending.get(request.request_id) is request for request in batch)

    def run(self) -> int:
        watchdog = threading.Thread(target=self._watch_deadlines, daemon=True, name="model-worker-deadlines")
        watchdog.start()
        generation = None
        prefer_generation = False
        try:
            while True:
                with self._condition:
                    if self._stopping and not self._pending:
                        return int(self._failed)
                    if generation is not None and prefer_generation:
                        batch = []
                    else:
                        batch, delay = self._next_batch(generation is not None)
                        if not batch and generation is None:
                            self._condition.wait(delay)
                            continue
                if batch:
                    started_generation = self._start_batch(batch)
                    if started_generation is not None:
                        generation = started_generation
                    prefer_generation = True
                elif generation is not None:
                    if not self._generation_step(generation):
                        generation = None
                    prefer_generation = False
        finally:
            self.stop()
            watchdog.join()
