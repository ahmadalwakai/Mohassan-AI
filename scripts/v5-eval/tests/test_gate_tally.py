"""Fixture tests for frozen IDs, verdict validation, and tally output."""
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import gate_tally as tool  # noqa: E402
from execution_pipeline import chat_probes, gate3_probes  # noqa: E402


LANGUAGES = ("ar", "en")
CHAT_IDS = chat_probes.EXPECTED_IDS
# Gate 3 IDs and acceptance rule (retrieved 2026-11-25), also checked against _validate_rows.
# https://github.com/ahmadalwakai/Mohassan-AI/blob/c2a0ff765071657cf200b5ee7d12fabaad738c0b/packages/execution-pipeline/execution_pipeline/gate3_probes.py#L73
# https://github.com/ahmadalwakai/Mohassan-AI/blob/c2a0ff765071657cf200b5ee7d12fabaad738c0b/docs/CHAT-MODEL-TRAINING-PLAN.md#84-stages-and-gates
PROSE_IDS = [f"gate3-{language}-{number:02d}" for language in LANGUAGES for number in range(1, 21)]


def _jsonl(path, rows):
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


def _fixture_files(tmp_path, probe_ids, strict_passes=None):
    strict_passes = strict_passes or dict.fromkeys(LANGUAGES, 20)
    predictions, verdicts = [], []
    for probe_id in probe_ids:
        suite, language, number = probe_id.split("-")
        index = int(number)
        row = {
            "id": probe_id,
            "language": language,
            "text": "again again again again again again" if index in (1, 3) else "complete response",
            "stop_reason": "eos" if index in (2, 3) else "length",
            "terminal_token_id": 258 if index in (2, 3) else None,
            "output_tokens": 10 if index in (2, 3) else 192,
        }
        if suite == "chat":
            row["category"] = "fixture"
        predictions.append(row)
        verdicts.append({"id": probe_id, "verdict": "pass" if index <= strict_passes[language] else "fail",
                         "content": "pass" if index != 2 else "fail", "loop": "yes" if index == 2 else "no",
                         "reason": "Synthetic reader mark"})

    predictions_path = tmp_path / "predictions.jsonl"
    verdicts_path = tmp_path / "verdicts.jsonl"
    preregistration_path = tmp_path / "preregistration.json"
    _jsonl(predictions_path, predictions)
    _jsonl(verdicts_path, verdicts)
    core = {language: [probe_id for probe_id in CHAT_IDS if probe_id.split("-")[1] == language]
            for language in LANGUAGES}
    known_hard = {core[language].pop(0): "Synthetic known-hard case" for language in LANGUAGES}
    preregistration = {"core_chat_probes": core, "known_hard": known_hard}
    preregistration_path.write_text(json.dumps(preregistration), encoding="utf-8")
    return (predictions_path, verdicts_path, preregistration_path), predictions, verdicts, preregistration


def test_gate3_ids_match_pinned_frozen_structure():
    rows = [{"id": probe_id, "language": language, "prompt": "Fixture prefix", "criterion": "Fixture criterion",
             "probe_type": "raw_prose_continuation", "development_only": True, "independent_test": False}
            for probe_id, language in tool.GATE3_LANGUAGES.items()]
    gate3_probes._validate_rows(rows)


@pytest.mark.parametrize(("ar", "en", "meets_rule"), [(15, 20, False), (20, 15, False), (16, 16, True), (20, 20, True)])
def test_gate3_threshold_uses_only_strict_verdicts_in_each_language(tmp_path, ar, en, meets_rule):
    paths, *_ = _fixture_files(tmp_path, PROSE_IDS, {"ar": ar, "en": en})
    result = tool.tally(*paths)

    assert result["probe_suite"] == "gate3"
    assert result["gate3_strict_rule"] == {"probes_per_language": 20, "minimum_strict_passes_per_language": 16,
                                           "met_in_both_languages": meets_rule}
    assert result["languages"] == {language: {"total": 20, "strict_passes": count, "content_passes": 19,
                                              "reader_loops": 1, "objective_eos": 2, "objective_loops": 2}
                                   for language, count in (("ar", ar), ("en", en))}
    assert "gate3_passed" not in result


