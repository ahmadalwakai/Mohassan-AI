"""Scorecard command integration on synthetic paired receipts."""
from hashlib import sha256
import json
from pathlib import Path

import pytest

from scripts.scorecard import __main__ as scorecard
from scripts.scorecard import receipts


@pytest.fixture
def simulated_run(tmp_path, monkeypatch):
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    source = Path(scorecard.__file__).parent
    (checkout / "scripts").mkdir()
    (checkout / "scripts" / "scorecard").symlink_to(source, target_is_directory=True)
    fixed_arms = [
        {"id": arm, "commit": scorecard.live.PRODUCTION_COMMIT, "switches": {}}
        for arm in ("baseline", "production")
    ]
    monkeypatch.setattr(scorecard.live, "default_arms", lambda _: fixed_arms)
    monkeypatch.setattr(scorecard.subprocess, "check_output", lambda *a, **kw: scorecard.live.PRODUCTION_COMMIT)
    monkeypatch.setattr(scorecard.live, "development_modules", lambda _: scorecard_development_modules())
    registrations = []

    def run_development(root, output, arms, *, command, **kwargs):
        start = json.loads((output.parent / "start.json").read_text())
        registrations.append(start["preregistration"])
        output.mkdir()
        observations = []
        for arm in arms:
            raw = output / (arm["id"] + "-raw.json")
            raw.write_text("{}")
            observations.append({
                "arm": arm["id"], "commit": arm["commit"],
                "cases": [{"suite_id": suite, "case_id": f"case-{language}", "family": "factual",
                           "language": language, "correct": arm["id"] == "baseline" or language == "ar"}
                          for suite in scorecard.live.SUITES["default_suites"] for language in ("ar", "en")],
                "metrics": {"first_progress_ms": [1, 2, 3, 4], "final_answer_ms": [11, 12, 13, 14],
                            "cpu_ms_per_turn": [5] * 4, "peak_rss_bytes": 1200},
                "unmeasured": {"model_files_bytes": "No model files in this synthetic run.",
                               "resident_worker_bytes": "No worker in this synthetic run."},
                "turns_by_language": {"ar": 2, "en": 2},
                "samples_by_language": {metric: {"ar": 2, "en": 2} for metric in receipts.SAMPLE_METRICS},
                "machine": {"system": "synthetic"},
                "evidence": {"command": command, "recorded_at": "2026-11-27T10:12:13Z", "raw_output": str(raw)},
            })
        return observations

    monkeypatch.setattr(scorecard.live, "run_development", run_development)
    return checkout, registrations


def scorecard_development_modules():
    from contextlib import nullcontext
    from types import SimpleNamespace
    return nullcontext((None, SimpleNamespace(OVERRIDES={"MOHASSAN_TEST": {"0", "1"}})))


def invoke(root, output, *extra):
    args = ["--output", str(output), *extra]
    return scorecard.execute(scorecard.arguments(args), args, root=root)


def test_stamp_before_measurement_and_history_appends(simulated_run, tmp_path):
    checkout, registrations = simulated_run
    registration = tmp_path / "preregister.json"
    document = {
        "schema_version": 1,
        "minimum_quality_gain": 0.1,
        "maximum_mcnemar_p": 0.05,
        "maximum_regressions": {"factual": {"ar": 0, "en": 0}},
        "maximum_p95_increase_ms": {key: 15 for key in scorecard.SPEED},
        "maximum_cost": {"cpu_ms_per_turn": 10, "peak_rss_bytes": 2000, "model_files_bytes": 2000,
                         "resident_worker_bytes": 2000, "training_gpu_hours": 10},
    }
    registration.write_text(json.dumps(document, indent=4))
    first = tmp_path / "first"
    second = tmp_path / "second"
    invoke(checkout, first, "--decisive", "--preregister", str(registration))
    report = invoke(checkout, second)
    assert registrations[0]["sha256"] == sha256(registration.read_bytes()).hexdigest()
    assert registrations[1] is None
    assert "## الجودة" in report.read_text()
    assert "case-en" in report.read_text()
    assert "keep in shadow" in report.read_text()
    history = [json.loads(line) for line in (tmp_path / "scorecard-history.jsonl").read_text().splitlines()]
    assert [(row["status"], row["run_path"]) for row in history] == [("completed", str(first)), ("completed", str(second))]
    assert history[0]["report_sha256"] == sha256((first / "report.md").read_bytes()).hexdigest()
    assert history[0]["results"]["production"]["decision"]["outcome"] == "drop"
    assert history[1]["results"]["production"]["quality"]["combined"]["overall"]["total"] == 4


