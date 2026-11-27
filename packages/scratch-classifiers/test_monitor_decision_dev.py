import json
from datetime import date, timedelta

import pytest

import train_monitor_decision_dev as trial
import numpy as np
from train_monitor_decision import Features, RealDecision, Schema, digest, matrix, stamp, utc_stamp


def decision(index, proposed, *, group=None, monitor=None, language="en", expected="none", baseline="offer"):
    return RealDecision(str(index), group or str(index), monitor or str(index), language, expected,
                        proposed, proposed + timedelta(hours=1), "initial", 1, {"label": baseline, "score": 0.8},
                        Features([0], {"waiting": 1}))


def write_manifest(path, start, end, source="human", *, bounded=True):
    manifest = {"source": source}
    if bounded:
        manifest["trialWindow"] = {"start": utc_stamp(start), "end": utc_stamp(end)}
    path.with_name(f"{path.name}.manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


@pytest.mark.parametrize("source,bounded", [("human", False), ("pipeline-check", True)])
def test_rejects_unbounded_or_generated_export_before_payload_access(tmp_path, source, bounded):
    path = tmp_path / "absent.jsonl"
    day = stamp("2026-01-01T00:00:00Z")
    write_manifest(path, day, day + timedelta(days=1), source, bounded=bounded)
    with pytest.raises(ValueError, match="bounded human"):
        trial.read_window("development", path)


def test_rejects_feedback_on_exclusive_end_and_cross_window_groups(tmp_path, monkeypatch):
    day = stamp("2026-01-01T00:00:00Z")
    first = decision(1, day, group="same")
    second = decision(2, day + timedelta(days=1), group="same")
    repeat_monitor = decision(3, day + timedelta(days=1), monitor=first.monitor_key)
    monkeypatch.setattr(trial.monitor, "load_export", lambda *_: ([first], {}))
    with pytest.raises(ValueError, match="outside its declared window"):
        trial.load_window(trial.Window("train", tmp_path / "train.jsonl", day, first.feedback_at), Schema(["waiting"], 1))
    for overlapping in (second, repeat_monitor):
        with pytest.raises(ValueError, match="crosses trial windows"):
            trial.require_disjoint([first], [overlapping])


def test_checks_preregistered_end_before_loading_any_rows(tmp_path):
    day = stamp("2026-01-01T00:00:00Z")
    paths = [tmp_path / f"{i}.jsonl" for i in range(3)]
    for i, path in enumerate(paths):
        write_manifest(path, day + timedelta(days=i), day + timedelta(days=i + 1))
    with pytest.raises(ValueError, match="predeclared development cutoff"):
        trial.run_trial(*paths, day + timedelta(days=2), tmp_path, day.date(), tmp_path / "results")


def test_paired_gate_only_vetoes_offers_and_clusters_repeated_conversations():
    day = stamp("2026-01-01T00:00:00Z")
    declines = [decision(i, day, group=f"c{i % 5}", language=("ar", "en")[i % 2]) for i in range(6)]
    approvals = [decision(6, day, language="ar", expected="offer"), decision(7, day, expected="offer")]
    other = [decision(8, day, expected="propose", baseline="propose"), decision(9, day)]
    rows = declines + approvals + other
    offer_ids = {row.case_id for row in declines + approvals}
    preserved = ["none"] * 6 + [None, "offer", "none", "none"]

    result = trial.compare_development(rows, offer_ids, preserved)

    assert result["developmentPassed"] is True
    assert result["pairedSignP"] == 1 / 32
    assert result["improvedConversations"] == 5
    assert result["overall"] == {
        "examples": 10, "eligibleOffers": 8, "positiveOffers": 2, "negativeOffers": 6, "suppressed": 6,
        "baselineCorrect": 3, "candidateCorrect": 9, "gains": 6, "losses": 0,
    }
    assert result["byLanguage"]["ar"]["gains"] == 3
    assert result["byLanguage"]["en"]["gains"] == 3

    lost_approval = preserved.copy()
    lost_approval[6] = "none"
    failed = trial.compare_development(rows, offer_ids, lost_approval)
    assert failed["developmentPassed"] is False
    assert failed["overall"]["losses"] == 1
    assert failed["pairedSignP"] is None
    assert trial.compare_development(rows, offer_ids - {"6"}, preserved)["developmentPassed"] is False


def test_fits_existing_weight_format_with_dev_only_provenance(monkeypatch):
    monkeypatch.setattr(trial, "logistic", lambda *_: (np.array([[2., -2.], [0., 0.]]), np.array([0., 0.])))
    schema = Schema(["waiting"], 1)
    features = matrix([Features([0], {"waiting": 0})], schema)

    fitting = matrix([Features([0], {"waiting": 0}), Features([], {"waiting": 1})], schema)
    candidate = trial.fit_weights(schema, fitting, ("none", "offer"), features, ["none"])

    assert json.loads(candidate)["trainingSource"] == trial.TRIAL_SOURCE
    assert trial.head_decisions(candidate, features) == [None]


def test_freezes_weights_before_reading_dev_and_records_failed_comparison(tmp_path, monkeypatch):
    day = stamp("2026-01-01T00:00:00Z")
    paths = [tmp_path / f"{i}.jsonl" for i in range(3)]
    for i, path in enumerate(paths):
        write_manifest(path, day + timedelta(days=i), day + timedelta(days=i + 1))
    development_payload = b'{"monitorDecision":"offer"}\n'
    paths[2].write_bytes(development_payload)
    rows_by_window = {
        "train": [decision(1, day), decision(2, day, expected="offer")],
        "calibration": [decision(3, day + timedelta(days=1))],
        "development": [decision(4, day + timedelta(days=2))],
    }
    frozen = b'{"trainingSource":"monitor-development-trial"}\n'
    steps = []

    def load_window(window, _schema):
        if window.name == "development":
            assert steps == ["fit"]
        return rows_by_window[window.name], {"sha256": digest(development_payload)}

    def fit_weights(*_):
        steps.append("fit")
        return frozen

    def head_decisions(weights, _features):
        assert weights == frozen
        return [None]

    monkeypatch.setattr(trial, "load_window", load_window)
    monkeypatch.setattr(trial, "fit_weights", fit_weights)
    monkeypatch.setattr(trial, "head_decisions", head_decisions)
    monkeypatch.setattr(trial.monitor, "bridge", lambda _: '{"frameFeatureKeys":["waiting"],"textFeatureDimensions":1}')
    monkeypatch.setattr(trial.monitor, "public_examples", lambda *_: ([], {"sources": {}}))
    monkeypatch.setattr(trial, "CODE_PATHS", ("packages/scratch-classifiers/train_monitor_decision_dev.py",))
    output = tmp_path / "result"

    result = trial.run_trial(*paths, day + timedelta(days=3), tmp_path, date(2026, 1, 4), output)

    assert result["comparison"]["developmentPassed"] is False
    assert result["comparison"]["overall"]["examples"] == 1
    assert {path.name for path in output.iterdir()} == {"trial-weights.json", "development.json", "manifest.json"}
    manifest = json.loads((output / "manifest.json").read_bytes())
    assert manifest["weightsSha256"] == digest(frozen)
    assert manifest["publicFit"]["retrievedOn"] == "2026-01-04"
    for name, expected in manifest["sha256"].items():
        assert digest((output / name).read_bytes()) == expected
    with pytest.raises(ValueError, match="new output directory"):
        trial.run_trial(*paths, day + timedelta(days=3), tmp_path, date(2026, 1, 4), output)
