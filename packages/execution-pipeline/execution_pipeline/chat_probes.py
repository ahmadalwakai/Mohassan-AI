"""Pinned greedy replies for the frozen v5 chat probes (docs/CHAT-MODEL-TRAINING-PLAN.md section 8.4).

The same protocol discipline as gate3_probes: preparation and checking load no model; prediction renders each
probe with the inference framing (chat.conversation_prompt) and reuses the existing raw greedy decoder. CPU
only, so it can run while the GPU trains. This module does not judge replies, read the holdout or change
readiness.
"""
from __future__ import annotations

from collections import Counter
import json
from pathlib import Path
import re
import time
from typing import Any

from . import REPOSITORY_ROOT
from .chat import conversation_prompt
from .gate3_probes import MAX_NEW_TOKENS, _check_pin, _now, _pin, _write_new_json, raw_continuation, sha256


PROBES = Path("artifacts/chat-training/v5/probes/chat-freeze-20261123/prompts.jsonl")
PROBES_SHA256 = "948ca98a09e7b870737df95fdce3495da0951133d580003e00bd88ff24e88113"
CODE_PATHS = (
    "packages/execution-pipeline/execution_pipeline/__init__.py",
    "packages/execution-pipeline/execution_pipeline/chat_probes.py",
    "packages/execution-pipeline/scripts/chat_probes.py",
    "packages/execution-pipeline/execution_pipeline/chat.py",
    "packages/execution-pipeline/execution_pipeline/gate3_probes.py",
    "packages/execution-pipeline/execution_pipeline/ads_worker.py",
    "packages/execution-pipeline/execution_pipeline/ads_finetune.py",
    "packages/execution-pipeline/execution_pipeline/pretrain.py",
    "packages/execution-model/execution_model/generation.py",
    "packages/execution-model/execution_model/model.py",
    "packages/execution-model/execution_model/config.py",
    "packages/execution-model/execution_model/tokenizer.py",
)
DECODING = {"method": "greedy_argmax", "max_new_tokens": MAX_NEW_TOKENS,
            "framing": "execution_pipeline.chat.conversation_prompt(messages)", "stop_at_eos": True,
            "truncate_prompt": False, "shorten_output_budget": False, "output_token_count_includes_eos": True,
            "seed": 0, "device": "cpu"}
EXPECTED_IDS = [f"chat-{language}-{number:02d}" for language in ("ar", "en") for number in range(1, 21)]


def frozen_probes(root: Path = REPOSITORY_ROOT) -> list[dict[str, Any]]:
    path = root / PROBES
    if sha256(path) != PROBES_SHA256:
        raise ValueError("Frozen v5 chat probes changed; generation refused.")
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if [row.get("id") for row in rows] != EXPECTED_IDS or Counter(row.get("language") for row in rows) != {"ar": 20, "en": 20}:
        raise ValueError("The v5 chat probes need the 40 frozen IDs, 20 per language, in order.")
    for row in rows:
        if (row.get("probe_type") != "chat_reply" or row.get("development_only") is not True
                or row.get("independent_test") is not False or not str(row.get("criterion", "")).strip()):
            raise ValueError(f"Unexpected or incomplete chat probe record: {row.get('id')}")
        conversation_prompt(row["messages"])  # the same validation as at inference
    return rows


def reply_to(worker: Any, row: dict[str, Any]) -> dict[str, Any]:
    """One greedy reply after the exact inference framing of the probe's conversation."""
    return raw_continuation(worker, conversation_prompt(row["messages"]))


def prompt_lengths(encoder: Any, root: Path = REPOSITORY_ROOT) -> dict[str, int]:
    """Prompt tokens per probe; every prompt plus the fixed reply budget must fit the 512-token context."""
    return {row["id"]: len(encoder.encode(conversation_prompt(row["messages"]))) for row in frozen_probes(root)}


def prepare(run: Path, finetune: str, checkpoint_sha256: str, output: Path, *,
            root: Path = REPOSITORY_ROOT) -> dict[str, Any]:
    """Declare one immutable CPU protocol before loading weights or seeing outputs."""
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", finetune) or finetune in {".", ".."}:
        raise ValueError("Checkpoint folder must be a plain name inside the run.")
    if not re.fullmatch(r"[0-9a-f]{64}", checkpoint_sha256):
        raise ValueError("An exact lowercase checkpoint SHA-256 is required.")
    rows = frozen_probes(root)
    run, output = run.resolve(), output.resolve()
    checkpoint = run / finetune / "best.pt"
    if sha256(checkpoint) != checkpoint_sha256:
        raise ValueError("Selected checkpoint SHA-256 does not match.")
    settings = _pin(run / finetune / "settings.json")
    if json.loads(Path(settings["path"]).read_text(encoding="utf-8")).get("prompt_hint") is not None:
        raise ValueError("Chat probes require a checkpoint with no prompt hint.")
    protocol = {
        "schemaVersion": 1, "task": "v5_chat_probe_replies", "prepared_at": _now(), "run": str(run),
        "finetune": finetune, "output": str(output), "checkpoint": _pin(checkpoint), "settings": settings,
        "tokenizer_assets": {name: _pin(run / name) for name in ("tokenizer.json", "tokenizer-report.json")},
        "input": _pin(root / PROBES), "code": {name: _pin(root / name) for name in CODE_PATHS},
        "counts": {"total": len(rows), "ar": 20, "en": 20}, "decoding": DECODING,
        "development_only": True, "independent_test": False, "ready_for_chat": False, "phone_activated": False,
    }
    output.mkdir(parents=True, exist_ok=False)
    _write_new_json(output / "protocol.json", protocol)
    return {"protocol": str(output / "protocol.json"), "protocol_sha256": sha256(output / "protocol.json"),
            "counts": protocol["counts"], "status": "prepared"}


