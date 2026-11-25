from __future__ import annotations

import json
import threading
import time
from queue import Empty, Queue
from types import SimpleNamespace

import pytest

from model_worker.runtime import WorkerLimits, WorkerRuntime, frame


class Engine:
    def __init__(self) -> None:
        self.entered = threading.Event()
        self.released = threading.Event()
        self.released.set()
        self.calls = []
        self.result = {"logits": [0.0, 1.0], "classIndex": 1}

    def prepare(self, operation, head, payload):
        return tuple(payload["inputIds"])

    def batch_key(self, operation, head, value):
        return operation, head, len(value)

    def run_batch(self, operation, head, values):
        self.calls.append((operation, head, values))
        self.entered.set()
        assert self.released.wait(5)
        return [self.result for _ in values]


class Harness:
    def __init__(self, **limits) -> None:
        self.engine = Engine()
        self.output = Queue()
        self.logs = []
        self.runtime = WorkerRuntime(
            self.engine, WorkerLimits.parse(limits),
            lambda value: self.output.put(json.loads(value)),
            lambda event, **fields: self.logs.append((event, fields)),
        )
        self.thread = None
        self.exit_code = None

    def start(self):
        def run():
            self.exit_code = self.runtime.run()

        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()

    def command(self, kind, **fields):
        return self.runtime.feed(frame(kind, **fields), time.monotonic())

    def submit(self, request_id, *, input_ids=(1, 2), timeout=1000, operation="classify", head="test"):
        assert self.command("request", requestId=request_id, operation=operation, head=head,
                            timeoutMs=timeout, input={"inputIds": list(input_ids)})

    def error(self, request_id, code):
        result = self.output.get(timeout=2)
        assert (result["kind"], result["requestId"], result["code"]) == ("error", request_id, code)

    def close(self):
        self.engine.released.set()
        self.runtime.stop()
        if self.thread is not None:
            self.thread.join(5)
            assert not self.thread.is_alive()


@pytest.fixture
def make_runtime():
    workers = []

    def make(**limits):
        worker = Harness(**limits)
        workers.append(worker)
        return worker

    yield make
    for worker in workers:
        worker.close()


def test_batches_compatible_rows_up_to_limit_and_dispatches_partial_batch(make_runtime):
    worker = make_runtime(maxBatchSize=2, maxBatchWaitMs=25)
    worker.submit("A")
    worker.submit("B", input_ids=(1,))
    worker.submit("C")
    worker.submit("D")
    worker.start()

    results = [worker.output.get(timeout=2) for _ in range(4)]
    assert {result["requestId"] for result in results} == {"A", "B", "C", "D"}
    assert all(result["result"] == worker.engine.result for result in results)
    assert worker.engine.calls[0] == ("classify", "test", [(1, 2), (1, 2)])
    assert sorted(len(call[2]) for call in worker.engine.calls) == [1, 1, 2]
    assert all(event == "model_worker_batch" and set(fields) == {"operation", "size", "durationMs"}
               for event, fields in worker.logs)


def test_partial_batch_waits_to_coalesce(make_runtime):
    worker = make_runtime(maxBatchSize=3, maxBatchWaitMs=80)
    started = time.monotonic()
    worker.start()
    worker.submit("A")
    assert not worker.engine.entered.wait(0.01)
    assert worker.output.get(timeout=2)["kind"] == "result"
    assert time.monotonic() - started >= 0.07


def test_backpressure_and_cancellation_leave_peer_request_running(make_runtime):
    worker = make_runtime(maxBatchSize=2, maxPending=2)
    worker.engine.released.clear()
    worker.submit("A")
    worker.submit("B")
    worker.start()
    assert worker.engine.entered.wait(2)
    worker.submit("C")
    worker.error("C", "resource_exhaustion")
    assert worker.command("cancel", requestId="A")
    with pytest.raises(Empty):
        worker.output.get_nowait()
    worker.engine.released.set()
    worker.error("A", "cancelled")
    assert worker.output.get(timeout=2)["requestId"] == "B"
    worker.submit("D")
    assert worker.output.get(timeout=2)["requestId"] == "D"
    assert worker.output.empty()


def test_queue_and_inference_timeouts_discard_late_results(make_runtime):
    worker = make_runtime(maxBatchSize=1)
    worker.engine.released.clear()
    worker.submit("running", timeout=200)
    worker.start()
    assert worker.engine.entered.wait(2)
    worker.submit("queued", timeout=10)
    worker.error("queued", "timeout")
    # Running requests are acknowledged once the in-flight model call releases its row.
    time.sleep(0.21)
    assert worker.output.empty()
    worker.engine.released.set()
    worker.error("running", "timeout")
    assert len(worker.engine.calls) == 1


def test_generation_stream_and_clean_shutdown(make_runtime):
    worker = make_runtime(maxBatchSize=2)
    second_step = threading.Event()
    release_second_step = threading.Event()

    class Session:
        step_number = 0

        def step(self, active):
            self.step_number += 1
            if self.step_number == 2:
                second_step.set()
                assert release_second_step.wait(5)
            return {index: SimpleNamespace(token_id=10 + self.step_number,
                                           stop_reason="eos" if index == 0 else None)
                    for index in active}

    worker.engine.new_generation = lambda _head, _values: Session()
    worker.submit("A", operation="generate")
    worker.submit("B", operation="generate")
    worker.start()
    try:
        token = worker.output.get(timeout=2)
        assert (token["kind"], token["requestId"], token["index"], token["token"]) == ("token", "A", 0, 11)
        assert worker.output.get(timeout=2)["result"] == {"tokenIds": [11], "stopReason": "eos"}
        assert worker.output.get(timeout=2)["requestId"] == "B"
        assert second_step.wait(2)
        assert not worker.command("shutdown")
    finally:
        release_second_step.set()
    worker.error("B", "cancelled")
    worker.thread.join(2)
    assert worker.exit_code == 0
    assert worker.output.empty()


def test_output_limit_and_invalid_request_are_request_local(make_runtime):
    worker = make_runtime(maxOutputBytes=256)
    worker.engine.result = {"logits": [1] * 200}
    worker.start()
    worker.submit("large-output")
    worker.error("large-output", "resource_exhaustion")
    assert worker.command("request", requestId="bad")
    worker.error("bad", "invalid_request")
    worker.engine.result = {"logits": [1]}
    worker.submit("normal")
    assert worker.output.get(timeout=2)["requestId"] == "normal"


@pytest.mark.parametrize("data", [b"\xff\n", b"{}", b" " * 256 + b"\n", b'{"a":1,"a":2}\n'])
def test_bad_framing_stops_worker(make_runtime, data):
    worker = make_runtime(maxInputBytes=256)
    worker.start()
    assert not worker.runtime.feed(data, time.monotonic())
    worker.thread.join(2)
    assert worker.exit_code == 1


@pytest.mark.parametrize("limits", [
    {"maxBatchSize": 65}, {"maxBatchSize": 3, "maxPending": 2}, {"maxTimeoutMs": 600001},
    {"maxOutputTokens": 8193}, {"cpuThreads": True}, {"unknown": 1},
])
def test_invalid_limits_are_rejected(limits):
    with pytest.raises(ValueError):
        WorkerLimits.parse(limits)
