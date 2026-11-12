"""Cross-phase seams: factory, export/load compatibility, prompt parity, repair oracle, worker protocol."""
import json
import sys
from pathlib import Path

import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import execution_pipeline  # noqa: E402,F401

from execution_model.checkpoint import load_checkpoint  # noqa: E402
from execution_model.resources import ResourceConfig  # noqa: E402
from execution_model.config import ARCHITECTURE_VERSION  # noqa: E402
from execution_model.errors import ModelLoadError  # noqa: E402
from execution_model.tokenizer import ByteBPETokenizer  # noqa: E402
from execution_training.errors import TrainingError  # noqa: E402
from execution_training.model_factory import ModelRequest, validate_bundle  # noqa: E402
from execution_training.schemas import UsageAuthorization  # noqa: E402
from execution_training.provenance import LocalEvidenceStore  # noqa: E402
from execution_training.tokenization import TokenizerAdapter, render_prompt  # noqa: E402

from execution_pipeline.bridge import Phase2TokenizerBridge, execution_model_factory, export_inference_checkpoint, resolve_model_config  # noqa: E402
from execution_pipeline.repair import correct_expression, defective, failures, generate_repairs, source  # noqa: E402
from execution_pipeline.tasks import UnsupportedTask, build_payload, render  # noqa: E402

AUTH = UsageAuthorization("test", "test", "test", ("training", "validation", "evaluation"), True, "synthetic", None, None)


def tiny_tokenizer():
    return ByteBPETokenizer.train(["export function a(value: number): number { return 1; }"] * 5, target_vocab_size=8192)


def test_factory_produces_validated_random_bundle():
    tokenizer = tiny_tokenizer()
    request = ModelRequest(ARCHITECTURE_VERSION, "17m", 3, tokenizer.vocab_size, 64)
    bundle = execution_model_factory(request)
    validate_bundle(bundle, request)
    assert bundle.initialization == "random" and bundle.model.config.seed == 3


def test_factory_refuses_pretrained():
    with pytest.raises(TrainingError):
        execution_model_factory(ModelRequest(ARCHITECTURE_VERSION, "17m", 3, 300, 64, allow_pretrained=True))


def test_tokenizer_bridge_is_lossless_through_phase3_adapter():
    adapter = TokenizerAdapter(Phase2TokenizerBridge(tiny_tokenizer()))
    text = 'Execution task:\n{"x":"مرحبا"}\nExpected execution output:\n'
    assert adapter.decode(adapter.encode(text)) == text


def test_export_then_strict_phase2_load(tmp_path):
    tokenizer = tiny_tokenizer()
    config = resolve_model_config(ModelRequest(ARCHITECTURE_VERSION, "17m", 3, tokenizer.vocab_size, 64))
    bundle = execution_model_factory(ModelRequest(ARCHITECTURE_VERSION, "17m", 3, tokenizer.vocab_size, 64))
    compatibility = {"model_configuration_identity": config.identity, "initialization": {"kind": "random"},
                     "tokenizer_identity": TokenizerAdapter(Phase2TokenizerBridge(tokenizer)).identity_dict()}
    source_path = tmp_path / "train.pt"
    torch.save({"model_state": bundle.model.state_dict(), "compatibility": compatibility, "training_state": {"step": 0}}, source_path)
    out = export_inference_checkpoint(source_path, config=config, tokenizer=tokenizer, output_directory=tmp_path / "inference")
    loaded = load_checkpoint((tmp_path / "inference").resolve(), expected_config=config, expected_tokenizer_identity=tokenizer.identity, resources=ResourceConfig(max_context_length=64))
    assert loaded.metadata.checkpoint_identity == out["checkpoint_identity"]
    for name, tensor in bundle.model.state_dict().items():
        assert torch.equal(tensor, loaded.model.state_dict()[name])
    # Tampered weights are refused by the Phase 2 loader.
    weights = tmp_path / "inference" / "weights.pt"
    data = bytearray(weights.read_bytes()); data[-100] ^= 1; weights.write_bytes(bytes(data))
    with pytest.raises(ModelLoadError):
        load_checkpoint((tmp_path / "inference").resolve(), expected_config=config, expected_tokenizer_identity=tokenizer.identity, resources=ResourceConfig(max_context_length=64))


