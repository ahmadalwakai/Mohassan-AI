"""Local inference worker speaking Phase 5's ``mohassan.execution.local.v1`` stdio protocol.

One process, one handshake, at most one generation, then exit. No network client,
no tool access, no file writes. It loads exactly one pinned checkpoint through
Phase 2's strict loader and refuses to start if any pinned identity differs.

Output is an untrusted candidate. Validation, permissions, sandboxed execution
and verification all happen in the TypeScript supervisor, never here.

Usage: python -m execution_pipeline.worker --checkpoint DIR --model-id ID
       --tokenizer-id sha256:HEX --checkpoint-id sha256:HEX [--device cpu|cuda]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

PROTOCOL = "mohassan.execution.local.v1"
MAX_INPUT_BYTES = 65_536
MAX_OUTPUT_TOKENS = 96


def _emit(document: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


class Worker:
    def __init__(self, checkpoint: Path, *, model_id: str, tokenizer_id: str, checkpoint_id: str, device: str):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        import execution_pipeline  # noqa: F401
        from execution_model.config import ModelConfig
        from execution_model.inference import InferenceEngine
        from execution_model.resources import ResourceConfig
        config = ModelConfig.from_dict(json.loads((checkpoint / "config.json").read_text(encoding="utf-8")))
        if not tokenizer_id.startswith("sha256:") or not checkpoint_id.startswith("sha256:"):
            raise SystemExit(2)
        self.engine = InferenceEngine(ResourceConfig(device=device, dtype="float32",
                                                     max_context_length=config.max_context_length,
                                                     max_output_tokens=MAX_OUTPUT_TOKENS, max_input_bytes=MAX_INPUT_BYTES))
        metadata = self.engine.load_local_model(checkpoint.resolve(), expected_config=config,
                                                expected_tokenizer_identity=tokenizer_id.removeprefix("sha256:"))
        if metadata.checkpoint_identity != checkpoint_id.removeprefix("sha256:"):
            raise SystemExit(3)
        self.identity = {"modelId": model_id, "tokenizerId": tokenizer_id, "checkpointId": checkpoint_id}

    def ready(self) -> dict[str, Any]:
        from execution_pipeline.tasks import CAPABILITIES
        return {"protocol": PROTOCOL, "kind": "ready", "identity": self.identity, "capabilities": sorted(CAPABILITIES),
                "limits": {"maxInputBytes": MAX_INPUT_BYTES, "maxOutputTokens": MAX_OUTPUT_TOKENS}}

    def generate_text(self, prompt: str, max_tokens: int) -> tuple[str | None, int, str]:
        from execution_model.generation import GenerationConfig
        # Never request more new tokens than the context window has left after the prompt.
        available = self.engine.resources.max_context_length - len(self.engine.encode_task_input(prompt))
        if available < 1:
            return None, 0, "CONTEXT_OVERFLOW"
        response = self.engine.generate_candidate(prompt, GenerationConfig(max_new_tokens=min(max_tokens, available)))
        if response.status != "completed" or response.candidate is None:
            return None, 0, (response.error or {}).get("code", "generation_failed")
        candidate = response.candidate
        return candidate.text, candidate.generation.output_tokens, candidate.generation.stop_reason

    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        from execution_pipeline.tasks import UnsupportedTask, render
        base = {"protocol": PROTOCOL, "requestId": request.get("requestId"), "taskId": request.get("taskId"),
                "identity": self.identity}
        expected = {"protocol", "kind", "identity", "requestId", "taskId", "capability", "contract", "context", "maxOutputTokens"}
        if set(request) != expected or request["kind"] != "generate" or request["identity"] != self.identity:
            return {**base, "kind": "error", "code": "invalid_request"}
        max_tokens = request["maxOutputTokens"]
        if type(max_tokens) is not int or not 1 <= max_tokens <= MAX_OUTPUT_TOKENS:
            return {**base, "kind": "error", "code": "invalid_request"}
        contract = request["contract"]
        missing = contract.get("missingContextKeys") if isinstance(contract, dict) else None
        if missing:
            # The supervisor already found these gaps; the model never invents context.
            return {**base, "kind": "result", "status": "missing_context", "missingContextKeys": missing}
        try:
            prompt = render(request["capability"], contract.get("fields", {}) if isinstance(contract, dict) else {})
        except UnsupportedTask:
            return {**base, "kind": "result", "status": "unsupported", "capability": request["capability"]}
        started = time.perf_counter()
        text, tokens, stop = self.generate_text(prompt, max_tokens)
        if text is None:
            return {**base, "kind": "error", "code": "model_process_failure"}
        return {**base, "kind": "result", "status": "candidate", "outputTokens": tokens,
                "proposal": {"text": text, "stopReason": stop, "generationMs": round((time.perf_counter() - started) * 1000, 1)}}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--tokenizer-id", required=True)
    parser.add_argument("--checkpoint-id", required=True)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    args = parser.parse_args()
    worker = Worker(args.checkpoint, model_id=args.model_id, tokenizer_id=args.tokenizer_id,
                    checkpoint_id=args.checkpoint_id, device=args.device)
    _emit(worker.ready())
    line = sys.stdin.buffer.readline(MAX_INPUT_BYTES + 1)
    if not line:
        return 0  # discovery only
    if len(line) > MAX_INPUT_BYTES:
        _emit({"protocol": PROTOCOL, "kind": "error", "requestId": None, "taskId": None,
               "identity": worker.identity, "code": "invalid_request"})
        return 1
    try:
        request = json.loads(line.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return 1
    _emit(worker.handle(request) if isinstance(request, dict) else {"kind": "error"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
