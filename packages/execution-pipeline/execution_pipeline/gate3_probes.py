"""Pinned, raw greedy continuation for the frozen Stage 3 development probes.

Preparation and checking load no model and use no GPU. Prediction reuses the
existing checkpoint/tokenizer loader and bounded model decoder. This module
does not judge replies, read an independent holdout, or change readiness.
"""
from __future__ import annotations

from collections import Counter
from contextlib import nullcontext
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import time
from typing import Any

from . import REPOSITORY_ROOT


PROBES = Path("artifacts/chat-training/v4/probes/gate3-freeze-20261115/prompts.jsonl")
PROBES_SHA256 = "8dd8a1cc149b8f91be575ff7cc1a700b8c9aa96a547eb657304cb0ecfe679995"
MAX_NEW_TOKENS = 192
CODE_PATHS = (
    "packages/execution-pipeline/execution_pipeline/__init__.py",
    "packages/execution-pipeline/execution_pipeline/gate3_probes.py",
    "packages/execution-pipeline/scripts/gate3_probes.py",
    "packages/execution-pipeline/execution_pipeline/ads_worker.py",
    "packages/execution-pipeline/execution_pipeline/ads_finetune.py",
    "packages/execution-pipeline/execution_pipeline/pretrain.py",
    "packages/execution-pipeline/execution_pipeline/chat_diagnostics.py",
    "packages/execution-model/execution_model/generation.py",
    "packages/execution-model/execution_model/model.py",
    "packages/execution-model/execution_model/config.py",
    "packages/execution-model/execution_model/tokenizer.py",
    "packages/execution-model/execution_model/attention.py",
    "packages/execution-model/execution_model/feed_forward.py",
    "packages/execution-model/execution_model/normalization.py",
    "packages/execution-model/execution_model/positional.py",
    "packages/execution-model/execution_model/initialization.py",
    "packages/execution-model/execution_model/constraints.py",
    "packages/execution-model/execution_model/resources.py",
    "packages/execution-model/execution_model/errors.py",
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _write_new_json(path: Path, value: dict[str, Any]) -> None:
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def _pin(path: Path) -> dict[str, Any]:
    return {"path": str(path.resolve()), "sha256": sha256(path), "bytes": path.stat().st_size}


def _check_pin(pin: dict[str, Any]) -> Path:
    path = Path(pin["path"])
    if sha256(path) != pin["sha256"] or path.stat().st_size != pin["bytes"]:
        raise ValueError(f"Pinned evidence changed: {path}")
    return path


def _validate_rows(rows: list[dict[str, Any]]) -> None:
    expected_ids = {f"gate3-{language}-{number:02d}" for language in ("ar", "en") for number in range(1, 21)}
    if len(rows) != 40 or {row.get("id") for row in rows} != expected_ids:
        raise ValueError("Gate 3 requires all 40 unique frozen probe IDs.")
    if Counter(row.get("language") for row in rows) != {"ar": 20, "en": 20}:
        raise ValueError("Gate 3 requires exactly 20 Arabic and 20 English prompts.")
    for row in rows:
        if (not isinstance(row.get("prompt"), str) or not row["prompt"].strip()
                or not isinstance(row.get("criterion"), str) or not row["criterion"].strip()
                or row.get("probe_type") != "raw_prose_continuation"
                or row.get("development_only") is not True or row.get("independent_test") is not False
                or not row["id"].startswith(f"gate3-{row['language']}-")):
            raise ValueError("Unexpected or incomplete frozen probe record.")


def frozen_probes(root: Path = REPOSITORY_ROOT) -> list[dict[str, Any]]:
    path = root / PROBES
    if sha256(path) != PROBES_SHA256:
        raise ValueError("Frozen Gate 3 prompts changed; generation refused.")
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    _validate_rows(rows)
    return rows


def prepare(run: Path, finetune: str, checkpoint_sha256: str, output: Path, *, device: str = "cpu",
            root: Path = REPOSITORY_ROOT) -> dict[str, Any]:
    """Declare one immutable protocol before loading weights or seeing outputs."""
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", finetune) or finetune in {".", ".."}:
        raise ValueError("Checkpoint folder must be a plain name inside the run.")
    if device not in {"cpu", "cuda"}:
        raise ValueError("Device must be cpu or cuda.")
    if not re.fullmatch(r"[0-9a-f]{64}", checkpoint_sha256):
        raise ValueError("An exact lowercase checkpoint SHA-256 is required.")
    rows = frozen_probes(root)
    run, output = run.resolve(), output.resolve()
    checkpoint = run / finetune / "best.pt"
    if sha256(checkpoint) != checkpoint_sha256:
        raise ValueError("Selected checkpoint SHA-256 does not match.")
    assets = {name: _pin(run / name) for name in ("tokenizer.json", "tokenizer-report.json")}
    settings = _pin(run / finetune / "settings.json")
    if json.loads(Path(settings["path"]).read_text(encoding="utf-8")).get("prompt_hint") is not None:
        raise ValueError("Raw continuation requires a checkpoint with no prompt hint.")
    protocol = {
        "schemaVersion": 1, "task": "gate3_raw_continuation", "prepared_at": _now(),
        "run": str(run), "finetune": finetune, "device": device, "output": str(output),
        "checkpoint": _pin(checkpoint), "settings": settings, "tokenizer_assets": assets,
        "input": _pin(root / PROBES), "code": {name: _pin(root / name) for name in CODE_PATHS},
        "counts": {"total": len(rows), "ar": 20, "en": 20},
        "decoding": {"method": "greedy_argmax", "max_new_tokens": MAX_NEW_TOKENS,
                     "raw_prompt": True, "prompt_hint": None, "chat_framing": False,
                     "stop_at_eos": True, "truncate_prompt": False, "shorten_output_budget": False,
                     "output_token_count_includes_eos": True, "seed": 0},
        "development_only": True, "independent_test": False, "ready_for_chat": False,
        "phone_activated": False,
    }
    output.mkdir(parents=True, exist_ok=False)
    _write_new_json(output / "protocol.json", protocol)
    return {"protocol": str(output / "protocol.json"), "protocol_sha256": sha256(output / "protocol.json"),
            "counts": protocol["counts"], "status": "prepared"}


def check(protocol_path: Path, protocol_sha256: str, *, root: Path = REPOSITORY_ROOT) -> dict[str, Any]:
    """Verify all frozen inputs and source identities; never allocate a model."""
    if sha256(protocol_path) != protocol_sha256:
        raise ValueError("Generation protocol changed.")
    protocol = json.loads(protocol_path.read_text(encoding="utf-8"))
    expected_decoding = {"method": "greedy_argmax", "max_new_tokens": MAX_NEW_TOKENS,
                         "raw_prompt": True, "prompt_hint": None, "chat_framing": False,
                         "stop_at_eos": True, "truncate_prompt": False, "shorten_output_budget": False,
                         "output_token_count_includes_eos": True, "seed": 0}
    if (protocol.get("schemaVersion") != 1 or protocol.get("task") != "gate3_raw_continuation"
            or protocol.get("decoding") != expected_decoding
            or protocol.get("counts") != {"total": 40, "ar": 20, "en": 20}
            or protocol.get("development_only") is not True or protocol.get("independent_test") is not False
            or protocol.get("ready_for_chat") is not False or protocol.get("phone_activated") is not False):
        raise ValueError("Unexpected Gate 3 generation protocol.")
    if Path(protocol["output"]).resolve() != protocol_path.parent.resolve():
        raise ValueError("Protocol and predictions must share the prepared output directory.")
    if (Path(protocol["input"]["path"]).resolve() != (root / PROBES).resolve()
            or protocol["input"]["sha256"] != PROBES_SHA256):
        raise ValueError("Only the frozen Gate 3 probes are allowed as input.")
    run = Path(protocol["run"])
    if (protocol["device"] not in {"cpu", "cuda"}
            or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", protocol["finetune"])
            or protocol["finetune"] in {".", ".."}
            or Path(protocol["checkpoint"]["path"]).resolve() != (run / protocol["finetune"] / "best.pt").resolve()
            or Path(protocol["settings"]["path"]).resolve() != (run / protocol["finetune"] / "settings.json").resolve()):
        raise ValueError("Checkpoint protocol paths or device are inconsistent.")
    if set(protocol["code"]) != set(CODE_PATHS) or set(protocol["tokenizer_assets"]) != {"tokenizer.json", "tokenizer-report.json"}:
        raise ValueError("Required source or tokenizer pins are missing.")
    for name, pin in protocol["code"].items():
        if Path(pin["path"]).resolve() != (root / name).resolve():
            raise ValueError("Source pin points outside its declared file.")
    for name, pin in protocol["tokenizer_assets"].items():
        if Path(pin["path"]).resolve() != (run / name).resolve():
            raise ValueError("Tokenizer asset pin points outside its run.")
    for pin in [protocol["checkpoint"], protocol["settings"], protocol["input"],
                *protocol["tokenizer_assets"].values(), *protocol["code"].values()]:
        _check_pin(pin)
    if json.loads(Path(protocol["settings"]["path"]).read_text(encoding="utf-8")).get("prompt_hint") is not None:
        raise ValueError("Raw continuation requires no prompt hint.")
    frozen_probes(root)
    return protocol


def raw_continuation(worker: Any, prompt: str) -> dict[str, Any]:
    """Use the existing decoder and count actual token IDs, including EOS."""
    from execution_model.generation import GenerationConfig, generate
    import torch

    if worker.hint is not None:
        raise ValueError("Raw continuation cannot apply a fine-tune name hint.")
    encoded = worker.encoder.encode(prompt)
    # Refuse overflow instead of silently shortening either the prompt or budget.
    if len(encoded) + MAX_NEW_TOKENS > worker.config.max_context_length:
        raise ValueError("Raw probe and the fixed output budget exceed model context.")
    precision = torch.autocast("cuda", dtype=torch.bfloat16) if worker.device == "cuda" else nullcontext()
    with precision:
        result = generate(worker.model, encoded, GenerationConfig(max_new_tokens=MAX_NEW_TOKENS),
                          eos_token_id=worker.tokenizer.eos_token_id)
    terminal = result.terminal_token_id is not None
    text_ids = result.token_ids[:-1] if terminal else result.token_ids
    raw = worker.tokenizer.decode_bytes(text_ids)
    text = raw.decode("utf-8", "replace")
    return {"text": text, "finished": result.stop_reason == "eos", "stop_reason": result.stop_reason,
            "input_tokens": result.input_tokens, "output_tokens": result.output_tokens,
            "text_tokens": len(text_ids), "terminal_token_id": result.terminal_token_id,
            "generated_token_ids_sha256": hashlib.sha256(json.dumps(result.token_ids, separators=(",", ":")).encode()).hexdigest(),
            "utf8_decode_replacement": text.encode("utf-8") != raw}


def _generate_rows(rows: list[dict[str, Any]], worker: Any, output: Path, guard: Any = None) -> dict[str, Any]:
    counts = {"total": 0, "ar": 0, "en": 0}
    finished = {"total": 0, "ar": 0, "en": 0}
    stop_reasons: Counter[str] = Counter()
    with output.open("x", encoding="utf-8", newline="\n") as stream:
        for row in rows:
            if guard is not None:
                guard.check()
            started = time.perf_counter()
            try:
                result = raw_continuation(worker, row["prompt"])
            except ValueError as error:
                result = {"text": "", "finished": False, "stop_reason": "error",
                          "error": f"{type(error).__name__}: {error}"[:400],
                          "input_tokens": len(worker.encoder.encode(row["prompt"])),
                          "output_tokens": 0, "text_tokens": 0, "terminal_token_id": None}
            record = {"id": row["id"], "language": row["language"], **result,
                      "ms": round((time.perf_counter() - started) * 1000)}
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")
            stream.flush()
            for key in ("total", row["language"]):
                counts[key] += 1
                finished[key] += int(record["finished"])
            stop_reasons[record["stop_reason"]] += 1
            if guard is not None:
                guard.check()
    return {"generated": counts, "finished": finished, "stop_reasons": dict(stop_reasons)}


def predict(protocol_path: Path, protocol_sha256: str, *, root: Path = REPOSITORY_ROOT) -> dict[str, Any]:
    protocol = check(protocol_path, protocol_sha256, root=root)
    output = Path(protocol["output"])
    if any((output / name).exists() for name in ("started.json", "predictions.jsonl", "manifest.json", "failure.json")):
        raise FileExistsError("This prepared generation was already attempted; do not overwrite or retry it.")
    rows = frozen_probes(root)
    _write_new_json(output / "started.json", {"started_at": _now(), "protocol_sha256": protocol_sha256})
    from .ads_worker import AdsWorker
    from .chat_diagnostics import GpuJob
    import torch

    guard = GpuJob(root, output, stage="3-probe-generation", max_seconds=2 * 3600) if protocol["device"] == "cuda" else None
    started = time.perf_counter()
    try:
        with guard if guard is not None else nullcontext():
            if guard is not None:
                if not torch.cuda.is_available():
                    raise RuntimeError("CUDA is unavailable; no device fallback is permitted.")
                torch.empty(1, device="cuda")
                guard.start_monitor()
            worker = AdsWorker(Path(protocol["run"]), protocol["device"], protocol["finetune"],
                               protocol["checkpoint"]["sha256"])
            if worker.hint is not None:
                raise ValueError("Loaded checkpoint has a prompt hint; raw continuation refused.")
            if guard is not None:
                worker.model.register_forward_pre_hook(lambda *_: guard.check())
            summary = _generate_rows(rows, worker, output / "predictions.jsonl", guard)
            if guard is not None:
                guard.check()
        # Verify nothing was changed by another process during generation.
        check(protocol_path, protocol_sha256, root=root)
        manifest = {"schemaVersion": 1, "task": "gate3_raw_continuation", "completed_at": _now(),
                    "protocol": _pin(protocol_path), "checkpoint_sha256": worker.checkpoint_sha256,
                    "input": protocol["input"], "code": protocol["code"],
                    "tokenizer_assets": protocol["tokenizer_assets"], "settings": protocol["settings"],
                    "predictions": _pin(output / "predictions.jsonl"), "scheduled": protocol["counts"],
                    "decoding": protocol["decoding"], "device": protocol["device"],
                    "elapsed_seconds": round(time.perf_counter() - started, 3),
                    "torch_version": torch.__version__, **summary,
                    "development_only": True, "independent_test": False,
                    "ready_for_chat": False, "phone_activated": False, "semantic_judging": "pending_role_c"}
        _write_new_json(output / "manifest.json", manifest)
        return manifest
    except BaseException as error:
        _write_new_json(output / "failure.json", {"failed_at": _now(), "protocol_sha256": protocol_sha256,
                        "error": f"{type(error).__name__}: {error}"[:600],
                        "scheduled": protocol["counts"], "semantic_judging": "not_completed"})
        raise
