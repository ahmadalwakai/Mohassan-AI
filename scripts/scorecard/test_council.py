from pytest import raises

from scripts.scorecard.council import _normalize
from scripts.scorecard.live import PRODUCTION_COMMIT
from scripts.scorecard.receipts import validate_arm_receipt


def test_council_receipt_keeps_verdicts_and_language_coverage():
    evidence = {"command": ["synthetic-council"], "recorded_at": "2026-11-27T10:00:00Z", "raw_output": "raw.json"}
    arm = {"id": "sample", "commit": PRODUCTION_COMMIT}
    rows = [
        {"case_id": "sample-ar", "language": "ar", "family": "factual", "correct": True, "first_progress_ms": 3,
         "final_answer_ms": 10, "cpu_ms_per_turn": 4, "members": [], "prompt": "local answer"},
        {"case_id": "sample-en", "language": "en", "family": "factual", "correct": False, "first_progress_ms": None,
         "final_answer_ms": None, "cpu_ms_per_turn": 5, "members": []},
    ]
    observed = {"rows": rows, "peak_rss_bytes": 1024, "model": None, "resident_worker_bytes": None,
                "machine": {"platform": "synthetic"}}
    receipt = _normalize(arm, observed, evidence, [], "factual")
    validate_arm_receipt(receipt)
    assert receipt["metrics"]["first_progress_ms"] == [rows[0]["first_progress_ms"]]
    assert receipt["samples_by_language"]["first_progress_ms"] == {"ar": 1, "en": 0}
    assert receipt["turns_by_language"] == {item["language"]: 1 for item in rows}
    assert "local answer" not in str(receipt)
    assert receipt["unmeasured"].keys() == {"model_files_bytes", "resident_worker_bytes"}

    arm["model_version"] = "reading-v3-last"
    with raises(ValueError, match="did not execute selected local model"):
        _normalize(arm, observed, evidence, [], "factual")
    rows[1]["members"] = [{"model": arm["model_version"], "outcome": "abstained"}]
    observed["model"] = {"bytes": 2048}
    receipt = _normalize(arm, observed, evidence, [], "factual")
    validate_arm_receipt(receipt)
    assert receipt["metrics"]["model_files_bytes"] == observed["model"]["bytes"]
    assert receipt["metrics"]["cpu_ms_per_turn"] is None
    assert receipt["metrics"]["peak_rss_bytes"] is None
    assert "worker" in receipt["unmeasured"]["peak_rss_bytes"]
    rows[0]["family"] = "different"
    with raises(ValueError, match="family differs from the suite manifest"):
        _normalize(arm, observed, evidence, [], "factual")
