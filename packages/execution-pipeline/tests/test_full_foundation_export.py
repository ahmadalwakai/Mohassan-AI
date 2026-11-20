"""CPU-only export/recovery and copied-input pin checks; no model allocation."""
import importlib.util
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_script = Path(__file__).resolve().parents[1] / "scripts/train_full_foundation.py"
_spec = importlib.util.spec_from_file_location("full_foundation_export_test_cli", _script)
full = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(full)
from execution_model.config import ModelConfig


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


@pytest.fixture
def finished_run(tmp_path, monkeypatch):
    monkeypatch.setattr(full, "RUN", tmp_path / "run")
    monkeypatch.setattr(full, "CAMPAIGN", tmp_path / "campaign")
    full.CAMPAIGN.mkdir()
    source = full.RUN / "38m/checkpoints/tokens-000950000000"
    source.mkdir(parents=True)
    checkpoint = source / "checkpoint.pt"
    checkpoint.write_bytes(b"tiny test checkpoint bytes, not a torch payload")
    write_json(source / "manifest.json", {"checkpoint_sha256": full._sha256(checkpoint),
               "fixed_reference_validation_loss": {"ar": 2.6, "en": 2.8}})
    write_json(full.RUN / "38m/settings.json", {"prompt_hint": None, "fixture": "settings"})
    config = {"shape": "38m", "code_sha256": {"fixture.py": "a" * 64},
              "pilot_300m_reference": {"ar": 2.95, "en": 3.20}}
    result = {"status": "completed", "best_checkpoint_tokens": 950_000_000,
              "processed_tokens": 1_000_000_000, "language_tokens": {"ar": 500_000_000, "en": 500_000_000}}
    return config, "b" * 64, result, source


def test_candidate_export_copies_exact_selected_best_and_pins_evidence(finished_run):
    config, digest, result, source = finished_run
    receipt = full.publish_candidate(config, digest, result)
    selected = full.RUN / "selected"
    assert (selected / "best.pt").read_bytes() == (source / "checkpoint.pt").read_bytes()
    assert (selected / "settings.json").read_bytes() == (full.RUN / "38m/settings.json").read_bytes()
    manifest = full.read(selected / "manifest.json")
    assert manifest["source_manifest_sha256"] == full._sha256(source / "manifest.json")
    assert manifest["files"] == {name: full._sha256(selected / name) for name in ("best.pt", "settings.json")}
    assert manifest["config_sha256"] == digest and manifest["code_sha256"] == config["code_sha256"]
    assert receipt["candidate_checkpoint_sha256"] == full._sha256(selected / "best.pt")
    assert receipt["best_checkpoint_positions"] == 950_000_000
    assert receipt["processed_positions"] == 1_000_000_000
    assert receipt["foundation_loss_gate_passed"] is True
    assert receipt["raw_continuation_probe_judged"] is False and receipt["gate3_passed"] is None
    assert receipt["ready_for_chat"] is False and receipt["phone_activated"] is False


def test_repeated_export_is_idempotent_and_preserves_selected_files(finished_run):
    config, digest, result, _ = finished_run
    first = full.publish_candidate(config, digest, result)
    selected = full.RUN / "selected"
    before = {path.name: (path.read_bytes(), path.stat().st_mtime_ns) for path in selected.iterdir()}
    second = full.publish_candidate(config, digest, result)
    after = {path.name: (path.read_bytes(), path.stat().st_mtime_ns) for path in selected.iterdir()}
    assert first == second == full.read(full.CAMPAIGN / "assessment.json")
    assert before == after


def test_recovery_can_recreate_missing_assessment_without_recopying_selected(finished_run):
    config, digest, result, _ = finished_run
    expected = full.publish_candidate(config, digest, result)
    selected = full.RUN / "selected"
    before = {path.name: (path.read_bytes(), path.stat().st_mtime_ns) for path in selected.iterdir()}
    (full.CAMPAIGN / "assessment.json").unlink()
    assert full.publish_candidate(config, digest, result) == expected
    assert {path.name: (path.read_bytes(), path.stat().st_mtime_ns) for path in selected.iterdir()} == before


@pytest.mark.parametrize("state", ["running", "paused_time_limit", "failed", "interrupted"])
def test_unfinished_run_cannot_publish_selected_checkpoint_or_gate_receipt(finished_run, state):
    config, digest, result, _ = finished_run
    result["status"] = state
    with pytest.raises(ValueError, match="finished full run"):
        full.publish_candidate(config, digest, result)
    assert not (full.RUN / "selected").exists()
    assert not (full.CAMPAIGN / "assessment.json").exists()


