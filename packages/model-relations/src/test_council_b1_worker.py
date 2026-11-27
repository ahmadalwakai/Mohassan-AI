"""Exercise the worker with a computed, untrained checkpoint and the real transport."""
from __future__ import annotations

import hashlib
import json
import os
import select
import subprocess
import sys
from pathlib import Path

import pytest
import torch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts" / "router"))
sys.path.insert(0, str(ROOT / "packages" / "execution-integration"))
from model_worker.runtime import PROTOCOL
from train import B1, ROUTES

SCRIPT = Path(__file__).with_name("council-b1-worker.py")


def read_frame(worker):
    assert select.select([worker.stdout], [], [], 45)[0], "B1 worker emitted no frame"
    return json.loads(worker.stdout.readline())


def exchange(checkpoint, digest):
    request = {"protocol": PROTOCOL, "kind": "request", "requestId": "turn", "operation": "classify",
               "head": "route", "timeoutMs": 10000, "input": {"text": "a"}}
    payload = json.dumps(request) + "\n"
    command = [sys.executable, "-I", "-B", str(SCRIPT), str(checkpoint), digest,
               str(os.getpid()), str(4 * 1024**3)]
    with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as worker:
        # EOF requests shutdown, so keep stdin open until the real request can finish.
        try:
            ready = read_frame(worker)
            result = None
            if ready["kind"] == "ready":
                worker.stdin.write(payload)
                worker.stdin.flush()
                result = read_frame(worker)
                worker.stdin.write(json.dumps({"protocol": PROTOCOL, "kind": "shutdown"}) + "\n")
                worker.stdin.flush()
            return ready, result, worker.wait(timeout=15)
        finally:
            if worker.poll() is None:
                worker.kill()


@pytest.mark.skipif(sys.platform != "linux", reason="uses the contained Linux model worker")
def test_b1_worker_uses_the_checkpoint_route_order_and_rejects_changed_bytes(tmp_path):
    torch.set_num_threads(1)
    chars = {"a": 2}
    model = B1(len(chars) + 2)
    route = "chat"
    with torch.no_grad():
        for parameter in model.parameters():
            parameter.zero_()
        model.head.bias[ROUTES.index(route)] = 2
    checkpoint = tmp_path / "router-b1.pt"
    torch.save({"kind": "b1", "state": model.state_dict(), "chars": chars, "routes": ROUTES}, checkpoint)
    digest = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
    ready, frame, code = exchange(checkpoint, digest)
    assert code == 0
    assert ready["identity"]["checkpointId"] == f"sha256:{digest}"
    assert frame["requestId"] == "turn"
    expected = torch.nn.functional.one_hot(torch.tensor(ROUTES.index(route)), len(ROUTES)).float() * 2
    assert frame["result"] == {"route": route, "confidence": pytest.approx(expected.softmax(dim=0).max().item())}

    checkpoint.write_bytes(checkpoint.read_bytes() + b"changed")
    ready, frame, code = exchange(checkpoint, digest)
    assert code == 1
    assert ready["kind"] == "startup_error"
    assert ready["code"] == "checkpoint_pin_mismatch"
    assert frame is None
