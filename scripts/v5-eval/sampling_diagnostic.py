"""Sample the frozen v5 probes on CPU for the end-of-run diagnostic."""

from __future__ import annotations

import argparse
from collections import Counter
from collections.abc import Sequence
import hashlib
import json
from pathlib import Path
import sys
import time
from types import MappingProxyType
from typing import Any

if __name__ == "__main__":
    sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages" / "execution-pipeline"))

from execution_pipeline import REPOSITORY_ROOT, gate3_probes


# Owner's CHAT-MODEL-TRAINING-PLAN.md §8.8, pre-registered 2026-11-25 (provided in the task).
_SAMPLING = MappingProxyType({
    "do_sample": True, "temperature": 0.7, "top_p": 0.9, "top_k": 0, "max_new_tokens": 192,
})
_SEEDS = (1, 2, 3)
_EOS_TOKEN_ID = 258


def _prediction(worker: Any, result: Any) -> dict[str, Any]:
    # Same evidence as gate3_probes.raw_continuation, with the terminal token excluded only from text.
    text_ids = result.token_ids if result.terminal_token_id is None else result.token_ids[:-1]
    raw = worker.tokenizer.decode_bytes(text_ids)
    text = raw.decode("utf-8", "replace")
    return {
        "text": text,
        "finished": result.stop_reason == "eos",
        "stop_reason": result.stop_reason,
        "input_tokens": result.input_tokens,
        "output_tokens": result.output_tokens,
        "text_tokens": len(text_ids),
        "terminal_token_id": result.terminal_token_id,
        "generated_token_ids_sha256": hashlib.sha256(
            json.dumps(result.token_ids, separators=(",", ":")).encode("utf-8")
        ).hexdigest(),
        "utf8_decode_replacement": text.encode("utf-8") != raw,
    }


def _code_pins(protocol: dict[str, Any]) -> dict[str, Any]:
    # Gate 3 also enumerates model internals shared with chat. Include both possible decoders.
    paths = set(protocol["code"]) | set(gate3_probes.CODE_PATHS) | {
        "packages/execution-model/execution_model/__init__.py",
        "packages/execution-model/execution_model/cached_generation.py",
        Path(__file__).resolve().relative_to(REPOSITORY_ROOT).as_posix(),
    }
    return {name: gate3_probes._pin(REPOSITORY_ROOT / name) for name in sorted(paths)}


def run_diagnostic(protocol_path: Path, protocol_sha256: str, output: Path, *,
                   reference: bool = False) -> dict[str, Any]:
    protocol_bytes = protocol_path.read_bytes()
    if hashlib.sha256(protocol_bytes).hexdigest() != protocol_sha256:
        raise ValueError("Probe protocol SHA-256 does not match.")
    header = json.loads(protocol_bytes)
    task = header.get("task") if isinstance(header, dict) else None
    is_chat = task == "v5_chat_probe_replies"
    if is_chat:
        from execution_pipeline import chat_probes as probes
    elif task == "gate3_raw_continuation":
        probes = gate3_probes
    else:
        raise ValueError("Expected a protocol prepared by chat_probes or gate3_probes.")
    protocol = probes.check(protocol_path, protocol_sha256)

    if output.resolve() == Path(protocol["output"]).resolve():
        raise FileExistsError("The diagnostic cannot use the protocol's output directory.")
    output.mkdir(parents=True, exist_ok=False)

    began = time.perf_counter()
    started_at = gate3_probes._now()
    try:
        code = _code_pins(protocol)
        rows = probes.frozen_probes()
        import torch
        from execution_pipeline.ads_worker import AdsWorker
        from execution_model.generation import GenerationConfig, generate
        from execution_model.cached_generation import generate_cached

        # Match the CPU thread count in the pinned chat probe predictor.
        # https://github.com/ahmadalwakai/Mohassan-AI/blob/c2a0ff7/packages/execution-pipeline/execution_pipeline/chat_probes.py (retrieved 2026-11-25)
        torch.set_num_threads(4)
        worker = AdsWorker(Path(protocol["run"]), "cpu", protocol["finetune"], protocol["checkpoint"]["sha256"])
        if worker.hint is not None:
            raise ValueError("Probe generation requires a checkpoint without a prompt hint.")
        if worker.tokenizer.eos_token_id != _EOS_TOKEN_ID:
            raise ValueError("The checkpoint tokenizer does not have the v5 EOS token.")
        worker.model.to(device="cpu", dtype=torch.float32)
        decoder = generate if reference else generate_cached
        configs = [GenerationConfig(**_SAMPLING, seed=seed) for seed in _SEEDS]
        decoding = {
            **_SAMPLING, "device": "cpu", "dtype": "float32", "stop_at_eos": True,
            "eos_token_id": _EOS_TOKEN_ID, "backend": "generate" if reference else "generate_cached",
        }
        predictions = output / "predictions.jsonl"
        counts: Counter[str] = Counter()
        identity_fields = ("id", "language", "category") if is_chat else ("id", "language")
        with predictions.open("x", encoding="utf-8", newline="\n") as stream, torch.autocast("cpu", enabled=False):
            for row in rows:
                prompt = probes.conversation_prompt(row["messages"]) if is_chat else row["prompt"]
                encoded = worker.encoder.encode(prompt)
                if len(encoded) + _SAMPLING["max_new_tokens"] > worker.config.max_context_length:
                    raise ValueError(f"{row['id']} and the fixed output budget exceed model context.")
                identity = {field: row[field] for field in identity_fields}
                for config in configs:
                    started = time.perf_counter()
                    result = decoder(worker.model, encoded, config, eos_token_id=_EOS_TOKEN_ID)
                    record = {**identity, **_prediction(worker, result),
                              "ms": round((time.perf_counter() - started) * 1000),
                              "seed": config.seed, "decoding": decoding}
                    stream.write(json.dumps(record, ensure_ascii=False) + "\n")
                    counts["total"] += 1
                    counts[row["language"]] += 1

        probes.check(protocol_path, protocol_sha256)
        if _code_pins(protocol) != code:
            raise ValueError("Sampling source files changed during generation.")
        manifest = {
            "schemaVersion": 1, "task": "v5_sampling_diagnostic", "counts_toward_gate": False,
            "source_task": task, "protocol_sha256": protocol_sha256, "checkpoint_sha256": worker.checkpoint_sha256,
            "code": code, "settings": protocol["settings"], "decoding": decoding, "seeds": list(_SEEDS),
            "predictions": gate3_probes._pin(predictions), "generated": dict(counts),
            "started_at": started_at, "completed_at": gate3_probes._now(),
            "elapsed_seconds": round(time.perf_counter() - began, 3), "torch_version": torch.__version__,
        }
        gate3_probes._write_new_json(output / "manifest.json", manifest)
        return manifest
    except BaseException as error:
        gate3_probes._write_new_json(output / "failure.json", {
            "failed_at": gate3_probes._now(), "protocol_sha256": protocol_sha256,
            "error": f"{type(error).__name__}: {error}"[:600],
        })
        raise


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--protocol", required=True, type=Path)
    parser.add_argument("--protocol-sha256", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--reference", action="store_true", help="Use the reference generator instead of the cached generator.")
    args = parser.parse_args(argv)
    print(json.dumps(run_diagnostic(args.protocol, args.protocol_sha256, args.output, reference=args.reference),
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