def test_export_refuses_mismatched_tokenizer(tmp_path):
    tokenizer = tiny_tokenizer()
    config = resolve_model_config(ModelRequest(ARCHITECTURE_VERSION, "17m", 3, tokenizer.vocab_size, 64))
    bundle = execution_model_factory(ModelRequest(ARCHITECTURE_VERSION, "17m", 3, tokenizer.vocab_size, 64))
    torch.save({"model_state": bundle.model.state_dict(), "training_state": {},
                "compatibility": {"model_configuration_identity": config.identity, "initialization": {"kind": "random"},
                                  "tokenizer_identity": {"identity": "0" * 64}}}, tmp_path / "t.pt")
    with pytest.raises(TrainingError):
        export_inference_checkpoint(tmp_path / "t.pt", config=config, tokenizer=tokenizer, output_directory=tmp_path / "o")


def test_repair_oracle_detects_each_defect_and_accepts_correction():
    for bug in ("missing_null_guard", "wrong_operator", "wrong_default"):
        assert failures(defective(bug, "f", 3), "f", 3)
    assert failures(source("f", correct_expression(3)), "f", 3) == ()
    with pytest.raises(TrainingError):
        failures("export function f() { process.exit(1) }", "f", 3)


def test_generated_repairs_pass_phase3_validation_and_prompt_parity(tmp_path):
    examples = list(generate_repairs(seed=1, count=6, authorization=AUTH, evidence_store=LocalEvidenceStore(tmp_path),
                                     collected_at="2026-11-12T00:00:00Z", family_variant="train"))
    assert len(examples) == 6
    for example in examples:
        repair = example.repair
        fields = {"function_name": example.required_context["function_name"], "increment": example.required_context["increment"],
                  "failed_candidate": repair.failed_candidate, "failure_evidence": list(repair.failure_evidence),
                  "failure_category": repair.failure_category}
        assert render("typescript.repair.v1:null-safe-delta", fields) == render_prompt(example)


@pytest.mark.parametrize("domain,capability", [
    ("type_transform", "json.transform.v1:integers-to-strings"),
    ("boundary_conditions", "json.check.v1:inclusive-interval"),
])
def test_json_capabilities_render_the_trained_prompt(tmp_path, domain, capability):
    from execution_training.synthetic import generate_synthetic
    examples = list(generate_synthetic(seed=7, count_per_domain=8, authorization=AUTH, evidence_store=LocalEvidenceStore(tmp_path),
                                       collected_at="2026-11-12T00:00:00Z", domains=(domain,)))
    assert len(examples) == 8
    for example in examples:
        assert render(capability, dict(example.required_context)) == render_prompt(example)


@pytest.mark.parametrize("capability,fields", [
    ("json.transform.v1:integers-to-strings", {"values": [1, 2, 3, 4, 5]}),
    ("json.transform.v1:integers-to-strings", {"values": [2048]}),
    ("json.transform.v1:integers-to-strings", {"values": [True]}),
    ("json.transform.v1:integers-to-strings", {"values": ["1"]}),
    ("json.check.v1:inclusive-interval", {"value": 5, "minimum": 0, "maximum": 40}),
    ("json.check.v1:inclusive-interval", {"value": 50, "minimum": 0, "maximum": 10}),
    ("json.check.v1:inclusive-interval", {"value": 1, "minimum": 0}),
    ("typescript.implement.v1:null-safe-delta", {"function_name": "f", "increment": 500}),
    ("typescript.implement.v1:null-safe-delta", {"function_name": "f; rm -rf", "increment": 1}),
    ("typescript.implement.v1:null-safe-delta", {"function_name": "f", "increment": 1, "extra": "x"}),
    ("shell.exec", {}),
])
def test_worker_rejects_out_of_domain_requests(capability, fields):
    with pytest.raises(UnsupportedTask):
        build_payload(capability, fields)


class _ApplicationClass:
    pass


def test_loader_refuses_application_added_safe_globals(tmp_path):
    from execution_model.checkpoint import _check_torch_loader
    _check_torch_loader()  # PyTorch's own built-in entries are tolerated
    torch.serialization.add_safe_globals([_ApplicationClass])
    try:
        with pytest.raises(ModelLoadError):
            _check_torch_loader()
    finally:
        torch.serialization.clear_safe_globals()
        # Restore PyTorch's own registrations by re-importing nothing: clearing is test-local;
        # subsequent loads only need the list to contain no application entries.
