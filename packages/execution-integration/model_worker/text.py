"""Pinned local chat tokenization and incremental UTF-8 decoding."""
from __future__ import annotations

from codecs import getincrementaldecoder
from dataclasses import dataclass
from pathlib import Path

from execution_model.checkpoint import _read_json
from execution_model.tokenizer import ByteBPETokenizer
from execution_pipeline.chat import conversation_prompt
from execution_pipeline.pretrain import PRETOKENIZER, pretokenize

from .checkpoints import EngineError, METADATA_BYTES, fields, local_path, pin, snapshot


class TextStream:
    def __init__(self, tokenizer: ByteBPETokenizer) -> None:
        self.tokenizer = tokenizer
        self.special_ids = frozenset(tokenizer.special_token_ids.values())
        self.decoder = getincrementaldecoder("utf-8")()
        self.chunks: list[str] = []

    def push(self, token: int, stop_reason: str | None) -> str:
        if stop_reason == "eos":
            data = b""
        elif token in self.special_ids:
            raise EngineError("invalid_model_output")
        else:
            data = self.tokenizer.token_bytes(token)
        chunk = self.decoder.decode(data, final=stop_reason is not None)
        self.chunks.append(chunk)
        return chunk

    @property
    def text(self) -> str:
        return "".join(self.chunks)


@dataclass(frozen=True)
class TextCodec:
    tokenizer: ByteBPETokenizer
    words: bool

    def encode(self, text: str) -> list[int]:
        prompt = conversation_prompt([{"role": "user", "content": text}])
        if self.words:
            return [token for piece in pretokenize(prompt) for token in self.tokenizer.encode(piece)]
        return self.tokenizer.encode(prompt)

    def stream(self) -> TextStream:
        return TextStream(self.tokenizer)


def load_text_codec(base_dir: Path, descriptor: object, tokenizer_id: str | None, vocab_size: int) -> TextCodec:
    spec = fields(descriptor, {"path", "sha256"}, {"reportPath", "reportSha256"}, "invalid_config")
    tokenizer_limit = 4_194_304
    digest = pin(spec["sha256"])
    with snapshot(local_path(base_dir, spec["path"]), digest, tokenizer_limit) as handle:
        tokenizer = ByteBPETokenizer.from_dict(_read_json(handle, tokenizer_limit))
    if f"sha256:{tokenizer.identity}" != tokenizer_id or tokenizer.vocab_size != vocab_size:
        raise EngineError("invalid_checkpoint")

    words = False
    if "reportPath" in spec or "reportSha256" in spec:
        if not {"reportPath", "reportSha256"} <= spec.keys():
            raise EngineError("invalid_config")
        report_path = local_path(base_dir, spec["reportPath"])
        with snapshot(report_path, pin(spec["reportSha256"]), METADATA_BYTES) as handle:
            report = _read_json(handle, METADATA_BYTES)
        if (report.get("identity") != tokenizer.identity or report.get("sha256") != digest
                or report.get("pretokenizer") not in (None, PRETOKENIZER)):
            raise EngineError("invalid_checkpoint")
        words = report.get("pretokenizer") == PRETOKENIZER
    return TextCodec(tokenizer, words)
