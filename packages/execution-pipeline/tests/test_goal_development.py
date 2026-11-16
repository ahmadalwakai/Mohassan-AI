"""Guardrails for development runs; fresh holdouts must remain unopened."""
import argparse
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("goal_development", ROOT / "scripts/run-goal-tagger-development.py")
development = importlib.util.module_from_spec(spec)
spec.loader.exec_module(development)


def put(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def example(identifier, message, language="ar", split="train"):
    return {"id": identifier, "input": {"message": message}, "language": language,
            "split": split, "trainingAllowed": True, "source": "synthetic"}


def test_fresh_holdout_is_not_even_hashed(tmp_path, monkeypatch):
    path = tmp_path / "independent-v5" / "goal_independent.jsonl"
    def forbidden(*args):
        pytest.fail("Fresh holdout content was accessed")
    monkeypatch.setattr(development, "sha", forbidden)
    monkeypatch.setattr(development, "rows", forbidden)
    with pytest.raises(ValueError, match="no prior consumption record"):
        development.inspect_consumed(path)


def test_consumed_marker_must_bind_exact_dataset(tmp_path):
    path = tmp_path / "goal_independent.jsonl"
    put(path, example("a", "sample"))
    put(path.parent / "consumed.json", {"consumedAt": "2026-11-15T00:00:00Z", "datasetSha256": "old"})
    with pytest.raises(ValueError, match="differs from its recorded hash"):
        development.inspect_consumed(path)


def test_independent_examples_cannot_enter_training(tmp_path):
    path = tmp_path / "train.jsonl"
    row = example("a", "sample")
    row["source"] = "independent-development"
    put(path, row)
    with pytest.raises(ValueError, match="only allowed train"):
        development.inspect_dataset(path, "train")


def test_case_and_whitespace_overlap_prevents_run_creation(tmp_path):
    data, run = tmp_path / "data", tmp_path / "run"
    for split, first in (("train", "Create ads"), ("validation", "create  ADS")):
        path = data / f"{split}.jsonl"
        path.parent.mkdir(exist_ok=True)
        path.write_text("\n".join(json.dumps(row) for row in (
            example("a", first, "ar", split), example("b", f"different {split}", "en", split))), encoding="utf-8")
    args = argparse.Namespace(data=data, run=run, development=[])
    with pytest.raises(ValueError, match="Dataset overlap"):
        development.train(args)
    assert not run.exists()


def test_existing_output_is_not_reused(tmp_path):
    with pytest.raises(ValueError, match="Refusing to reuse"):
        development.train(argparse.Namespace(run=tmp_path))


def metrics(ar, en):
    return {"ar": {"rows": 100, "rawExact": ar}, "en": {"rows": 100, "rawExact": en}}


def test_gate_requires_improvement_without_per_set_language_regression():
    result = development.gate([
        {"candidate": metrics(99, 98), "baseline": metrics(90, 97)},
        {"candidate": metrics(94, 99), "baseline": metrics(95, 96)},
    ])
    assert result["aggregateExactGain"] > 0
    assert not result["improved"]
    assert not result["finalGateReached"]


def test_final_gate_requires_95_percent_each_language_and_never_claims_precision():
    comparison = {"candidate": metrics(94, 99), "baseline": metrics(90, 97)}
    result = development.gate([comparison])
    assert result["improved"]
    assert not result["finalGateReached"]
    comparison["candidate"] = metrics(95, 99)
    result = development.gate([comparison])
    assert result["finalGateReached"]
    assert result["acceptedPrecisionEstablished"] is False
    assert result["independentAccuracyClaim"] is False


def test_gate_rejects_mismatched_case_counts():
    comparison = {"candidate": metrics(95, 99), "baseline": metrics(90, 97)}
    comparison["baseline"]["ar"]["rows"] = 99
    with pytest.raises(ValueError, match="case counts differ"):
        development.gate([comparison])


def test_incomplete_training_cannot_start_development_evaluation(tmp_path):
    put(tmp_path / "policy.json", {})
    put(tmp_path / "report.json", {"status": "training"})
    with pytest.raises(ValueError, match="incomplete"):
        development.evaluate(argparse.Namespace(run=tmp_path))
    assert not (tmp_path / "development").exists()
