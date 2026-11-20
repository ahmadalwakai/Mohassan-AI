"""CPU tests for raw framing, exact completion evidence, and immutable protocols."""
from collections import Counter
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline import gate3_probes as probes
from execution_model.config import ModelConfig
from execution_model.model import ExecutionModel, ModelOutput


class ScriptedModel(ExecutionModel):
    """A real bounded model interface with known greedy logits for decoder tests."""
    def __init__(self, selected):
        super().__init__(ModelConfig(vocab_size=256, hidden_size=8, intermediate_size=8,
                                    num_layers=1, num_heads=1, max_context_length=512))
        self.selected = selected
        self.seen = []
        self.eval()

    def forward(self, ids, **kwargs):
        self.seen.append(ids[0].tolist())
        logits = torch.zeros((1, 1, 256))
        token = self.selected[min(len(self.seen) - 1, len(self.selected) - 1)]
        logits[0, 0, token] = 100
        return ModelOutput(logits)


def raw_worker(selected, context=512):
    model = ScriptedModel(selected)
    encoded_prompts = []
    def encode(text):
        encoded_prompts.append(text)
        return [7, 8, 9]
    worker = SimpleNamespace(hint=None, encoder=SimpleNamespace(encode=encode),
                            config=SimpleNamespace(max_context_length=context), model=model, device="cpu",
                            tokenizer=SimpleNamespace(eos_token_id=2, decode_bytes=lambda ids: bytes(ids)))
    return worker, encoded_prompts


def test_raw_prompt_goes_directly_to_encoder_and_eos_is_counted_but_not_decoded():
    worker, encoded = raw_worker([65, 66, 2])
    result = probes.raw_continuation(worker, "A raw prefix")
    assert encoded == ["A raw prefix"]
    assert worker.model.seen[0] == [7, 8, 9]
    assert result["text"] == "AB"
    assert result["finished"] is True and result["stop_reason"] == "eos"
    assert result["input_tokens"] == 3 and result["output_tokens"] == 3
    assert result["text_tokens"] == 2 and result["terminal_token_id"] == 2


def test_fixed_192_budget_records_unfinished_length_and_exact_token_count():
    worker, _ = raw_worker([65])
    result = probes.raw_continuation(worker, "prefix")
    assert result["text"] == "A" * 192
    assert result["finished"] is False and result["stop_reason"] == "length"
    assert result["output_tokens"] == result["text_tokens"] == 192
    assert result["terminal_token_id"] is None


def test_context_overflow_refuses_instead_of_shortening_prompt_or_output_budget():
    worker, _ = raw_worker([65], context=194)
    with pytest.raises(ValueError, match="fixed output budget"):
        probes.raw_continuation(worker, "prefix")
    assert worker.model.seen == []


def test_hint_cannot_be_silently_applied_or_ignored():
    worker, encoded = raw_worker([65])
    worker.hint = "names-v1"
    with pytest.raises(ValueError, match="hint"):
        probes.raw_continuation(worker, "prefix")
    assert encoded == []


def fixture_rows():
    return [{"id": f"gate3-{language}-{number:02d}", "language": language, "prompt": "prefix",
             "criterion": "Stay on topic", "probe_type": "raw_prose_continuation",
             "development_only": True, "independent_test": False}
            for language in ("ar", "en") for number in range(1, 21)]


def test_frozen_probe_structure_rejects_duplicates_even_when_language_counts_match():
    rows = fixture_rows()
    probes._validate_rows(rows)
    rows[1]["id"] = rows[0]["id"]
    with pytest.raises(ValueError, match="40 unique"):
        probes._validate_rows(rows)


def test_per_case_errors_remain_in_full_scheduled_denominator(tmp_path):
    rows = fixture_rows()
    worker, _ = raw_worker([2], context=194)
    result = probes._generate_rows(rows, worker, tmp_path / "predictions.jsonl")
    records = [json.loads(line) for line in (tmp_path / "predictions.jsonl").read_text().splitlines()]
    assert result["generated"] == {"total": 40, "ar": 20, "en": 20}
    assert result["finished"] == {"total": 0, "ar": 0, "en": 0}
    assert result["stop_reasons"] == {"error": 40}
    assert Counter(row["language"] for row in records) == {"ar": 20, "en": 20}
    with pytest.raises(FileExistsError):
        probes._generate_rows(rows, worker, tmp_path / "predictions.jsonl")


