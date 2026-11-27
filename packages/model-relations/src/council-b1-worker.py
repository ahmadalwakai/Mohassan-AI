"""Inference-only worker for the historical B1 checkpoint."""
from __future__ import annotations

import hashlib
import io
import os
import stat
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "packages" / "execution-integration"))
from model_worker.containment import contain
from model_worker.runtime import MAX_FRAME_BYTES, WorkerLimits, WorkerRuntime, frame
from model_worker.worker import _fail_startup, _log, _read_commands, _startup_ms, _write


class CheckpointPinError(ValueError):
    pass


def checkpoint_bytes(path: Path, digest: str) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_FRAME_BYTES:
            raise ValueError("invalid checkpoint size")
        data = stream.read(info.st_size + 1)
        if len(data) != info.st_size or hashlib.sha256(data).hexdigest() != digest:
            raise CheckpointPinError("checkpoint digest mismatch")
        return data


def main() -> int:
    try:
        path, digest, parent, memory = sys.argv[1:]
        limits = WorkerLimits.parse({"memoryBytes": int(memory), "maxBatchSize": 1, "maxBatchWaitMs": 0, "maxPending": 1})
        contain(limits.memory_bytes, limits.cpu_rate_percent, limits.cpu_time_seconds, int(parent))
        if sys.platform == "win32":
            import msvcrt
            msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    except (OSError, ValueError):
        return _fail_startup("containment_failure")

    for name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
        os.environ[name] = str(limits.cpu_threads)
    try:
        checkpoint = io.BytesIO(checkpoint_bytes(Path(path), digest))
        # Load the original model class and tokenizer, with no dataset or training call.
        sys.path.insert(0, str(ROOT / "scripts" / "router"))
        from train import B1, ROUTES, b1_batch, torch

        torch.set_num_threads(limits.cpu_threads)
        torch.set_num_interop_threads(1)
        with checkpoint:
            exported = torch.load(checkpoint, map_location="cpu", weights_only=True)
        chars = exported["chars"]
        if (exported["kind"] != "b1" or exported["routes"] != ROUTES or not isinstance(chars, dict)
                or any(not isinstance(char, str) or len(char) != 1 or type(index) is not int for char, index in chars.items())
                or set(chars.values()) != set(range(2, len(chars) + 2))):
            raise ValueError("incompatible B1 checkpoint")
        router = B1(len(chars) + 2)
        router.load_state_dict(exported.pop("state"), strict=True)
        router.eval()
    except CheckpointPinError:
        return _fail_startup("checkpoint_pin_mismatch")
    except Exception:
        return _fail_startup("model_load_failure")

    class RouterEngine:
        def prepare(self, operation, head, payload):
            text = payload.get("text")
            if (operation != "classify" or head != "route" or payload.keys() != {"text"}
                    or not isinstance(text, str) or not 0 < len(text) <= 8000):
                raise ValueError("invalid B1 input")
            return text

        def batch_key(self, operation, head, value):
            return operation, head

        def run_batch(self, operation, head, values):
            with torch.inference_mode():
                logits = router(b1_batch(values, chars, "cpu"))
                scores, indices = logits.softmax(dim=-1).max(dim=-1)
            return [{"route": ROUTES[index], "confidence": score} for index, score in zip(indices.tolist(), scores.tolist())]

    engine = RouterEngine()
    try:
        engine.run_batch("classify", "route", [""])
    except Exception:
        return _fail_startup("model_load_failure")
    identity = {"modelId": "router-b1", "tokenizerId": f"sha256:{digest}", "checkpointId": f"sha256:{digest}"}
    _write(frame("ready", identity=identity, heads={"route": "classify"}, limits=limits.advertised(),
                 startupMs=_startup_ms(), device="cpu", parity={}))
    runtime = WorkerRuntime(engine, limits, _write, _log)
    reader = threading.Thread(target=_read_commands, args=(runtime,), daemon=True, name="router-b1-stdin")
    reader.start()
    return runtime.run()


if __name__ == "__main__":
    raise SystemExit(main())
