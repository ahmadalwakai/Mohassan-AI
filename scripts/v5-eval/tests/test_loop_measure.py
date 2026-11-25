import hashlib
import json
from pathlib import Path
import subprocess
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import loop_measure


@pytest.mark.parametrize(("text", "count", "phrase", "looped"), [
    ("ONE two three four\tone two three four\nOne Two Three Four", 3, "one two three four", True),
    ("ﺳﻼﻡ   ﺑﻜﻢ ﻓﻲ ﺍﻟﺒﻴﺖ\nسلام بكم في البيت\tسلام بكم في البيت", 3, "سلام بكم في البيت", True),
    ("go go go go go go", 3, "go go go go", True),
    ("قُل قُل قُل قُل قُل", 2, "قُل قُل قُل قُل", False),
    ("a b a b a b a b", 3, "a b a b", True),
    ("one two three", 0, None, False),
    ("one two three four", 1, None, False),
])
def test_measure_loop(text, count, phrase, looped):
    assert loop_measure.measure_loop(text) == {
        "looped": looped, "highest_count": count, "repeated_phrase": phrase,
    }


@pytest.mark.parametrize(("reason", "terminal", "tokens", "counted"), [
    ("eos", 258, 1, True),
    ("eos", 258, 192, True),
    ("eos", 258, 193, False),
    ("eos", 258, 0, False),
    ("eos", 2, 192, False),
    ("eos", None, 192, False),
    ("length", 258, 192, False),
])
def test_eos_requires_both_markers_within_budget(reason, terminal, tokens, counted):
    row = dict(stop_reason=reason, terminal_token_id=terminal, output_tokens=tokens)
    assert loop_measure.counts_as_eos(row) is counted


def test_score_cli_reports_both_languages_and_hashes_existing_format(tmp_path):
    predictions = tmp_path / "predictions.jsonl"
    output = tmp_path / "score.json"
    rows = [
        dict(id="chat-ar-01", language="ar", category="fixture", text="نعم", finished=False,
             stop_reason="eos", terminal_token_id=258, output_tokens=192),
        dict(id="chat-ar-02", language="ar", category="fixture", text="", finished=False,
             stop_reason="error", output_tokens=0),
        dict(id="chat-en-01", language="en", category="fixture", text="go\u2028go go go go go",
             finished=True, stop_reason="length", terminal_token_id=None, output_tokens=192),
    ]
    data = "".join(json.dumps(row, ensure_ascii=False) + "\r\n" for row in rows).encode()
    predictions.write_bytes(data)
    source = Path(loop_measure.__file__)
    command = [sys.executable, str(source), "score", "--predictions", str(predictions), "--output", str(output)]
    subprocess.run(command, check=True)
    result = json.loads(output.read_text(encoding="utf-8"))
    assert set(result) == {"predictions_sha256", "tool_sha256", "by_language", "by_id"}
    assert result["predictions_sha256"] == hashlib.sha256(data).hexdigest()
    assert result["tool_sha256"] == hashlib.sha256(source.read_bytes()).hexdigest()
    assert result["by_language"] == {
        "ar": dict(total=2, eos=1, loops=0, length_stops=0),
        "en": dict(total=1, eos=0, loops=1, length_stops=1),
    }
    assert set(result["by_id"]) == {row["id"] for row in rows}
    assert result["by_id"]["chat-en-01"]["repeated_phrase"] == "go go go go"
    original = output.read_bytes()
    assert subprocess.run(command, capture_output=True).returncode != 0
    assert output.read_bytes() == original


def test_prediction_record_rejects_duplicate_json_keys(tmp_path):
    predictions = tmp_path / "predictions.jsonl"
    predictions.write_text('{"id":"chat-ar-01","id":"chat-ar-02"}\n', encoding="utf-8")
    with pytest.raises(ValueError, match="duplicate JSON key 'id'"):
        loop_measure.load_predictions(predictions)


@pytest.fixture
def sampled_rows():
    rows = []
    for seed, language, eos, loop in [
        (2, "en", True, False), (1, "ar", True, False),
        (3, "ar", True, True), (3, "en", False, False),
        (1, "en", False, True), (2, "ar", False, True),
    ]:
        rows.append({
            "id": f"chat-{language}-01",
            "language": language,
            "text": "one one one one one one" if loop else "no repeated phrase",
            "stop_reason": "eos" if eos else "length",
            "terminal_token_id": 258 if eos else None,
            "output_tokens": 10 if eos else 192,
            "seed": seed,
            "decoding": {"do_sample": True},
        })
    return rows


def _write_predictions(path, rows):
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")


def test_score_sampling_diagnostic_by_language_and_seed(tmp_path, sampled_rows):
    predictions = tmp_path / "predictions.jsonl"
    output = tmp_path / "score.json"
    _write_predictions(predictions, sampled_rows)
    loaded, _ = loop_measure.load_predictions(predictions)
    assert loaded == {(row["id"], row["seed"]): row for row in sampled_rows}

    loop_measure.score(predictions, output)
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["by_language"] == {
        "ar": dict(total=3, eos=2, loops=2, length_stops=1),
        "en": dict(total=3, eos=1, loops=1, length_stops=2),
    }
    assert report["by_seed"] == {
        "1": {"ar": dict(total=1, eos=1, loops=0, length_stops=0),
              "en": dict(total=1, eos=0, loops=1, length_stops=1)},
        "2": {"ar": dict(total=1, eos=0, loops=1, length_stops=1),
              "en": dict(total=1, eos=1, loops=0, length_stops=0)},
        "3": {"ar": dict(total=1, eos=1, loops=1, length_stops=0),
              "en": dict(total=1, eos=0, loops=0, length_stops=1)},
    }
    assert set(report["by_id"]) == {f'{row["id"]}#seed{row["seed"]}' for row in sampled_rows}
    assert report["by_id"]["chat-ar-01#seed3"] == {
        "looped": True, "highest_count": 3, "repeated_phrase": "one one one one",
    }


@pytest.mark.parametrize(("case", "error"), [
    ("duplicate", r"duplicate prediction \(id, seed\)"),
    ("missing", r"missing seeds \[2\] for prediction ID 'chat-en-01'"),
    ("mixed_seed_first", "mixed predictions with and without a seed"),
    ("mixed_unseeded_first", "mixed predictions with and without a seed"),
])
def test_refuses_inconsistent_sampling_records(tmp_path, sampled_rows, case, error):
    if case == "duplicate":
        sampled_rows.append(sampled_rows[0])
    elif case == "missing":
        sampled_rows.pop(0)
    else:
        index = 0 if case == "mixed_unseeded_first" else -1
        del sampled_rows[index]["seed"]
    predictions = tmp_path / "predictions.jsonl"
    output = tmp_path / "score.json"
    _write_predictions(predictions, sampled_rows)
    with pytest.raises(ValueError, match=error):
        loop_measure.score(predictions, output)
    assert not output.exists()


@pytest.mark.parametrize("seed", [0, 4, True, "2", None])
def test_refuses_invalid_sampling_seed(tmp_path, sampled_rows, seed):
    sampled_rows[0]["seed"] = seed
    predictions = tmp_path / "predictions.jsonl"
    _write_predictions(predictions, sampled_rows)
    with pytest.raises(ValueError, match="invalid seed"):
        loop_measure.load_predictions(predictions)
