"""Run the contained model worker: python -I -B worker.py CONFIG PARENT_PID."""
from __future__ import annotations

import time

_STARTED = time.monotonic()

from hashlib import sha256
import json
import os
import re
import stat
import sys
import threading
from pathlib import Path
from typing import Any

# Isolated Python excludes the script directory from sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from model_worker.containment import contain
from model_worker.runtime import MAX_FRAME_BYTES, WorkerLimits, WorkerRuntime, frame, parse_json, valid_id


_MODEL_FIELDS = {"checkpoint", "heads", "device", "eosTokenId", "quantization", "tokenizer"}
_HEAD_KINDS = {
    ("classify",): "classify", ("score", "select"): "pointer", ("generate",): "generate",
    ("score-options",): "score-options",
}
_STARTUP_CODES = {
    "invalid_config", "invalid_checkpoint", "checkpoint_pin_mismatch", "model_load_failure",
    "gpu_locked", "gpu_lock_unavailable", "gpu_unavailable", "containment_failure",
}


def _log(event: str, **fields: Any) -> None:
    # A frame-sized log gets one pipe write, even when called by the deadline thread.
    try:
        data = json.dumps({"event": event, **fields}, separators=(",", ":"), allow_nan=False)
        os.write(sys.stderr.fileno(), (data + "\n").encode("ascii"))
    except OSError:
        pass


def _write(data: bytes) -> None:
    try:
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    except OSError:
        os._exit(1)  # No supervisor owns this pipe anymore.


def _fail_startup(code: str) -> int:
    _log("model_worker_startup_failed", code=code, startupMs=_startup_ms())
    _write(frame("startup_error", code=code))
    return 1


def _startup_ms() -> float:
    return round((time.monotonic() - _STARTED) * 1000, 3)


def _read_config(path: Path) -> tuple[dict, dict, WorkerLimits, str]:
    if not path.is_absolute():
        raise ValueError("config must have an absolute path")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
    with os.fdopen(descriptor, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("config must be a regular file")
        data = stream.read(MAX_FRAME_BYTES + 1)
    if len(data) > MAX_FRAME_BYTES:
        raise ValueError("oversized config")
    raw = parse_json(data)
    if (not isinstance(raw, dict) or not {"identity", "model"} <= raw.keys()
            or raw.keys() - {"identity", "model", "limits"}):
        raise ValueError("invalid configuration")
    identity, model = raw["identity"], raw["model"]
    if (not isinstance(identity, dict) or identity.keys() != {"modelId", "tokenizerId", "checkpointId"}
            or not all(valid_id(item) for item in identity.values())
            or not isinstance(model, dict) or model.keys() - _MODEL_FIELDS):
        raise ValueError("invalid model configuration")
    checkpoint = model.get("checkpoint")
    digest = checkpoint.get("sha256") if isinstance(checkpoint, dict) else None
    if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
        raise ValueError("missing checkpoint pin")
    return identity, model, WorkerLimits.parse(raw.get("limits", {})), sha256(data).hexdigest()


def _read_commands(runtime: WorkerRuntime) -> None:
    pending = b""
    try:
        while True:
            # Raw reads avoid a blocked daemon holding the interpreter's stdio lock.
            chunk = os.read(sys.stdin.fileno(), min(64 * 1024, runtime.limits.max_input_bytes))
            if not chunk:
                runtime.stop(failed=bool(pending))
                return
            lines = (pending + chunk).split(b"\n")
            pending = lines.pop()
            for line in lines:
                if not runtime.feed(line + b"\n", time.monotonic()):
                    return
            if len(pending) >= runtime.limits.max_input_bytes:
                runtime.stop(failed=True)
                return
    except Exception:
        runtime.stop(failed=True)


def main() -> int:
    try:
        config_arg, pid_arg = sys.argv[1:]
        config_path = Path(config_arg)
        parent_pid = int(pid_arg)
        if parent_pid <= 0 or parent_pid == os.getpid():
            raise ValueError("invalid parent")
        identity, model, limits, config_digest = _read_config(config_path)
    except (ValueError, OSError, RecursionError):
        return _fail_startup("invalid_config")

    checkpoint = model["checkpoint"]
    if identity["checkpointId"] != "sha256:" + checkpoint["sha256"]:
        return _fail_startup("checkpoint_pin_mismatch")
    if checkpoint.get("format") == "inference" and identity["tokenizerId"] != f"sha256:{checkpoint.get('tokenizerId')}":
        return _fail_startup("invalid_config")
    try:
        contain(limits.memory_bytes, limits.cpu_rate_percent, limits.cpu_time_seconds, parent_pid)
        if sys.platform == "win32":
            import msvcrt
            msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    except Exception:
        return _fail_startup("containment_failure")

    _log("model_worker_loading")
    os.environ["OPENBLAS_NUM_THREADS"] = "1"
    os.environ["OMP_NUM_THREADS"] = str(limits.cpu_threads)
    os.environ["MKL_NUM_THREADS"] = str(limits.cpu_threads)
    engine = None
    try:
        from model_worker.engine import load_engine, torch

        torch.set_num_threads(limits.cpu_threads)
        torch.set_num_interop_threads(1)
        engine = load_engine(model, base_dir=config_path.parent, max_output_tokens=limits.max_output_tokens,
                             tokenizer_id=identity["tokenizerId"])
        heads = {name: _HEAD_KINDS[head.operations] for name, head in engine.heads.items()}
        ready = frame("ready", identity=identity, heads=heads, limits=limits.advertised(), startupMs=_startup_ms(),
                      device=engine.device.type, parity=engine.parity_report, configSha256=config_digest,
                      **({"text": True} if engine.text is not None else {}))
        if len(ready) > MAX_FRAME_BYTES:
            raise ValueError("oversized readiness")
    except Exception as error:
        if engine is not None:
            try:
                engine.close()
            except Exception:
                _log("model_worker_cleanup_failed")
        code = getattr(error, "code", None)
        return _fail_startup(code if isinstance(code, str) and code in _STARTUP_CODES else "model_load_failure")

    _write(ready)
    _log("model_worker_ready", device=engine.device.type, heads=len(heads), startupMs=_startup_ms())
    runtime = WorkerRuntime(engine, limits, _write, _log)
    reader = threading.Thread(target=_read_commands, args=(runtime,), daemon=True, name="model-worker-stdin")
    reader.start()
    exit_code = 1
    try:
        exit_code = runtime.run()
    except Exception:
        _log("model_worker_runtime_failed")
    finally:
        try:
            engine.close()
        except Exception:
            exit_code = 1
            _log("model_worker_cleanup_failed")
    _log("model_worker_stopped", exitCode=exit_code)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
