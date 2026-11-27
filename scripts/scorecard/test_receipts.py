"""Scorecard adapters are exercised with synthetic local receipts only."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from pathlib import Path
import subprocess

import pytest

from scripts.scorecard import receipts


COMMIT = sha256(b"synthetic arm revision").hexdigest()[:40]
STAMP = datetime(2026, 11, 27, tzinfo=timezone.utc).isoformat()


def write_json(path, value):
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


def evidence(raw):
    return {"command": ["synthetic-measurement"], "recorded_at": STAMP, "raw_output": raw.name,
            "sha256": sha256(raw.read_bytes()).hexdigest()}


def test_native_receipt_pins_public_source_and_validates_turn_coverage(tmp_path):
    raw = write_json(tmp_path / "raw.json", {"sample": [2]})
    native = {
        "arm": "baseline", "commit": COMMIT,
        "cases": [{"suite_id": "development", "case_id": "fixture-id", "family": "coding", "language": "en",
                   "correct": True}],
        "metrics": {"first_progress_ms": [2]},
        "unmeasured": dict.fromkeys(receipts.ARM_METRICS - {"first_progress_ms"}, "synthetic input omits metric"),
        "machine": {"arch": "synthetic"}, "evidence": evidence(raw), "sources": [evidence(raw)],
        "turns_by_language": {"en": 1}, "samples_by_language": {"first_progress_ms": {"en": 1}},
    }
    path = write_json(tmp_path / "arm.json", native)
    parsed = receipts.read_arm_receipt(path)
    assert parsed["receipt_sha256"] == sha256(path.read_bytes()).hexdigest()
    assert parsed["sources"][0]["sha256"] == parsed["evidence"]["sha256"] == native["evidence"]["sha256"]
    assert parsed["evidence"]["raw_output"] == str(raw)

    malformed = deepcopy(native)
    malformed["samples_by_language"] = {"first_progress_ms": {"en": 0}}
    with pytest.raises(ValueError, match="coverage"):
        receipts.validate_arm_receipt(malformed)
    malformed = deepcopy(native)
    malformed["unmeasured"].pop("cpu_ms_per_turn")
    with pytest.raises(ValueError, match="cpu_ms_per_turn requires a reason"):
        receipts.validate_arm_receipt(malformed)
    malformed = deepcopy(native)
    malformed["cases"][0]["suite_id"] = receipts.PRIVATE_SUITE
    with pytest.raises(ValueError, match="Private case rows"):
        receipts.validate_arm_receipt(malformed)
    raw.write_text("tampered", encoding="utf-8")
    with pytest.raises(ValueError, match="SHA-256 differs"):
        receipts.read_arm_receipt(path)


def test_supplements_with_runtime_samples_and_paired_ablation_counts(tmp_path):
    raw = write_json(tmp_path / "runtime.json", {"elapsed": [3], "resident": 1})
    metadata = {"arm": "switch-on", "commit": COMMIT, "evidence": evidence(raw)}
    runtime = {**metadata, "format": "scorecard-model-runtime-v1", "model_version": "local-v1",
               "machine": {"arch": "synthetic"}, "metrics": {"model_latency_ms": [3], "resident_worker_bytes": 1},
               "unmeasured": dict.fromkeys({"model_files_bytes", "worker_peak_rss_bytes"}, "synthetic omission")}
    path = write_json(tmp_path / "model.json", runtime)
    assert receipts.read_supplement(path)["metrics"] == runtime["metrics"]
    runtime["metrics"]["resident_worker_bytes"] = True
    with pytest.raises(ValueError, match="Invalid nonnegative byte count"):
        receipts.read_supplement(write_json(path, runtime))

    matched_correct, matched_wrong, improved, regressed = 2, 1, 1, 2
    group = {"suite_id": "dev-bench-v1", "family": "coding", "language": "ar",
             "total": sum([matched_correct, matched_wrong, improved, regressed]),
             "baseline_correct": matched_correct + regressed, "correct": matched_correct + improved,
             "improved": improved, "regressed": regressed}
    ablation = {**metadata, "format": "scorecard-dev-bench-ablation-v1",
                "baseline_arm": "baseline", "baseline_commit": COMMIT, "switch": "fixture-switch", "groups": [group]}
    path = write_json(tmp_path / "ablation.json", ablation)
    assert receipts.read_supplement(path)["groups"] == [group]
    group["correct"] += 1
    with pytest.raises(ValueError, match="Inconsistent paired ablation counts"):
        receipts.read_supplement(write_json(path, ablation))


def test_reads_training_hours_from_original_gpu_receipts(tmp_path):
    started = datetime.fromisoformat(STAMP)
    elapsed = timedelta(hours=2, minutes=15)
    ended = (started + elapsed).isoformat()
    start = write_json(tmp_path / "gpu-start.json", {"start_time": STAMP, "nvidia_smi": "Synthetic GPU, 1, 0, 0"})
    summary = write_json(tmp_path / "gpu-summary.json", {"end_time": ended, "problem": None, "samples": 1})
    command = ["synthetic-training-command"]
    measured = receipts.read_training_run(tmp_path, command)
    assert measured["gpu_hours"] == elapsed / timedelta(hours=1)
    assert (measured["started_at"], measured["completed_at"]) == (STAMP, ended)
    assert measured["started_receipt_sha256"] == sha256(start.read_bytes()).hexdigest()
    assert measured["raw_output_sha256"] == sha256(summary.read_bytes()).hexdigest()
    assert measured["evidence"]["command"] == command
    write_json(summary, {"end_time": ended, "problem": "Synthetic failure", "samples": 1})
    with pytest.raises(ValueError, match="instrumented single-GPU"):
        receipts.read_training_run(tmp_path, command)


def test_refuses_direct_and_symlink_protected_paths_before_any_read(tmp_path, monkeypatch):
    prohibited = tmp_path / "artifacts" / "brain-lab" / "holdout-v1" / "never-read.json"
    alias = tmp_path / "alias.json"
    alias.symlink_to(prohibited)

    def never_read(_path):
        pytest.fail("protected evidence must never be read")

    monkeypatch.setattr(Path, "read_bytes", never_read)
    with pytest.raises(ValueError, match="sealed holdout"):
        receipts.read_arm_receipt(prohibited)
    with pytest.raises(ValueError, match="sealed holdout"):
        receipts.read_supplement(alias)
    with pytest.raises(ValueError, match="sealed holdout"):
        receipts.sha256_file(tmp_path / "artifacts" / "chat-training" / "conversation-v1" / "holdout" / "never-read.json")


def test_private_suite_returns_only_counts_and_redacts_failure(tmp_path, capsys):
    checkout = tmp_path / "repo"
    checkout.mkdir()
    first, second = "secret-question-token", "private-second-prompt"
    first_answer, second_answer = "private-gold-first", "private-gold-second"
    questions = [{"family": "factual", "language": "ar", "text": first, "required": [first_answer]},
                 {"family": "factual", "language": "ar", "text": second, "required": [second_answer]}]
    path = write_json(tmp_path / "private-name.json", questions)
    args = [path, checkout, ("baseline", "control", "candidate"), "baseline"]
    options = {"families": {"factual"}, "languages": {"ar"}, "additional_references": {"candidate": "control"}}
    answers = {"baseline": (first_answer, "wrong"), "control": ("wrong", second_answer),
               "candidate": (first_answer, second_answer)}
    called = []

    def evaluate(arm, prompts):
        assert prompts == (first, second)
        called.append(arm)
        return answers[arm]

    result = receipts.run_private_suite(*args, evaluate, **options)
    assert called == list(args[2])
    assert result["candidate/control"] == [{"family": "factual", "language": "ar", "total": len(questions),
                                            "correct": len(questions), "improved": 1, "regressed": 0}]
    assert result["baseline"][0]["improved"] == result["baseline"][0]["regressed"] == 0
    output = json.dumps(result)
    for secret in (first, second, first_answer, second_answer, path.name):
        assert secret not in output
    assert not list(checkout.iterdir())
    assert capsys.readouterr() == ("", "")

    def failed_evaluation(arm, prompts):
        raise ValueError(prompts[0])

    with pytest.raises(ValueError, match=r"^Local private suite evaluation failed\.$"):
        receipts.run_private_suite(*args, failed_evaluation, **options)
    assert capsys.readouterr() == ("", "")
    in_repo = write_json(checkout / "local.json", questions)
    with pytest.raises(ValueError, match="outside Git"):
        receipts.run_private_suite(in_repo, *args[1:], evaluate, **options)


def test_private_evaluator_stdin_and_egress_boundary(tmp_path, monkeypatch):
    checkout = tmp_path / "repo"
    checkout.mkdir()
    program = tmp_path / "local-evaluator"
    program.touch(mode=0o700)
    stored = []
    private_prompt = "private-probe-prompt"
    private_reply = "private-probe-reply"
    calls = []

    def run(command, **kwargs):
        calls.append((command, kwargs))
        assert "--net" in command and kwargs["stderr"] == subprocess.DEVNULL
        assert private_prompt not in "/".join(command)
        if "input" not in kwargs:
            return subprocess.CompletedProcess(command, 0)
        request = json.loads(kwargs["input"])
        assert request["prompts"] == [private_prompt]
        assert request["arm"]["id"] == "baseline"
        assert "HTTP_PROXY" not in kwargs["env"]
        stored.append(kwargs["cwd"])
        return subprocess.CompletedProcess(command, 0, json.dumps([private_reply]).encode())

    monkeypatch.setenv("HTTP_PROXY", "http://localhost:1")
    monkeypatch.setattr(receipts.sys, "platform", "linux")
    monkeypatch.setattr(receipts.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(receipts.subprocess, "run", run)
    evaluate = receipts.private_evaluator(program, checkout, [{"id": "baseline"}])
    assert evaluate("baseline", [private_prompt]) == [private_reply]
    assert len(calls) == 2
    assert not stored[0].exists()

    def denied(command, **kwargs):
        assert "input" not in kwargs
        return subprocess.CompletedProcess(command, 1)

    monkeypatch.setattr(receipts.subprocess, "run", denied)
    with pytest.raises(ValueError, match="could not create an isolated Linux network namespace"):
        receipts.private_evaluator(program, checkout, [{"id": "baseline"}])