def test_refuses_unregistered_or_unrecognized_settings_before_run(simulated_run, tmp_path):
    checkout, registrations = simulated_run
    output = tmp_path / "unused"
    for options, message in [
        (["--decisive"], "requires an owner pre-registration"),
        (["--set", "production:MOHASSAN_TEST=0"], "supported setting"),
        (["--arm", f"candidate={scorecard.live.PRODUCTION_COMMIT}", "--set", "candidate:UNKNOWN=0"], "supported setting"),
    ]:
        with pytest.raises(ValueError, match=message):
            invoke(checkout, output, *options)
    assert not registrations
    assert not output.exists()


def test_owner_production_profile_is_pinned_and_validated(simulated_run, tmp_path):
    checkout, _ = simulated_run
    profile = tmp_path / "production-settings.json"
    profile.write_text('{"switches":{"MOHASSAN_TEST":"1"}}')
    output = tmp_path / "profiled"
    invoke(checkout, output, "--production-profile", str(profile))
    start = json.loads((output / "start.json").read_text())
    assert start["production_profile_sha256"] == sha256(profile.read_bytes()).hexdigest()
    assert start["arms"]["production"]["switches"] == {"MOHASSAN_TEST": "1"}
    profile.write_text('{"switches":{"SYNTHETIC_AUTH_KEY":"do-not-export"}}')
    with pytest.raises(ValueError, match="setting unsupported"):
        invoke(checkout, tmp_path / "unused", "--production-profile", str(profile))
    assert not (tmp_path / "unused").exists()


def test_failed_measurement_gets_one_history_row(simulated_run, tmp_path, monkeypatch):
    checkout, _ = simulated_run

    def fail(*args, **kwargs):
        raise ValueError("synthetic observation failure")

    monkeypatch.setattr(scorecard.live, "run_development", fail)
    output = tmp_path / "failed"
    with pytest.raises(ValueError, match="synthetic observation failure"):
        invoke(checkout, output)
    history = (tmp_path / "scorecard-history.jsonl").read_text().splitlines()
    assert len(history) == 1
    assert json.loads(history[0])["status"] == "failed"
    assert not (output / "results.json").exists()


def test_private_contents_do_not_enter_any_scorecard_outputs(simulated_run, tmp_path, monkeypatch):
    checkout, _ = simulated_run
    private_path = tmp_path / "hidden-local-questions.json"
    evaluator_path = tmp_path / "hidden-local-program"
    text = "a private synthetic request"
    required = "a private synthetic expected reply"
    private_path.write_text(json.dumps([{"language": "en", "family": "factual", "text": text, "required": [required]}]))

    def evaluator(path, root, arms):
        assert path == evaluator_path
        assert root == checkout
        assert len(arms) == 2
        return lambda arm, prompts: [required if arm == "production" and prompts == (text,) else "unmatched"]

    monkeypatch.setattr(receipts, "private_evaluator", evaluator)
    output = tmp_path / "measured"
    invoke(checkout, output, f"--private-suite={private_path}", "--private-evaluator", str(evaluator_path))
    for path in [*output.rglob("*.json"), output / "report.md", tmp_path / "scorecard-history.jsonl"]:
        contents = path.read_text()
        assert all(secret not in contents for secret in (str(private_path), str(evaluator_path), text, required))
    summary = json.loads((output / "private-aggregates.json").read_text())
    assert summary["comparisons"]["production"] == [
        {"family": "factual", "language": "en", "total": 1, "correct": 1, "improved": 1, "regressed": 0}
    ]
    with pytest.raises(SystemExit):
        scorecard.arguments(["--output", str(output), "--private-s", str(private_path)])
