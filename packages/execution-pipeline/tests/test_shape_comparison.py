"""Verify shape selection and full-precision gate evidence without touching the GPU."""
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline import shape_comparison as shape
from execution_pipeline.ads_finetune import _sha256


@pytest.fixture
def comparison(tmp_path, monkeypatch):
    def write(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")

    for name, relative in (("CAMPAIGN", "campaign"), ("RUN", "run"), ("BASELINE", "baseline.json"),
                           ("FOUNDATION", "foundation.json"), ("HISTORICAL", "historical.json")):
        monkeypatch.setattr(shape, name, tmp_path / relative)
    write(shape.CAMPAIGN / "config.json", {"input_sha256": {}})
    write(shape.RUN / "85m/status.json", {"status": "completed", "processed_tokens": 100_000_000, "minutes": 300})
    checkpoint = shape.RUN / "85m/checkpoints/tokens-000100000000/checkpoint.pt"
    checkpoint.parent.mkdir(parents=True)
    checkpoint.write_bytes(b"test-checkpoint")
    write(checkpoint.parent / "manifest.json", {"checkpoint_sha256": _sha256(checkpoint),
          "fixed_reference_validation_loss": {"ar": 2.8, "en": 3.3}})
    write(shape.BASELINE, {"fixed_reference_validation_loss": {"ar": 3.2, "en": 3.5}})
    write(shape.FOUNDATION, {"status": "completed", "processed_tokens": 300_000_000,
          "last_validation": {"ar": 2.95, "en": 3.2043781161308287}})
    write(shape.HISTORICAL, {"last_validation": {"ar": 3.2635704576969147, "en": 3.204467010498047}})
    return _sha256(shape.CAMPAIGN / "config.json"), write, checkpoint


def test_report_uses_actual_historical_precision_and_is_repeatable(comparison):
    digest, _, _ = comparison
    report = shape.assessment(digest)
    assert report["gate2_passed"] is True
    assert report["selected_shape"] == "85m"
    assert report["historical_english_improvement"] == pytest.approx(0.0000888943672184)
    assert shape.assessment(digest) == report


def test_macro_gain_alone_does_not_select_larger_shape(comparison):
    digest, write, checkpoint = comparison
    write(checkpoint.parent / "manifest.json", {"checkpoint_sha256": _sha256(checkpoint),
          "fixed_reference_validation_loss": {"ar": 2.8, "en": 3.45}})
    report = shape.assessment(digest)
    assert report["at_least_015_macro_reduction"] is True
    assert report["at_least_015_reduction_each_language"] is False
    assert report["selected_shape"] == "38m"


def test_unfinished_training_cannot_publish_a_gate_result(comparison):
    digest, write, _ = comparison
    write(shape.RUN / "85m/status.json", {"status": "paused_time_limit", "processed_tokens": 500_000})
    with pytest.raises(ValueError, match="finish"):
        shape.assessment(digest)
    assert not (shape.CAMPAIGN / "assessment.json").exists()
