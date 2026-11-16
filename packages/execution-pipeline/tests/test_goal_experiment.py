"""Experiment integrity checks run before any training or heldout prediction."""
import argparse
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("goal_experiment", ROOT / "scripts/run-goal-tagger-experiment.py")
experiment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(experiment)


def _put(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def test_incomplete_training_cannot_consume_a_holdout(tmp_path):
    run = tmp_path / "run"
    holdout = tmp_path / "heldout" / "goal_independent.jsonl"
    _put(run / "policy.json", {})
    _put(run / "report.json", {"status": "training"})
    args = argparse.Namespace(run=run, holdout=holdout)
    with pytest.raises(ValueError, match="incomplete"):
        experiment.evaluate(args)
    assert not (holdout.parent / "consumed.json").exists()
    assert not (run / "evaluation").exists()


def test_failed_training_process_cannot_consume_a_holdout(tmp_path):
    run = tmp_path / "run"
    holdout = tmp_path / "heldout" / "goal_independent.jsonl"
    _put(run / "policy.json", {})
    _put(run / "report.json", {"status": "completed"})
    _put(run / "training.json", {"exitCode": 1})
    args = argparse.Namespace(run=run, holdout=holdout)
    with pytest.raises(ValueError, match="unsuccessful"):
        experiment.evaluate(args)
    assert not (holdout.parent / "consumed.json").exists()


def test_case_and_whitespace_leakage_stops_before_creating_run(tmp_path, monkeypatch):
    monkeypatch.setattr(experiment, "ROOT", tmp_path)
    data, run = tmp_path / "data", tmp_path / "run"
    _put(data / "train.jsonl", {"input": {"message": "Create Ads in Leeds"}})
    _put(data / "validation.jsonl", {"input": {"message": "create   ads in leeds"}})
    with pytest.raises(ValueError, match="Dataset overlap"):
        experiment.train(argparse.Namespace(data=data, run=run))
    assert not run.exists()
