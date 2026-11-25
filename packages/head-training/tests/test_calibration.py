import math

import pytest
import torch

from head_training.calibration import decide, fit_calibration


def test_temperature_reduces_ece_on_overconfident_classifier():
    logits = torch.tensor([[9.0, 0.0]] * 10 + [[0.0, 9.0]] * 10)
    targets = torch.tensor([0] * 8 + [1] * 2 + [1] * 8 + [0] * 2)
    fitted = fit_calibration(logits, targets, min_accuracy=0.75)

    assert fitted.temperature == pytest.approx(9 / math.log(4), rel=1e-4)
    assert fitted.ece_before > 0.19
    assert fitted.ece_after < 1e-5
    assert fitted.nll_after < fitted.nll_before
    assert fitted.coverage == 1
    assert fitted.accuracy == 0.8
    assert fitted.as_worker_record() == {
        "temperature": fitted.temperature,
        "minConfidence": fitted.min_confidence,
        "minMargin": fitted.min_margin,
    }


def test_abstention_maximizes_coverage_at_target_and_excludes_ties():
    logits = [[12, 0], [0, 9, 1], [2, 3], [0, 0]]
    fitted = fit_calibration(logits, [0, (1, 2), 0, 0], min_accuracy=1)

    assert fitted.accepted == 2
    assert fitted.count == 4
    assert fitted.coverage == 0.5
    assert fitted.accuracy == 1
    assert fitted == fit_calibration(logits, [0, (1, 2), 0, 0], min_accuracy=1)


def test_no_safe_coverage_keeps_thresholds_unset():
    fitted = fit_calibration([[4, 0], [1, 1]], [1, 0], min_accuracy=1)
    assert fitted.accepted == 0
    assert fitted.accuracy is None
    assert fitted.as_worker_record() is None
    assert fit_calibration([[4, 0], [1, 1]], [1, 0], min_accuracy=0).accepted == 1


def test_decide_uses_provider_thresholds_inclusively_and_abstains_on_ties():
    calibration = {"temperature": 2.0, "minConfidence": 0.8, "minMargin": 0.6}
    logits = [1000.0, 1000.0 + 2 * math.log(4)]
    result = decide(logits, {"temperature": 2.0, "minConfidence": 0.0, "minMargin": 0.0})
    assert result.index == 1
    assert result.confidence == pytest.approx(0.8)
    assert decide(logits, {**calibration, "minMargin": 0.61}).index is None
    # Probability 1 and margin 1 are reached by underflow of the runner-up weight.
    assert decide([1e4, -1e4], {**calibration, "minConfidence": 1.0, "minMargin": 1.0}).index == 0
    tied = decide([3.0, 3.0], {**calibration, "minConfidence": 0.0, "minMargin": 0.0})
    assert tied.index is None and tied.confidence == 0.5


def test_decide_abstains_for_one_candidate_or_unavailable_calibration_and_rejects_nonfinite():
    calibration = {"temperature": 1.0, "minConfidence": 0.1, "minMargin": 0.1}
    for result in (decide([1.0], calibration), decide([1.0, 0.0], None)):
        assert result.index is None and result.confidence == 0.0
    with pytest.raises(ValueError, match="finite"):
        decide([1.0, float("-inf")], calibration)
    with pytest.raises(ValueError, match="temperature"):
        decide([1.0, 0.0], {**calibration, "temperature": 0.0})


@pytest.mark.parametrize(
    ("logits", "targets"),
    [([], []), ([[0, 1]], [2]), ([[0]], [0]), ([[float("nan"), 0]], [0]), ([[0, 1]], [True])],
)
def test_calibration_rejects_invalid_rows(logits, targets):
    with pytest.raises(ValueError):
        fit_calibration(logits, targets, min_accuracy=0.8)