def test_chat_reports_preregistered_core_and_known_hard_apart(tmp_path):
    paths, _, _, preregistration = _fixture_files(tmp_path, CHAT_IDS)
    result = tool.tally(*paths)

    assert result["probe_suite"] == "chat"
    assert result["known_hard"] == preregistration["known_hard"]
    for counts in result["languages"].values():
        assert counts["core"] == {"total": 19, "strict_passes": 19, "content_passes": 18, "reader_loops": 1,
                                   "objective_eos": 2, "objective_loops": 1}
        assert counts["known_hard"] == {"total": 1, "strict_passes": 1, "content_passes": 1, "reader_loops": 0,
                                         "objective_eos": 0, "objective_loops": 1}


@pytest.mark.parametrize("file_index", [0, 1])
@pytest.mark.parametrize("change", ["duplicate", "missing", "extra"])
def test_tally_rejects_duplicate_missing_and_extra_ids(tmp_path, file_index, change):
    paths, predictions, verdicts, _ = _fixture_files(tmp_path, PROSE_IDS)
    rows = (predictions, verdicts)[file_index]
    if change == "duplicate":
        rows.append(rows[0])
    elif change == "missing":
        rows.pop(0)
    else:
        rows.append({**rows[0], "id": "gate3-ar-extra"})
    _jsonl(paths[file_index], rows)

    with pytest.raises(ValueError, match=r"(?i)duplicate|missing IDs.*extra IDs"):
        tool.tally(*paths)


@pytest.mark.parametrize(("key", "value"), [("verdict", "Pass"), ("content", True), ("loop", "unknown"),
                                            ("reason", " "), ("reason", None), ("reason", "two\nlines")])
def test_tally_rejects_invalid_reader_values(tmp_path, key, value):
    paths, _, verdicts, _ = _fixture_files(tmp_path, CHAT_IDS)
    verdicts[0][key] = value
    _jsonl(paths[1], verdicts)

    with pytest.raises(ValueError, match="Invalid reader verdict"):
        tool.tally(*paths)


def test_tally_rejects_language_mismatch_and_sampled_predictions(tmp_path):
    paths, predictions, *_ = _fixture_files(tmp_path, CHAT_IDS)
    predictions[0]["language"] = "en"
    _jsonl(paths[0], predictions)
    with pytest.raises(ValueError, match="Prediction language"):
        tool.tally(*paths)

    predictions[0]["language"] = "ar"
    predictions[0]["seed"] = 1
    _jsonl(paths[0], predictions)
    with pytest.raises(ValueError, match="Sampling diagnostic predictions"):
        tool.tally(*paths)


@pytest.mark.parametrize("change", ["overlap", "missing", "extra", "wrong_language", "invalid_reason"])
def test_tally_rejects_invalid_preregistration_groups(tmp_path, change):
    paths, _, _, preregistration = _fixture_files(tmp_path, CHAT_IDS)
    core = preregistration["core_chat_probes"]
    known_hard = preregistration["known_hard"]
    if change == "overlap":
        known_hard[core["ar"][0]] = "Duplicate ID"
    elif change == "missing":
        core["ar"].pop()
    elif change == "extra":
        known_hard["chat-en-extra"] = "Extra ID"
    elif change == "wrong_language":
        core["en"].append(core["ar"].pop())
    else:
        known_hard[next(iter(known_hard))] = None
    paths[2].write_text(json.dumps(preregistration), encoding="utf-8")

    with pytest.raises(ValueError, match=r"Duplicate pre-registration|Pre-registration|Unexpected ID|known_hard"):
        tool.tally(*paths)


def test_cli_writes_only_tally_and_refuses_existing_or_reserved_outputs(tmp_path, monkeypatch, capsys):
    paths, *_ = _fixture_files(tmp_path, PROSE_IDS)
    output = tmp_path / "tally.json"
    command = ["gate_tally.py", "--predictions", str(paths[0]), "--verdicts", str(paths[1]),
               "--preregistration", str(paths[2]), "--output"]
    monkeypatch.setattr(sys, "argv", [*command, str(output)])
    tool.main()
    original = output.read_bytes()
    assert json.loads(original) == tool.tally(*paths)

    with pytest.raises(SystemExit) as error:
        tool.main()
    assert error.value.code == 2
    assert output.read_bytes() == original
    assert "File exists" in capsys.readouterr().err

    for reserved in ("assessment.json", "gate3_passed", "gate3_passed.json", "protocol.json"):
        monkeypatch.setattr(sys, "argv", [*command, str(tmp_path / reserved)])
        with pytest.raises(SystemExit) as error:
            tool.main()
        assert error.value.code == 2
        assert "reserved gate artifact names" in capsys.readouterr().err
    assert set(tmp_path.iterdir()) == {*paths, output}
