from hashlib import sha256
import json

import pytest

from execution_model.tokenizer import ByteBPETokenizer
from execution_pipeline.chat import conversation_prompt
from execution_pipeline.pretrain import TextEncoder
from model_worker.checkpoints import EngineError
from model_worker.text import load_text_codec, TextStream


def test_pinned_tokenizer_matches_training_pretokenizer(tmp_path):
    tokenizer = ByteBPETokenizer([(ord("a"), ord(" ")), (263, ord("b"))])
    tokenizer_path = tmp_path / "tokenizer.json"
    tokenizer.save(tokenizer_path)
    tokenizer_digest = sha256(tokenizer_path.read_bytes()).hexdigest()
    report_path = tmp_path / "tokenizer-report.json"
    report_path.write_text(json.dumps({"pretokenizer": "words-v1", "identity": tokenizer.identity,
                                       "sha256": tokenizer_digest}), encoding="utf-8")
    spec = {"path": tokenizer_path.name, "sha256": tokenizer_digest, "reportPath": report_path.name,
            "reportSha256": sha256(report_path.read_bytes()).hexdigest()}
    identity = "sha256:" + tokenizer.identity
    codec = load_text_codec(tmp_path, spec, identity, tokenizer.vocab_size)
    text = "a b — أين المكتبة؟"
    prompt = conversation_prompt([{"role": "user", "content": text}])
    assert codec.encode(text) == TextEncoder(tmp_path).encode(prompt)
    assert codec.encode(text) != tokenizer.encode(prompt)
    with pytest.raises(EngineError, match="invalid_checkpoint"):
        load_text_codec(tmp_path, spec, "sha256:" + "0" * 64, tokenizer.vocab_size)
    report_path.write_text("{}", encoding="utf-8")
    with pytest.raises(EngineError, match="checkpoint_pin_mismatch"):
        load_text_codec(tmp_path, spec, identity, tokenizer.vocab_size)


def test_text_stream_reassembles_arabic_bytes_and_omits_eos():
    tokenizer = ByteBPETokenizer()
    stream = TextStream(tokenizer)
    first, second = "أ".encode("utf-8")
    assert stream.push(first, None) == ""
    assert stream.push(second, None) == "أ"
    assert stream.push(ord("!"), None) == "!"
    assert stream.push(tokenizer.eos_token_id, "eos") == ""
    assert stream.text == "أ!"
    incomplete = TextStream(tokenizer)
    incomplete.push(first, None)
    with pytest.raises(UnicodeDecodeError):
        incomplete.push(tokenizer.eos_token_id, "eos")
    with pytest.raises(EngineError, match="invalid_model_output"):
        TextStream(tokenizer).push(tokenizer.bos_token_id, None)