def test_completed_early_stop_remains_eligible_without_claiming_target_was_reached(finished_run):
    config, digest, result, _ = finished_run
    result.update(status="early_stopped", processed_tokens=950_000_000,
                  language_tokens={"ar": 475_000_000, "en": 475_000_000})
    receipt = full.publish_candidate(config, digest, result)
    assert receipt["foundation_loss_gate_passed"] is True
    assert receipt["processed_positions"] == 950_000_000
    assert receipt["language_tokens"] == {"ar": 475_000_000, "en": 475_000_000}


@pytest.mark.parametrize("asset", ["best.pt", "settings.json"])
def test_tampered_existing_candidate_is_rejected_and_preserved_for_review(finished_run, asset):
    config, digest, result, _ = finished_run
    full.publish_candidate(config, digest, result)
    target = full.RUN / "selected" / asset
    target.write_bytes(b"changed selected asset")
    with pytest.raises(ValueError, match="Pinned full-run input changed"):
        full.publish_candidate(config, digest, result)
    assert target.read_bytes() == b"changed selected asset"


def test_changed_assessment_is_not_overwritten_during_export_recovery(finished_run):
    config, digest, result, _ = finished_run
    full.publish_candidate(config, digest, result)
    assessment = full.CAMPAIGN / "assessment.json"
    write_json(assessment, {"preserve_this_different_receipt": True})
    preserved = assessment.read_bytes()
    with pytest.raises(ValueError, match="assessment differs"):
        full.publish_candidate(config, digest, result)
    assert assessment.read_bytes() == preserved


@pytest.mark.parametrize("language,loss", [("ar", 2.95), ("en", 3.21)])
def test_both_language_losses_must_strictly_improve_before_probe_gate(finished_run, language, loss):
    config, digest, result, source = finished_run
    manifest = full.read(source / "manifest.json")
    manifest["fixed_reference_validation_loss"][language] = loss
    write_json(source / "manifest.json", manifest)
    receipt = full.publish_candidate(config, digest, result)
    assert receipt["foundation_loss_gate_passed"] is False
    assert receipt["status"] == "stopped_at_failed_loss_gate"
    assert receipt["gate3_passed"] is None


@pytest.fixture
def pinned_inputs(tmp_path, monkeypatch):
    for name, suffix in (("ROOT", "repo"), ("RUN", "repo/run"), ("CAMPAIGN", "repo/campaign"),
                         ("SHAPE_CAMPAIGN", "repo/shape"), ("PREP", "repo/prep")):
        monkeypatch.setattr(full, name, tmp_path / suffix)
    monkeypatch.setattr(full, "MODEL_RUN", "source-run")
    full.RUN.mkdir(parents=True)
    selection = full.SHAPE_CAMPAIGN / "assessment.json"
    write_json(selection, {"gate2_passed": True})
    prep_manifest = full.PREP / "manifest.json"
    write_json(prep_manifest, {"sha256": {}, "fixed_validation": {}})
    inputs = {}
    for name in ("tokenizer.json", "tokenizer-report.json"):
        original = full.ROOT / "source-run" / name
        original.parent.mkdir(parents=True, exist_ok=True)
        original.write_bytes(b"same copied tokenizer fixture")
        (full.RUN / name).write_bytes(original.read_bytes())
        inputs[f"source-run/{name}"] = full._sha256(original)
    model = ModelConfig(vocab_size=256, hidden_size=8, intermediate_size=8,
                        num_layers=1, num_heads=1, max_context_length=512)
    config = {"target_positions": full.TARGET, "milestones": list(full.MILESTONES),
              "checkpoint_every_tokens": full.INTERVAL, "early_stop_flat_tokens": 150_000_000,
              "selection_sha256": full._sha256(selection), "code_sha256": {}, "input_sha256": inputs,
              "prep_sha256": full._sha256(prep_manifest), "model_config": model.to_dict(),
              "model_identity": model.identity, "sampling_receipts": {"fixture": True}}
    write_json(full.CAMPAIGN / "config.json", config)
    sentinel = object()
    monkeypatch.setattr(full, "sampler_for", lambda code, receipts: sentinel)
    return full._sha256(full.CAMPAIGN / "config.json"), sentinel


def test_check_verifies_original_and_copied_tokenizer_before_sampler_use(pinned_inputs):
    digest, sentinel = pinned_inputs
    _, _, sampler, _ = full.check(digest)
    assert sampler is sentinel


@pytest.mark.parametrize("asset", ["tokenizer.json", "tokenizer-report.json"])
def test_copied_tokenizer_tampering_is_caught_even_when_original_input_still_matches(pinned_inputs, asset):
    digest, _ = pinned_inputs
    original = full.ROOT / "source-run" / asset
    original_digest = full._sha256(original)
    (full.RUN / asset).write_bytes(b"changed copied tokenizer")
    with pytest.raises(ValueError, match="Pinned full-run input changed"):
        full.check(digest)
    assert full._sha256(original) == original_digest
