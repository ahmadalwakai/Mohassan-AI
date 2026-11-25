"""Measure CPU round-trip latency for a fresh random 85M model over worker stdio."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import tempfile
import time

import torch

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "packages" / package) for package in ("execution-model", "execution-pipeline")]

from execution_model.config import model_preset
from execution_model.model import ExecutionModel
from execution_pipeline.pretrain import BENCHMARK_SHAPES

PROTOCOL = "mohassan.execution.worker.v1"
WARMUPS = 5
SAMPLES = 30
PROMPT_LENGTH = 32
NEW_TOKENS = 6


def write_frame(pipe, kind, **fields):
    pipe.write(json.dumps({"protocol": PROTOCOL, "kind": kind, **fields}) + "\n")


def read_frame(pipe):
    line = pipe.readline()
    if not line:
        raise RuntimeError("Worker exited while the benchmark was running.")
    frame = json.loads(line)
    if frame["protocol"] != PROTOCOL:
        raise RuntimeError("Unexpected worker protocol.")
    return frame


def benchmark_batch(child, batch_size, run, vocab_size):
    ids = {f"{batch_size}-{run}-{row}" for row in range(batch_size)}
    tokens = dict.fromkeys(ids, 0)
    started = time.perf_counter()
    for row in range(batch_size):
        prompt = [1 + ((position + row * 97) % (vocab_size - 1)) for position in range(PROMPT_LENGTH)]
        write_frame(
            child.stdin, "request", requestId=f"{batch_size}-{run}-{row}", timeoutMs=30_000,
            operation="generate", head="lm", input={"inputIds": prompt, "maxNewTokens": NEW_TOKENS},
        )
    child.stdin.flush()
    while ids:
        frame = read_frame(child.stdout)
        request = frame.get("requestId")
        if request not in ids:
            raise RuntimeError("Unexpected benchmark request ID.")
        if frame["kind"] == "token" and frame["index"] == tokens[request]:
            tokens[request] += 1
        elif frame["kind"] == "result" and tokens[request] == NEW_TOKENS:
            ids.remove(request)
        else:
            raise RuntimeError(f"Unexpected benchmark response kind {frame['kind']}.")
    return (time.perf_counter() - started) * 1000


def main():
    torch.set_num_threads(4)
    shape = model_preset("B", vocab_size=24_576, max_context_length=512, seed=1729, **BENCHMARK_SHAPES["85m"])
    with (
        tempfile.TemporaryDirectory(prefix="model-worker-benchmark-") as directory,
        tempfile.TemporaryFile(mode="w+t", encoding="utf-8") as logs,
    ):
        folder = Path(directory)
        checkpoint = folder / "random.pt"
        # This is the pipeline's tensor/config layout with fresh weights and no training state.
        model = ExecutionModel(shape)
        torch.save({"config": shape.to_dict(), "model_state": model.state_dict()}, checkpoint)
        del model
        with checkpoint.open("rb") as handle:
            digest = hashlib.file_digest(handle, "sha256").hexdigest()
        config = folder / "worker.json"
        config.write_text(json.dumps({
            "identity": {"modelId": "random-85m", "tokenizerId": "numeric-ids", "checkpointId": f"sha256:{digest}"},
            "model": {"checkpoint": {"sha256": digest, "path": checkpoint.name}},
            "limits": {"cpuThreads": 4, "maxBatchSize": 8, "maxBatchWaitMs": 3, "maxOutputTokens": NEW_TOKENS},
        }), encoding="utf-8")

        started = time.perf_counter()
        child = subprocess.Popen(
            [sys.executable, "-I", "-B", str(Path(__file__).resolve().with_name("worker.py")), str(config), str(os.getpid())],
            cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=logs,
            text=True, encoding="utf-8",
        )
        try:
            ready = read_frame(child.stdout)
            launch_ms = (time.perf_counter() - started) * 1000
            if ready["kind"] != "ready" or ready["device"] != "cpu":
                raise RuntimeError(f"CPU worker did not become ready: {ready.get('code', ready['kind'])}.")
            results = [{
                "platform": platform.platform(), "torch": torch.__version__, "parameters": shape.parameter_count(),
                "promptTokens": PROMPT_LENGTH, "newTokens": NEW_TOKENS, "threads": 4, "warmups": WARMUPS,
                "samplesPerBatchSize": SAMPLES, "launchToReadyMs": round(launch_ms, 2),
                "workerStartupMs": ready["startupMs"], "maxBatchWaitMs": ready["limits"]["maxBatchWaitMs"],
            }]
            for batch_size in (1, 8):
                times = [benchmark_batch(child, batch_size, run, shape.vocab_size) for run in range(WARMUPS + SAMPLES)]
                measured = sorted(times[WARMUPS:])
                results.append({
                    "batchSize": batch_size, "p50Ms": round(statistics.median(measured), 2),
                    "p95Ms": round(measured[math.ceil(0.95 * len(measured)) - 1], 2),
                })
            write_frame(child.stdin, "shutdown")
            child.stdin.flush()
            if child.wait(timeout=10) != 0:
                raise RuntimeError("Benchmark worker failed to shut down cleanly.")
            logs.seek(0)
            events = (json.loads(line) for line in logs if line.startswith("{"))
            sizes = [event["size"] for event in events if event["event"] == "model_worker_batch"]
            expected = [size for size in (1, 8) for _ in range(WARMUPS + SAMPLES)]
            if sizes != expected:
                raise RuntimeError("Worker batch sizes differed from benchmark batch sizes.")
            for row in results:
                print(json.dumps(row), flush=True)
        finally:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=10)


if __name__ == "__main__":
    main()
