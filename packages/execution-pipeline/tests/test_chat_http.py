"""Real loopback HTTP and Wasla integration with fixed model fixtures only.

No trained checkpoint, CUDA, torch, internet request, device credentials or live
companion is loaded. Passing these tests establishes transport behavior, never
conversation quality or permission to promote a trained model.
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import urllib.error
import urllib.request

import pytest


PACKAGE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE))
from execution_pipeline.chat import ChatModel, MODEL_ID, sha256_file

WASLA_WINDOWS = Path(r"C:\Users\Administrator\Documents\Codex\2026-11-01\local-agent-handoff\outputs\Wasla\windows")
if not (WASLA_WINDOWS / "wasla" / "services.py").is_file():
    pytest.skip("Wasla companion is not installed in this workspace", allow_module_level=True)
sys.path.insert(0, str(WASLA_WINDOWS))
from wasla.services import LocalServices, ServiceError

_SPEC = importlib.util.spec_from_file_location("_mohassan_chat_http_under_test", PACKAGE / "scripts" / "chat_model.py")
HTTP_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(HTTP_MODULE)
CHECKPOINT = "a" * 64


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False) + "\n", encoding="utf-8")


@pytest.fixture
def ready_receipt(tmp_path):
    """Completely isolated fake evidence; never writes a real readiness receipt."""
    holdout = tmp_path / "fixture-holdout"
    holdout.mkdir()
    cases, criteria = holdout / "cases.jsonl", holdout / "criteria.json"
    write_json(cases, {"id": "http-fixture", "scope": "transport fixture, not a model evaluation"})
    write_json(criteria, {"scope": "transport fixture only"})
    hashes = {"holdout_sha256": sha256_file(cases), "criteria_sha256": sha256_file(criteria)}
    manifest = holdout / "manifest.json"
    write_json(manifest, hashes)
    predictions = tmp_path / "fixture-predictions.jsonl"
    write_json(predictions, {"id": "http-fixture", "text": "fixture", "finished": True})
    assessment = tmp_path / "fixture-assessment.json"
    write_json(assessment, {"ready_for_chat": True, "checkpoint_sha256": CHECKPOINT,
                            "predictions_sha256": sha256_file(predictions), **hashes})
    receipt = {"schemaVersion": 1, "model": MODEL_ID, "ready_for_chat": True, "checkpoint_sha256": CHECKPOINT}
    for key, artifact in (("assessment", assessment), ("predictions", predictions), ("holdout_manifest", manifest)):
        receipt[key] = {"path": artifact.relative_to(tmp_path).as_posix(), "sha256": sha256_file(artifact)}
    path = tmp_path / "fixture-ready.json"
    write_json(path, receipt)
    return path


class FixtureWorker:
    """Token counting and model outputs are explicit stand-ins; framing is real."""
    def __init__(self):
        self.encoder = SimpleNamespace(encode=lambda text: text.encode("utf-8"))
        self.config = SimpleNamespace(max_context_length=1024)
        self.calls = []
        self.text = "A complete English fixture answer."
        self.finished = True
        self.during_generation = None

    def sample(self, request):
        self.calls.append(request)
        if self.during_generation:
            self.during_generation()
        return [{"text": self.text, "finished": self.finished}]


class NoOllama:
    def __init__(self):
        self.calls = []

    def json(self, route, payload=None, **kwargs):
        self.calls.append((route, payload))
        pytest.fail("Selected own-model chat must never call Ollama")


@pytest.fixture
def http_stack(ready_receipt):
    # Exercise the real ChatModel.answer path without importing or loading torch.
    model = ChatModel.__new__(ChatModel)
    model.worker = FixtureWorker()
    model.checkpoint_sha256 = CHECKPOINT
    args = SimpleNamespace(readiness=ready_receipt, port=0)
    server = HTTP_MODULE.create_server(args, model)
    assert server.server_address[0] == "127.0.0.1"
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    origin = "http://127.0.0.1:" + str(server.server_address[1])
    ollama = NoOllama()
    service = LocalServices(bridge=object(), transport=ollama, chat_backend="mohassan", mohassan_url=origin)
    stack = SimpleNamespace(server=server, model=model, origin=origin, service=service, ollama=ollama,
                            readiness=ready_receipt)
    try:
        yield stack
    finally:
        asyncio.run(service.close())
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
        assert not thread.is_alive()
        assert ollama.calls == []


def chat(stack, messages=None):
    return asyncio.run(stack.service.chat(messages or [{"role": "user", "content": "Hello"}]))


def request_json(stack, path, payload=None, headers=None):
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(stack.origin + path, data=data,
                                     headers={"Content-Type": "application/json", **(headers or {})})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


@pytest.mark.parametrize("messages,answer", [
    ([{"role": "user", "content": "اسمي هدى"}, {"role": "assistant", "content": "أهلًا هدى."},
      {"role": "user", "content": "ما اسمي؟"}], "اسمك هدى."),
    ([{"role": "user", "content": "My name is Robin."}, {"role": "assistant", "content": "Hello Robin."},
      {"role": "user", "content": "What is my name?"}], "Your name is Robin."),
])
def test_actual_http_returns_complete_arabic_and_english_to_wasla(http_stack, messages, answer):
    http_stack.model.worker.text = answer
    status, health = request_json(http_stack, "/health")
    assert status == 200 and health["ready_for_chat"] is True
    assert health["checkpoint_sha256"] == CHECKPOINT
    result = chat(http_stack, messages)
    assert result == {"content": answer, "model": MODEL_ID}
    assert len(http_stack.model.worker.calls) == 1
    call = http_stack.model.worker.calls[0]
    assert call["max_new_tokens"] == 192
    encoded = call["prompt"].removeprefix("Mohassan chat v1\n").removesuffix("\nAssistant:\n")
    assert json.loads(encoded) == messages


def test_real_request_preserves_trimmed_and_failed_send_history(http_stack):
    messages = [{"role": "assistant", "content": "Earlier answer."},
                {"role": "user", "content": "An interrupted request."},
                {"role": "user", "content": "Please answer again."}]
    chat(http_stack, messages)
    prompt = http_stack.model.worker.calls[0]["prompt"]
    assert json.loads(prompt.removeprefix("Mohassan chat v1\n").removesuffix("\nAssistant:\n")) == messages


def test_unready_manifest_after_start_returns_503_and_no_model_call(http_stack):
    receipt = json.loads(http_stack.readiness.read_text(encoding="utf-8"))
    receipt["ready_for_chat"] = False
    write_json(http_stack.readiness, receipt)
    status, body = request_json(http_stack, "/health")
    assert status == 503 and body["ready_for_chat"] is False
    with pytest.raises(ServiceError) as error:
        chat(http_stack)
    assert error.value.code == "upstream_unavailable"
    assert http_stack.model.worker.calls == []


@pytest.mark.parametrize("relative", ["fixture-predictions.jsonl", "fixture-assessment.json",
    "fixture-holdout/manifest.json", "fixture-holdout/cases.jsonl", "fixture-holdout/criteria.json"])
def test_modified_evidence_is_rejected_through_actual_wasla_transport(http_stack, relative):
    (http_stack.readiness.parent / relative).write_text("changed fixture evidence", encoding="utf-8")
    with pytest.raises(ServiceError) as error:
        chat(http_stack)
    assert error.value.code == "upstream_unavailable"
    assert http_stack.model.worker.calls == []


def test_missing_receipt_is_rejected_without_generation(http_stack):
    # Rename only this isolated temporary test file.
    http_stack.readiness.rename(http_stack.readiness.with_suffix(".withdrawn"))
    with pytest.raises(ServiceError) as error:
        chat(http_stack)
    assert error.value.code == "upstream_unavailable"
    assert http_stack.model.worker.calls == []


def test_length_finish_is_rejected_at_wasla_boundary(http_stack):
    http_stack.model.worker.text = "This is an unfinished fixture"
    http_stack.model.worker.finished = False
    with pytest.raises(ServiceError) as error:
        chat(http_stack)
    assert error.value.code == "incomplete_model_response"
    assert len(http_stack.model.worker.calls) == 1


@pytest.mark.parametrize("answer", ["", "broken \ufffd output"])
def test_invalid_generation_http_error_reaches_wasla(http_stack, answer):
    http_stack.model.worker.text = answer
    with pytest.raises(ServiceError) as error:
        chat(http_stack)
    assert error.value.code == "upstream_unavailable"
    assert len(http_stack.model.worker.calls) == 1


def test_actual_context_overflow_refuses_instead_of_dropping_history(http_stack):
    with pytest.raises(ServiceError) as error:
        chat(http_stack, [{"role": "user", "content": "long context " * 90}])
    assert error.value.code == "context_limit"
    assert error.value.status == 400
    assert "ابدأ محادثة جديدة" in str(error.value)
    assert http_stack.model.worker.calls == []


def test_checkpoint_change_during_generation_is_refused_by_adapter(http_stack):
    http_stack.model.worker.during_generation = lambda: setattr(http_stack.model, "checkpoint_sha256", "b" * 64)
    with pytest.raises(ServiceError) as error:
        chat(http_stack)
    assert error.value.code == "model_identity_changed"


@pytest.mark.parametrize("payload", [
    {"model": "wrong-model", "messages": [{"role": "user", "content": "hello"}]},
    {"model": MODEL_ID, "messages": [{"role": "system", "content": "hello"}]},
    {"model": MODEL_ID, "messages": [{"role": "user", "content": "hello"}], "tools": []},
    {"model": MODEL_ID, "messages": [{"role": "user", "content": "hello"}], "max_tokens": 193},
])
def test_http_rejects_invalid_model_fields_and_input_without_generation(http_stack, payload):
    status, body = request_json(http_stack, "/v1/chat/completions", payload)
    assert status == 400 and "error" in body
    assert http_stack.model.worker.calls == []


def test_browser_origin_is_denied_without_model_call(http_stack):
    payload = {"model": MODEL_ID, "messages": [{"role": "user", "content": "hello"}]}
    status, body = request_json(http_stack, "/v1/chat/completions", payload, {"Origin": "https://example.org"})
    assert status == 403 and body["error"]["code"] == "browser_origin_denied"
    assert http_stack.model.worker.calls == []


def test_loopback_model_requests_ignore_proxy_environment(http_stack, monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("http_proxy", "http://127.0.0.1:1")
    monkeypatch.setenv("NO_PROXY", "")
    monkeypatch.setenv("no_proxy", "")
    service = LocalServices(bridge=object(), transport=http_stack.ollama, chat_backend="mohassan", mohassan_url=http_stack.origin)
    try:
        result = asyncio.run(service.chat([{"role": "user", "content": "Hello"}]))
        assert result["model"] == MODEL_ID
    finally:
        asyncio.run(service.close())