def check(protocol_path: Path, protocol_sha256: str, *, root: Path = REPOSITORY_ROOT) -> dict[str, Any]:
    """Verify every frozen input and source identity; never allocate a model."""
    if sha256(protocol_path) != protocol_sha256:
        raise ValueError("Chat probe protocol changed.")
    protocol = json.loads(protocol_path.read_text(encoding="utf-8"))
    if (protocol.get("schemaVersion") != 1 or protocol.get("task") != "v5_chat_probe_replies"
            or protocol.get("decoding") != DECODING or protocol.get("counts") != {"total": 40, "ar": 20, "en": 20}
            or protocol.get("development_only") is not True or protocol.get("independent_test") is not False
            or protocol.get("ready_for_chat") is not False or protocol.get("phone_activated") is not False):
        raise ValueError("Unexpected v5 chat probe protocol.")
    if Path(protocol["output"]).resolve() != protocol_path.parent.resolve():
        raise ValueError("Protocol and predictions must share the prepared output directory.")
    if (Path(protocol["input"]["path"]).resolve() != (root / PROBES).resolve()
            or protocol["input"]["sha256"] != PROBES_SHA256):
        raise ValueError("Only the frozen v5 chat probes are allowed as input.")
    run = Path(protocol["run"])
    if (Path(protocol["checkpoint"]["path"]).resolve() != (run / protocol["finetune"] / "best.pt").resolve()
            or Path(protocol["settings"]["path"]).resolve() != (run / protocol["finetune"] / "settings.json").resolve()):
        raise ValueError("Checkpoint protocol paths are inconsistent.")
    if set(protocol["code"]) != set(CODE_PATHS):
        raise ValueError("Required source pins are missing.")
    for name, pin in protocol["code"].items():
        if Path(pin["path"]).resolve() != (root / name).resolve():
            raise ValueError("Source pin points outside its declared file.")
    for pin in [protocol["checkpoint"], protocol["settings"], protocol["input"],
                *protocol["tokenizer_assets"].values(), *protocol["code"].values()]:
        _check_pin(pin)
    frozen_probes(root)
    return protocol


def predict(protocol_path: Path, protocol_sha256: str, *, root: Path = REPOSITORY_ROOT) -> dict[str, Any]:
    protocol = check(protocol_path, protocol_sha256, root=root)
    output = Path(protocol["output"])
    if any((output / name).exists() for name in ("started.json", "predictions.jsonl", "manifest.json", "failure.json")):
        raise FileExistsError("This prepared generation was already attempted; do not overwrite or retry it.")
    rows = frozen_probes(root)
    _write_new_json(output / "started.json", {"started_at": _now(), "protocol_sha256": protocol_sha256})
    from .ads_worker import AdsWorker
    import torch

    started = time.perf_counter()
    try:
        torch.set_num_threads(4)
        worker = AdsWorker(Path(protocol["run"]), "cpu", protocol["finetune"], protocol["checkpoint"]["sha256"])
        if worker.hint is not None:
            raise ValueError("Loaded checkpoint has a prompt hint; chat probes refused.")
        counts, finished, stops = Counter(), Counter(), Counter()
        with (output / "predictions.jsonl").open("x", encoding="utf-8", newline="\n") as stream:
            for row in rows:
                began = time.perf_counter()
                try:
                    result = reply_to(worker, row)
                except ValueError as error:
                    result = {"text": "", "finished": False, "stop_reason": "error",
                              "error": f"{type(error).__name__}: {error}"[:400], "output_tokens": 0}
                record = {"id": row["id"], "language": row["language"], "category": row["category"], **result,
                          "ms": round((time.perf_counter() - began) * 1000)}
                stream.write(json.dumps(record, ensure_ascii=False) + "\n")
                stream.flush()
                for key in ("total", row["language"]):
                    counts[key] += 1
                    finished[key] += int(record["finished"])
                stops[record["stop_reason"]] += 1
        check(protocol_path, protocol_sha256, root=root)
        manifest = {"schemaVersion": 1, "task": "v5_chat_probe_replies", "completed_at": _now(),
                    "protocol": _pin(protocol_path), "checkpoint_sha256": worker.checkpoint_sha256,
                    "input": protocol["input"], "predictions": _pin(output / "predictions.jsonl"),
                    "decoding": DECODING, "generated": dict(counts), "finished": dict(finished),
                    "stop_reasons": dict(stops), "elapsed_seconds": round(time.perf_counter() - started, 3),
                    "torch_version": torch.__version__, "development_only": True, "independent_test": False,
                    "ready_for_chat": False, "phone_activated": False, "semantic_judging": "pending_role_c"}
        _write_new_json(output / "manifest.json", manifest)
        return manifest
    except BaseException as error:
        _write_new_json(output / "failure.json", {"failed_at": _now(), "protocol_sha256": protocol_sha256,
                        "error": f"{type(error).__name__}: {error}"[:600], "semantic_judging": "not_completed"})
        raise