def protocol_root(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    root.mkdir()
    rows = fixture_rows()
    path = root / probes.PROBES
    path.parent.mkdir(parents=True)
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")
    monkeypatch.setattr(probes, "PROBES_SHA256", probes.sha256(path))
    for name in probes.CODE_PATHS:
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("# fixture source\n", encoding="utf-8")
    run = root / "run"
    (run / "checkpoint").mkdir(parents=True)
    (run / "checkpoint/best.pt").write_bytes(b"fixture weights; never deserialized by prepare/check")
    (run / "checkpoint/settings.json").write_text('{"prompt_hint":null}', encoding="utf-8")
    for name in ("tokenizer.json", "tokenizer-report.json"):
        (run / name).write_text("{}", encoding="utf-8")
    return root, run


def test_prepare_check_bind_checkpoint_code_and_input_without_loading_weights(tmp_path, monkeypatch):
    root, run = protocol_root(tmp_path, monkeypatch)
    result = probes.prepare(run, "checkpoint", probes.sha256(run / "checkpoint/best.pt"),
                            root / "generation", root=root)
    path = Path(result["protocol"])
    protocol = probes.check(path, result["protocol_sha256"], root=root)
    assert protocol["counts"] == {"total": 40, "ar": 20, "en": 20}
    assert protocol["decoding"]["max_new_tokens"] == 192
    assert not (path.parent / "predictions.jsonl").exists()
    (root / probes.CODE_PATHS[0]).write_text("# changed code\n", encoding="utf-8")
    with pytest.raises(ValueError, match="Pinned evidence changed"):
        probes.check(path, result["protocol_sha256"], root=root)


def test_protocol_and_output_are_immutable_and_frozen_input_is_checked(tmp_path, monkeypatch):
    root, run = protocol_root(tmp_path, monkeypatch)
    digest = probes.sha256(run / "checkpoint/best.pt")
    result = probes.prepare(run, "checkpoint", digest, root / "generation", root=root)
    with pytest.raises(FileExistsError):
        probes.prepare(run, "checkpoint", digest, root / "generation", root=root)
    path = Path(result["protocol"])
    path.write_text(path.read_text() + " ", encoding="utf-8")
    with pytest.raises(ValueError, match="protocol changed"):
        probes.check(path, result["protocol_sha256"], root=root)
    (root / probes.PROBES).write_text("changed frozen probes", encoding="utf-8")
    with pytest.raises(ValueError, match="Frozen Gate 3 prompts changed"):
        probes.frozen_probes(root)


@pytest.mark.parametrize("asset", ["checkpoint/best.pt", "checkpoint/settings.json", "tokenizer.json"])
def test_changed_weights_settings_or_tokenizer_refuse_prepared_generation(tmp_path, monkeypatch, asset):
    root, run = protocol_root(tmp_path, monkeypatch)
    result = probes.prepare(run, "checkpoint", probes.sha256(run / "checkpoint/best.pt"),
                            root / "generation", root=root)
    (run / asset).write_bytes(b"changed asset")
    with pytest.raises(ValueError, match="Pinned evidence changed"):
        probes.check(Path(result["protocol"]), result["protocol_sha256"], root=root)


def test_cpu_prediction_lifecycle_binds_all_outputs_and_refuses_second_attempt(tmp_path, monkeypatch):
    from execution_pipeline import ads_worker
    root, run = protocol_root(tmp_path, monkeypatch)
    digest = probes.sha256(run / "checkpoint/best.pt")
    preparation = probes.prepare(run, "checkpoint", digest, root / "generation", root=root)
    worker, _ = raw_worker([2])
    worker.checkpoint_sha256 = digest
    monkeypatch.setattr(ads_worker, "AdsWorker", lambda *args: worker)
    monkeypatch.setattr(torch.cuda, "is_available", lambda: pytest.fail("CPU path must not inspect CUDA"))
    manifest = probes.predict(Path(preparation["protocol"]), preparation["protocol_sha256"], root=root)
    assert manifest["generated"] == manifest["finished"] == {"total": 40, "ar": 20, "en": 20}
    assert manifest["predictions"]["sha256"] == probes.sha256(root / "generation/predictions.jsonl")
    assert manifest["protocol"]["sha256"] == preparation["protocol_sha256"]
    assert manifest["checkpoint_sha256"] == digest
    assert manifest["semantic_judging"] == "pending_role_c" and manifest["ready_for_chat"] is False
    with pytest.raises(FileExistsError, match="already attempted"):
        probes.predict(Path(preparation["protocol"]), preparation["protocol_sha256"], root=root)


def test_runtime_failure_records_full_scheduled_counts_and_cannot_be_retried(tmp_path, monkeypatch):
    from execution_pipeline import ads_worker
    root, run = protocol_root(tmp_path, monkeypatch)
    preparation = probes.prepare(run, "checkpoint", probes.sha256(run / "checkpoint/best.pt"),
                                 root / "generation", root=root)
    def fail_loading(*args):
        raise RuntimeError("Checkpoint runtime load failure")
    monkeypatch.setattr(ads_worker, "AdsWorker", fail_loading)
    with pytest.raises(RuntimeError, match="load failure"):
        probes.predict(Path(preparation["protocol"]), preparation["protocol_sha256"], root=root)
    failure = json.loads((root / "generation/failure.json").read_text())
    assert failure["scheduled"] == {"total": 40, "ar": 20, "en": 20}
    assert not (root / "generation/manifest.json").exists()
    with pytest.raises(FileExistsError, match="already attempted"):
        probes.predict(Path(preparation["protocol"]), preparation["protocol_sha256"], root=root)
