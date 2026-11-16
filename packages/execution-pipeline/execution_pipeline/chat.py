"""Conversation framing and inference for Mohassan's locally trained weights.

No retrieval, canned answers, external providers or tool execution. The exact same
serialized conversation is used by the dataset builder and runtime.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


MODEL_ID = "mohassan-chat-v1"
FORMAT_PREFIX = "Mohassan chat v1\n"
FORMAT_SUFFIX = "\nAssistant:\n"


def conversation_prompt(messages: Any) -> str:
    if not isinstance(messages, list) or not 1 <= len(messages) <= 16:
        raise ValueError("Provide 1 to 16 conversation messages.")
    clean = []
    for message in messages:
        if not isinstance(message, dict) or set(message) != {"role", "content"}:
            raise ValueError("Each message must contain exactly role and content.")
        role, content = message["role"], message["content"]
        if role not in {"user", "assistant"}:
            raise ValueError("Only user and assistant roles are supported.")
        if not isinstance(content, str) or not content.strip() or len(content) > 8000:
            raise ValueError("Message content must be nonempty text up to 8000 characters.")
        if any(ord(char) < 32 and char not in "\n\r\t" for char in content):
            raise ValueError("Message content contains unsupported control characters.")
        content.encode("utf-8", "strict")
        clean.append({"role": role, "content": content})
    if clean[-1]["role"] != "user" or sum(len(item["content"]) for item in clean) > 24000:
        raise ValueError("Conversation must end with user and fit within 24000 characters.")
    return FORMAT_PREFIX + json.dumps(clean, ensure_ascii=False, separators=(",", ":")) + FORMAT_SUFFIX


def sha256_file(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class ChatModel:
    def __init__(self, run: Path, finetune: str, device: str, expected_sha256: str | None = None):
        if Path(finetune).name != finetune or finetune in {".", ".."}:
            raise ValueError("Fine-tune must be a plain directory name.")
        from .ads_worker import AdsWorker
        self.worker = AdsWorker(run.resolve(), device, finetune, expected_sha256)
        self.checkpoint_sha256 = self.worker.checkpoint_sha256

    def answer(self, messages: Any, max_tokens: int = 192) -> dict[str, Any]:
        if type(max_tokens) is not int or not 16 <= max_tokens <= 192:
            raise ValueError("max_tokens must be an integer from 16 to 192.")
        prompt = conversation_prompt(messages)
        input_tokens = len(self.worker.encoder.encode(prompt))
        if input_tokens + max_tokens > self.worker.config.max_context_length:
            raise ValueError("Conversation exceeds this model's context. Start a shorter conversation.")
        result = self.worker.sample({"prompt": prompt, "candidates": 1, "max_new_tokens": max_tokens})[0]
        text = result["text"].strip()
        return {"text": text, "finished": result["finished"], "input_tokens": input_tokens,
                "model": MODEL_ID, "checkpoint_sha256": self.checkpoint_sha256}


def read_readiness(path: Path, checkpoint_sha256: str) -> dict[str, Any]:
    """A separate reviewed receipt must bind this checkpoint to unchanged evidence."""
    receipt = json.loads(path.read_text(encoding="utf-8"))
    if (receipt.get("schemaVersion") != 1 or receipt.get("ready_for_chat") is not True
            or receipt.get("model") != MODEL_ID or receipt.get("checkpoint_sha256") != checkpoint_sha256):
        raise ValueError("This checkpoint has not passed the chat readiness gate.")
    for key in ("assessment", "predictions", "holdout_manifest"):
        pin = receipt.get(key)
        if not isinstance(pin, dict) or not isinstance(pin.get("path"), str):
            raise ValueError("Readiness receipt is missing pinned evidence.")
        evidence = (path.parent / pin["path"]).resolve()
        if not evidence.is_relative_to(path.parent.resolve()) or sha256_file(evidence) != pin.get("sha256"):
            raise ValueError("Readiness evidence is missing or changed.")
    assessment = json.loads((path.parent / receipt["assessment"]["path"]).read_text(encoding="utf-8"))
    if (assessment.get("ready_for_chat") is not True
            or assessment.get("checkpoint_sha256") != checkpoint_sha256
            or assessment.get("predictions_sha256") != receipt["predictions"]["sha256"]):
        raise ValueError("Independent assessment has not approved experimental chat.")
    holdout_path = path.parent / receipt["holdout_manifest"]["path"]
    holdout = json.loads(holdout_path.read_text(encoding="utf-8"))
    for filename, key in (("cases.jsonl", "holdout_sha256"), ("criteria.json", "criteria_sha256")):
        evidence = (holdout_path.parent / filename).resolve()
        if (not evidence.is_relative_to(path.parent.resolve())
                or sha256_file(evidence) != holdout.get(key) or holdout.get(key) != assessment.get(key)):
            raise ValueError("Independent holdout or criteria changed after assessment.")
    return receipt
