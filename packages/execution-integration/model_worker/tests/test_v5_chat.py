"""Verify owner chat framing and the real CPU worker with synthetic weights."""

from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest
import torch

from execution_model.config import ModelConfig
from execution_model.model import ExecutionModel
from execution_model.tokenizer import ByteBPETokenizer
from execution_pipeline.chat import conversation_prompt
from execution_pipeline.pretrain import TextEncoder
from model_worker.engine import CHAT_HEAD, load_engine
from model_worker.runtime import frame
from model_worker.text import cut_repeated_phrase


WORKER = Path(__file__).resolve().parents[1] / "worker.py"
MESSAGES = [
    {"role": "assistant", "content": 'مرحبا، "نعم" \\ الآن\n'},
    {"role": "user", "content": 'هل هذا صحيح؟\t"نعم"\r\\\n'},
]
SAMPLING = {"temperature": 0.7, "topP": 0.9, "topK": 0, "seed": 1729}


@pytest.fixture
def make_config(tmp_path):
    release = tmp_path / "app"
    release.mkdir()
    artifacts = tmp_path / "models"
    artifacts.mkdir()
    tokenizer = ByteBPETokenizer([(ord("a"), ord(" ")), (263, ord("b"))])
    tokenizer_path = artifacts / "tokenizer.json"
    tokenizer.save(tokenizer_path)
    tokenizer_pin = sha256(tokenizer_path.read_bytes()).hexdigest()
    (artifacts / "tokenizer-report.json").write_text(json.dumps({"pretokenizer": "words-v1"}), encoding="utf-8")

    def create(output_token):
        model = ExecutionModel(ModelConfig(
            vocab_size=tokenizer.vocab_size, hidden_size=16, intermediate_size=24,
            num_layers=1, num_heads=2, max_context_length=512, seed=1729,
        ))
        with torch.no_grad():
            for parameter in model.parameters():
                parameter.zero_()
            model.final_norm.weight.fill_(1)
            model.token_embedding.weight[ord("\n")].fill_(1)
            model.token_embedding.weight[output_token].fill_(16)
        checkpoint = artifacts / "best.pt"
        torch.save({"config": model.config.to_dict(), "model_state": model.state_dict(),
                    "optimizer_state": {"state": {}, "param_groups": []},
                    "generator_state": torch.random.get_rng_state()}, checkpoint)
        checkpoint_pin = sha256(checkpoint.read_bytes()).hexdigest()
        config = {
            "identity": {"modelId": "synthetic-chat", "tokenizerId": "sha256:" + tokenizer_pin,
                         "checkpointId": "sha256:" + checkpoint_pin},
            "model": {
                "checkpoint": {"format": "training", "path": str(checkpoint), "sha256": checkpoint_pin},
                "tokenizer": {"path": str(tokenizer_path), "sha256": tokenizer_pin, "pretokenizer": "words-v1"},
                "eosTokenId": tokenizer.eos_token_id, "device": "cpu", "heads": {CHAT_HEAD: {"kind": "generate"}},
            },
        }
        path = release / "worker.json"
        path.write_text(json.dumps(config), encoding="utf-8")
        return path, config

    return tokenizer, artifacts, create


def test_chat_tokenizes_the_training_prompt_and_drops_the_oldest_turns(make_config):
    tokenizer, artifacts, create = make_config
    path, config = create(ord("!"))
    engine = load_engine(config["model"], base_dir=path.parent, max_output_tokens=192,
                         tokenizer_id=config["identity"]["tokenizerId"])
    text = TextEncoder(artifacts)
    messages = [*MESSAGES[:-1], {"role": "user", "content": "a b " + MESSAGES[-1]["content"]}]
    prompt = conversation_prompt(messages)
    assert tokenizer.decode_bytes(text.encode(prompt)) == prompt.encode("utf-8")

    def prepare(history):
        return engine.prepare("generate", CHAT_HEAD, {"messages": history, "maxNewTokens": 192, **SAMPLING})

    old = {"role": "user", "content": "x" * 700}
    fitted = prepare([old, *messages])
    assert fitted.input_ids == tuple(text.encode(prompt))
    assert fitted.config.max_new_tokens == 192

    short = {"role": "user", "content": "x"}
    overhead = len(text.encode(conversation_prompt([short]))) - 1
    long = {"role": "user", "content": "x" * (512 - overhead - 5)}
    shortened = prepare([*messages, long])
    assert shortened.input_ids == tuple(text.encode(conversation_prompt([long])))
    assert shortened.config.max_new_tokens == 5
    assert prepare([old]) is None


@pytest.mark.parametrize("output_token,expected", [(ord("!"), ("!!!!", "length")), (258, ("", "eos"))])
def test_v5_cpu_worker_serves_an_absolute_pinned_training_checkpoint(make_config, output_token, expected):
    tokenizer, _, create = make_config
    assert tokenizer.eos_token_id == 258
    config_path, config = create(output_token)
    with ThreadPoolExecutor(max_workers=1) as reads, subprocess.Popen(
        [sys.executable, "-I", "-B", str(WORKER), str(config_path), str(os.getpid())], cwd=config_path.parent,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    ) as process:
        def receive():
            return json.loads(reads.submit(process.stdout.readline).result(timeout=15))

        def send(message):
            process.stdin.write(message)
            process.stdin.flush()

        try:
            ready = receive()
            assert ready["kind"] == "ready"
            assert ready["device"] == "cpu"
            assert ready["heads"] == {CHAT_HEAD: "generate"}
            assert ready["identity"] == config["identity"]
            for request_id, messages, result in [
                ("chat", MESSAGES, {"text": expected[0], "stopReason": expected[1], "loopCut": False}),
                ("long", [{"role": "user", "content": "x" * 700}],
                 {"text": "", "stopReason": "context_limit", "loopCut": False}),
            ]:
                send(frame("request", requestId=request_id, operation="generate", head=CHAT_HEAD, timeoutMs=5_000,
                           input={"messages": messages, "maxNewTokens": 4, **SAMPLING}))
                response = receive()
                assert response["kind"] == "result"
                assert response["requestId"] == request_id
                assert response["result"] == result
            send(frame("shutdown"))
            assert process.wait(timeout=5) == 0
            logs = process.stderr.read().decode("utf-8")
            assert "مرحبا" not in logs
            assert "!!!!" not in logs
        finally:
            if process.poll() is None:
                process.kill()


def test_word_trigram_guard_cuts_before_the_repeated_phrase():
    assert cut_repeated_phrase("رد: أهلًا بك هنا. أهلًا بك هنا مرة أخرى.") == ("رد: أهلًا بك هنا.", True)
    assert cut_repeated_phrase("One two three. Then ONE, two three.") == ("One two three. Then", True)
    assert cut_repeated_phrase("One two one two three.") == ("One two one two three.", False)
