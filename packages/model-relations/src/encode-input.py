"""Encode a local head or Ads input without loading weights or initializing CUDA."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys

PACKAGES = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(PACKAGES / name) for name in ("execution-pipeline", "head-training")]

from execution_pipeline.pretrain import ENCODE_CHUNK_CHARS, PRETOKENIZER, pretokenize
from execution_model.tokenizer import ByteBPETokenizer


def read_pin(pin: dict, limit: int) -> dict:
    with Path(pin["path"]).open("rb") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit or hashlib.sha256(data).hexdigest() != pin["sha256"]:
        raise ValueError("Tokenizer pin mismatch")
    return json.loads(data)


class ApprovedTokenizer:
    def __init__(self, request: dict):
        descriptor = request["tokenizer"]
        self.tokenizer = ByteBPETokenizer.from_dict(read_pin(descriptor, 4_194_304))
        if request["tokenizerId"] != f"sha256:{self.tokenizer.identity}":
            raise ValueError("Tokenizer identity mismatch")
        report_pin = request.get("tokenizerReport")
        if report_pin is None and descriptor.get("reportPath"):
            report_pin = {"path": descriptor["reportPath"], "sha256": descriptor["reportSha256"]}
        report = read_pin(report_pin, 65_536) if report_pin else {}
        if report and (report.get("identity") != self.tokenizer.identity or report.get("sha256") != descriptor["sha256"]):
            raise ValueError("Tokenizer report mismatch")
        self.words = report.get("pretokenizer") == PRETOKENIZER

    def encode(self, text: str) -> list[int]:
        if self.words:
            return [token for piece in pretokenize(text) for token in self.tokenizer.encode(piece)]
        return [token for start in range(0, len(text), ENCODE_CHUNK_CHARS)
                for token in self.tokenizer.encode(text[start:start + ENCODE_CHUNK_CHARS])]


def main() -> int:
    if len(sys.argv) != 2:
        return 2
    data = sys.stdin.buffer.read(2_097_153)
    if len(data) > 2_097_152:
        return 2
    try:
        request = json.loads(data)
        encoder = ApprovedTokenizer(request)
    except (OSError, ValueError, KeyError, TypeError):
        return 1
    try:
        mode = sys.argv[1]
        if mode == "head":
            from head_training.encoding import encode_input

            if encoder.tokenizer.eos_token_id != request["eosTokenId"]:
                return 1
            encoded = encode_input(encoder, request["text"], eos_token_id=request["eosTokenId"],
                                   max_tokens=request["maxTokens"], history=request.get("history", ()),
                                   candidates=request.get("candidates", ()))
            result = encoded.worker_payload()
            if encoded.candidate_indices:
                result["candidateIndices"] = list(encoded.candidate_indices)
        elif mode == "ads-encode":
            result = encoder.encode(request["text"])
        elif mode == "ads-decode":
            result = encoder.tokenizer.decode_bytes(request["tokens"], skip_special_tokens=True).decode("utf-8", errors="replace")
        else:
            return 2
        print(json.dumps(result, ensure_ascii=True))
        return 0
    except (ValueError, KeyError, TypeError):
        return 2


if __name__ == "__main__":
    sys.exit(main())
