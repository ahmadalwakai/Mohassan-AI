from hashlib import sha256

import pytest

from corpus_pipeline.contamination import EvaluationIndex
from corpus_pipeline.inputs import json_bytes
from corpus_pipeline.normalization import match_key


def _freeze(path, records):
    raw = b"".join(json_bytes(record) for record in records)
    path.write_bytes(raw)
    return sha256(raw).hexdigest()


def test_contamination_reports_every_maximal_span_and_preserves_frozen_bytes(tmp_path):
    path = tmp_path / "frozen.jsonl"
    long_share = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen"
    exact_share = "sun moon stars clouds rain fog thunder wind snow hail frost sky storm"
    pin = _freeze(path, [
        {"id": "first", "text": f"reference prefix {long_share} reference middle {exact_share} reference suffix"},
        {"id": "second", "text": f"another {long_share} ending"},
    ])
    index = EvaluationIndex([(path, pin)])
    assert index.evidence == [{"path": path.as_posix(), "sha256": pin, "records": 2}]
    assert not index.find(match_key(" ".join(long_share.split()[:12])))
    hits = index.find(match_key(f"excerpt {long_share} differs {exact_share} tail"))
    assert [(hit["evaluation_id"], hit["training_token_start"], hit["evaluation_token_start"], hit["tokens"])
            for hit in hits] == [("first", 1, 2, 14), ("second", 1, 1, 14), ("first", 16, 18, 13)]
    assert all(hit["evaluation_path"] == path.as_posix() and hit["evaluation_sha256"] == pin for hit in hits)
    assert sha256(path.read_bytes()).hexdigest() == pin


def test_arabic_contamination_uses_the_configurable_normalized_token_width(tmp_path):
    path = tmp_path / "frozen.jsonl"
    pin = _freeze(path, [{"id": "ar", "text": "تَأَخَّرَتْ سَلْمَى مَعَ ٣ طَالِبَاتٍ"}])
    text = match_key("تاخرت سلمى مع 3 طالبات!")
    assert not EvaluationIndex([(path, pin)], 6).find(text)
    assert EvaluationIndex([(path, pin)], 5).find(text) == [{
        "evaluation_path": path.as_posix(), "evaluation_sha256": pin, "evaluation_id": "ar",
        "training_token_start": 0, "evaluation_token_start": 0, "tokens": 5,
    }]


def test_rejects_frozen_pin_mismatch_and_duplicate_ids(tmp_path):
    path = tmp_path / "frozen.jsonl"
    record = {"id": "a", "text": "some text"}
    pin = _freeze(path, [record])
    current_pin = _freeze(path, [{**record, "text": "changed text"}])
    assert current_pin != pin
    with pytest.raises(ValueError, match="Evaluation SHA-256 pin mismatch"):
        EvaluationIndex([(path, pin)])
    duplicate_pin = _freeze(path, [record, record])
    with pytest.raises(ValueError, match="Duplicate evaluation id"):
        EvaluationIndex([(path, duplicate_pin)])


def test_rejects_empty_frozen_file(tmp_path):
    path = tmp_path / "frozen.jsonl"
    pin = _freeze(path, [])
    with pytest.raises(ValueError, match="Evaluation set is empty"):
        EvaluationIndex([(path, pin)])
