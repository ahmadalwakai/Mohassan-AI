"""Selection evaluator integrity tests use synthetic fixtures and never run a model."""
import argparse
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("goal_selection", ROOT / "scripts/evaluate-goal-tagger-selection.py")
selection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selection)


def put(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def dataset(path, prefix, split):
    path.parent.mkdir(parents=True, exist_ok=True)
    items = [{"id": f"{prefix}-{language}-{index}", "capability": "ads.goal.v2", "language": language,
              "input": {"message": f"{prefix} {language} synthetic request {index}"}, "split": split,
              "trainingAllowed": split != "test_independent", "source": "synthetic"}
             for language in ("ar", "en") for index in range(100)]
    path.write_text("".join(json.dumps(item) + "\n" for item in items), encoding="utf-8")


def run_fixture(root, name):
    run = root / name
    data = root / f"{name}-data"
    for split in ("train", "validation"):
        dataset(data / f"{split}.jsonl", f"{name}-{split}", split)
    run.mkdir()
    (run / "best.pt").write_bytes(name.encode())
    source = run / "source/model.py"
    source.parent.mkdir()
    source.write_text("historical training implementation", encoding="utf-8")
    hashes = {split: {"sha256": selection.sha(data / f"{split}.jsonl")} for split in ("train", "validation")}
    put(run / "policy.json", {"data": hashes})
    put(run / "report.json", {"status": "completed", "checkpointSha256": selection.sha(run / "best.pt"),
                              "dataDirectory": str(data), "data": hashes, "seconds": 1, "bestEpoch": 1})
    put(run / "training.json", {"exitCode": 0})
    put(run / "source-manifest.json", [{"path": "model.py", "sha256": selection.sha(source)}])
    return run


@pytest.fixture
def experiment(tmp_path, monkeypatch):
    monkeypatch.setattr(selection, "ROOT", tmp_path)
    monkeypatch.setattr(selection, "SOURCES", ["model.py"])
    (tmp_path / "model.py").write_text("new inference implementation", encoding="utf-8")
    candidate, baseline = run_fixture(tmp_path, "candidate"), run_fixture(tmp_path, "baseline")
    data = tmp_path / "development"
    for split in ("train", "validation"):
        dataset(data / f"{split}.jsonl", f"development-{split}", split)
    holdout = tmp_path / "independent-new/goal_independent.jsonl"
    dataset(holdout, "final", "test_independent")
    return argparse.Namespace(candidate=candidate, baseline=baseline, data=data, holdout=holdout,
                              out=tmp_path / "evaluation", device="cpu")


def test_changed_current_source_does_not_rewrite_training_history(experiment):
    watched, models, _, _, _ = selection.preflight(experiment)
    historical = models["candidate"]["actualTrainingSources"][0]
    assert historical["sha256"] != selection.sha(selection.ROOT / "model.py")
    assert historical["sha256"] == selection.sha(Path(historical["snapshot"]))
    selection.assert_unchanged(watched)
    assert not experiment.out.exists()
    assert not (experiment.holdout.parent / "consumed.json").exists()


def test_archived_training_source_tamper_is_rejected(experiment):
    (experiment.candidate / "source/model.py").write_text("tampered", encoding="utf-8")
    with pytest.raises(ValueError, match="Recorded hash mismatch"):
        selection.preflight(experiment)
    assert not experiment.out.exists()
    assert not (experiment.holdout.parent / "consumed.json").exists()


@pytest.mark.parametrize("status,exit_code,error", [("training", 0, "incomplete"), ("completed", 1, "unsuccessful")])
def test_incomplete_or_failed_training_cannot_touch_holdout(experiment, status, exit_code, error):
    path = experiment.candidate / "report.json"
    report = selection.read(path)
    report["status"] = status
    put(path, report)
    put(experiment.candidate / "training.json", {"exitCode": exit_code})
    with pytest.raises(ValueError, match=error):
        selection.evaluate(experiment)
    assert not (experiment.holdout.parent / "consumed.json").exists()


def test_normalized_overlap_with_training_stops_before_output(experiment):
    report = selection.read(experiment.baseline / "report.json")
    original = next(selection.rows(Path(report["dataDirectory"]) / "train.jsonl"))["input"]["message"]
    items = list(selection.rows(experiment.holdout))
    items[0]["input"]["message"] = original.upper().replace(" ", "   ")
    experiment.holdout.write_text("".join(json.dumps(row) + "\n" for row in items), encoding="utf-8")
    with pytest.raises(ValueError, match="Dataset separation failed"):
        selection.evaluate(experiment)
    assert not experiment.out.exists()
    assert not (experiment.holdout.parent / "consumed.json").exists()


def test_changed_checkpoint_is_rejected(experiment):
    (experiment.candidate / "best.pt").write_bytes(b"replacement")
    with pytest.raises(ValueError, match="Recorded hash mismatch"):
        selection.preflight(experiment)


def test_calibration_validation_must_be_unseen_by_both_models(experiment):
    report = selection.read(experiment.baseline / "report.json")
    prior = next(selection.rows(Path(report["dataDirectory"]) / "train.jsonl"))["input"]["message"]
    path = experiment.data / "validation.jsonl"
    items = list(selection.rows(path))
    items[0]["input"]["message"] = prior.upper().replace(" ", "   ")
    path.write_text("".join(json.dumps(row) + "\n" for row in items), encoding="utf-8")
    with pytest.raises(ValueError, match="calibration_validation_vs_training"):
        selection.evaluate(experiment)
    assert not experiment.out.exists()
    assert not (experiment.holdout.parent / "consumed.json").exists()


def test_consumed_holdout_or_existing_output_is_rejected(experiment):
    put(experiment.holdout.parent / "consumed.json", {"status": "prior_run"})
    with pytest.raises(ValueError, match="already consumed"):
        selection.preflight(experiment)
    experiment.out.mkdir()
    with pytest.raises(ValueError, match="reuse evaluation"):
        selection.preflight(experiment)


def test_both_policies_freeze_before_consumption_and_final_predictions(experiment, monkeypatch):
    events = []

    def execute(argv, destination, name, echo=True):
        argv = [str(item) for item in argv]
        destination.mkdir(parents=True, exist_ok=True)
        option = lambda key: Path(argv[argv.index(key) + 1])
        if name == "generation":
            final = option("--input") == experiment.holdout
            events.append(("final" if final else "development", destination.name))
            if final:
                assert (experiment.holdout.parent / "consumed.json").exists()
                for model in ("candidate", "baseline"):
                    criteria = selection.read(experiment.out / model / "criteria.json")
                    assert criteria["minimumRawExactAccuracy"] == 0.95
                    assert criteria["minimumAcceptedPrecision"] == 0.99
                    assert criteria["minimumAcceptedCoverage"] == 0.8
                    assert criteria["minimumAcceptedCasesPerLanguage"] == 100
                    assert criteria["acceptance"]["calibrationSha256"] == selection.sha(experiment.out / "calibration" / model / "policy.json")
            else:
                assert not (experiment.holdout.parent / "consumed.json").exists()
            option("--output").write_text("{}\n", encoding="utf-8")
        elif name == "calibration":
            assert not (experiment.holdout.parent / "consumed.json").exists()
            threshold = 0.8
            put(option("--output"), {"method": "minimum_decision_probability_v1", "usesFinalTest": False,
                "dataset": str(option("--dataset")), "datasetSha256": selection.sha(option("--dataset")),
                "answersSha256": selection.sha(option("--answers")), "checkpointSha256": selection.sha(option("--checkpoint")),
                "calibratedAt": selection.now(), "thresholds": {"ar": threshold, "en": threshold},
                "byLanguage": {lang: {**selection.CALIBRATION, "threshold": threshold, "rows": 100} for lang in ("ar", "en")},
                "sources": [{"path": "model.py", "sha256": selection.sha(selection.ROOT / "model.py")}]})
        elif name == "scoring":
            put(option("--output"), {"inputIntegrity": {"status": "passed"}, "status": "failed", "failures": ["synthetic_failure"],
                "metrics": {"byLanguage": {lang: {"rawExactAccuracy": 0.9} for lang in ("ar", "en")}}})
        else:
            raise AssertionError(name)

    monkeypatch.setattr(selection, "execute", execute)
    selection.evaluate(experiment)
    assert [event[0] for event in events] == ["development", "development", "final", "final"]
    policy = selection.read(experiment.out / "policy.json")
    assert policy["trainingAndInferenceSourcesAreDistinct"] is True
    assert policy["models"]["candidate"]["trainingToInferenceSourceDifferences"] == ["model.py"]
    result = selection.read(experiment.out / "comparison.json")
    assert result["finalLabelsUsedToSelectCheckpoint"] is False
    assert result["productionReady"] is False
    assert result["comparison"]["candidate"]["status"] == "failed"


def test_calibration_policy_cannot_silently_relax_coverage(tmp_path):
    path = tmp_path / "policy.json"
    data_path = tmp_path / "validation.jsonl"
    data_path.write_text("data", encoding="utf-8")
    answers = tmp_path / "answers.jsonl"
    answers.write_text("answers", encoding="utf-8")
    put(path, {"method": "minimum_decision_probability_v1", "usesFinalTest": False,
        "dataset": str(data_path), "datasetSha256": selection.sha(data_path), "answersSha256": selection.sha(answers),
        "checkpointSha256": "checkpoint", "thresholds": {"ar": 0.8, "en": 0.8}, "sources": [],
        "byLanguage": {lang: {**selection.CALIBRATION, "minimumCoverage": 0.01, "threshold": 0.8, "rows": 100} for lang in ("ar", "en")}})
    with pytest.raises(ValueError, match="differs from the fixed policy"):
        selection.verify_calibration(path, {"checkpointSha256": "checkpoint"},
                                     {"validation": {"path": str(data_path), "sha256": selection.sha(data_path),
                                                     "languages": {"ar": 100, "en": 100}}}, answers, [])
