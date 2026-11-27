"""Check scorecard statistics and decisions with synthetic paired receipts."""

from datetime import datetime, timezone
from hashlib import sha256
from itertools import product
import json
from pathlib import Path
from statistics import NormalDist

import pytest

from scripts.scorecard.stats import (
    CaseResult,
    PrivateComparison,
    compare_quality,
    decide,
    load_preregistration,
    mcnemar_exact,
    wilson,
)


@pytest.mark.parametrize("total", (1, 7, 17))
def test_wilson_matches_brute_force_inversion_of_score_test(total):
    divisions = 8_192
    grid = [index / divisions for index in range(divisions + 1)]
    critical = NormalDist().inv_cdf((1 + 0.95) / 2) ** 2
    for correct in range(total + 1):
        accepted = [
            p for p in grid
            if (correct - total * p) ** 2 <= critical * total * p * (1 - p)
        ]
        assert wilson(correct, total) == pytest.approx([min(accepted), max(accepted)], abs=1 / divisions)
    assert wilson(0, 0) is None


def test_mcnemar_matches_enumeration_of_discordant_pair_label_flips():
    for discordant in range(11):
        outcomes = [sum(bits) for bits in product((0, 1), repeat=discordant)]
        for improved in range(discordant + 1):
            regressed = discordant - improved
            at_least_as_extreme = [
                wins for wins in outcomes if abs(2 * wins - discordant) >= abs(improved - regressed)
            ]
            assert mcnemar_exact(improved, regressed) == len(at_least_as_extreme) / len(outcomes)


def test_quality_pairs_by_suite_and_id_and_reports_public_regressions_only():
    baseline = [
        CaseResult("v1", "same", "factual", "ar", True),
        CaseResult("v2", "same", "factual", "ar", False),
        CaseResult("v2", "another", "calculation", "en", True),
    ]
    candidate = [
        CaseResult("v2", "another", "calculation", "en", False),
        CaseResult("v2", "same", "factual", "ar", True),
        CaseResult("v1", "same", "factual", "ar", False),
    ]
    quality = compare_quality(
        baseline, candidate, private=[PrivateComparison("factual", "ar", 4, 2, 2, 1)],
    )
    assert quality["regression_ids"] == ["same", "another"]
    assert quality["private_regressions"] == 1
    assert quality["overall"] == {
        "family": None,
        "language": None,
        "total": len(baseline) + 4,
        "correct": 3,
        "interval95": wilson(3, len(baseline) + 4),
        "baseline_correct": 3,
        "gain": 0,
        "mcnemar_p": 1,
        "improved": 3,
        "regressed": 3,
        "regression_ids": ["same", "another"],
        "private_regressions": 1,
    }
    groups = {(row["family"], row["language"]): row for row in quality["groups"]}
    assert groups["factual", "ar"]["regression_ids"] == ["same"]
    assert groups["factual", "ar"]["regressed"] == 2
    assert groups[None, "ar"]["total"] == 6
    assert groups[None, "en"]["correct"] == 0
    assert groups[None, "en"]["total"] == 1


def test_comparison_rejects_missing_duplicate_or_relabelled_cases():
    case = CaseResult("v1", "id", "factual", "ar", True)
    with pytest.raises(ValueError, match="same public cases"):
        compare_quality([case], [])
    with pytest.raises(ValueError, match="Duplicate case"):
        compare_quality([case, case], [case])
    with pytest.raises(ValueError, match="same public case metadata"):
        compare_quality([case], [CaseResult("v1", "id", "factual", "en", True)])


@pytest.mark.parametrize("row", [
    PrivateComparison("factual", "ar", 1, 0, 1, 0),
    PrivateComparison("factual", "ar", 1, 1, 0, 1),
    PrivateComparison("factual", "ar", 0, 0, 0, 0),
])
def test_invalid_private_counts_cannot_enter_aggregate(row):
    with pytest.raises(ValueError, match="Invalid private"):
        compare_quality([], [], private=[row])


def synthetic_thresholds():
    return {
        "schema_version": 1,
        "minimum_quality_gain": 0.2,
        "maximum_mcnemar_p": 0.05,
        "maximum_regressions": {"factual": {"ar": 0, "en": 0}},
        "maximum_p95_increase_ms": {"first_progress_ms": 5, "final_answer_ms": 10},
        "maximum_cost": {
            "cpu_ms_per_turn": 10,
            "peak_rss_bytes": 100,
            "model_files_bytes": 200,
            "resident_worker_bytes": 300,
            "training_gpu_hours": 400,
        },
    }


def register(tmp_path, thresholds=None):
    path = tmp_path / "owner.json"
    path.write_text(json.dumps(thresholds if thresholds is not None else synthetic_thresholds()), encoding="utf-8")
    return load_preregistration(path, decisive=True)


def test_registration_stamps_exact_bytes_and_refuses_a_decisive_run_without_them(tmp_path):
    assert load_preregistration(None, decisive=False) is None
    with pytest.raises(ValueError, match="requires an owner pre-registration"):
        load_preregistration(None, decisive=True)

    path = tmp_path / "owner.json"
    raw = (json.dumps(synthetic_thresholds(), indent=2) + "\n").encode()
    path.write_bytes(raw)
    before = datetime.now(timezone.utc)
    registration = load_preregistration(path, decisive=True)
    stamp_time = datetime.fromisoformat(registration.stamp["stamped_at"].replace("Z", "+00:00"))
    assert before <= stamp_time <= datetime.now(timezone.utc)
    assert registration.stamp["sha256"] == sha256(raw).hexdigest()
    path.write_bytes(raw + b"\n")
    assert load_preregistration(path, decisive=True).stamp["sha256"] != registration.stamp["sha256"]


def test_blank_registration_example_cannot_start_decisive_measurements():
    example = Path(__file__).with_name("preregistration.example.json")
    with pytest.raises(ValueError, match="minimum_quality_gain"):
        load_preregistration(example, decisive=True)


@pytest.mark.parametrize(("invalid_key", "value"), [
    ("schema_version", True),
    ("minimum_quality_gain", None),
    ("maximum_mcnemar_p", 1),
    ("maximum_regressions", {"factual": {"ar": True}}),
    ("maximum_p95_increase_ms", {"final_answer_ms": 10}),
    ("maximum_cost", {"peak_rss_bytes": 0}),
])
def test_registration_rejects_missing_or_invalid_owner_limits(tmp_path, invalid_key, value):
    thresholds = synthetic_thresholds()
    thresholds[invalid_key] = value
    with pytest.raises(ValueError):
        register(tmp_path, thresholds)


def quality_for_decision(*, wins=12, regress=False):
    candidate = [CaseResult("v2", str(index), "factual", "ar", index < wins) for index in range(12)]
    baseline = [CaseResult(row.suite_id, row.case_id, row.family, row.language, False) for row in candidate]
    baseline.append(CaseResult("v2", "en", "factual", "en", True))
    candidate.append(CaseResult("v2", "en", "factual", "en", not regress))
    return compare_quality(baseline, candidate)


@pytest.fixture
def decision_inputs(tmp_path):
    return {
        "preregistration": register(tmp_path),
        "quality": quality_for_decision(),
        "baseline_speed": {"first_progress_ms": 10, "final_answer_ms": 20},
        "candidate_speed": {"first_progress_ms": 15, "final_answer_ms": 30},
        "costs": {
            "cpu_ms_per_turn": 10,
            "peak_rss_bytes": 100,
            "model_files_bytes": 200,
            "resident_worker_bytes": 300,
            "training_gpu_hours": 400,
        },
        "model": True,
    }


def test_keep_on_pass_reference_and_shadow_without_decisive_registration(decision_inputs):
    decision = decide(**decision_inputs)
    assert decision["outcome"] == "keep"
    assert decision["own_model_justified"] is True
    assert "monetary" not in decision
    assert {check["status"] for check in decision["checks"]} == {"pass"}
    assert decide(**decision_inputs, baseline=True)["outcome"] == "keep"
    assert decide(**decision_inputs, decisive=False)["own_model_justified"] is None
    assert decide(**(decision_inputs | {"preregistration": None}))["outcome"] == "keep in shadow"


@pytest.mark.parametrize(("name", "threshold_key", "path", "value"), [
    ("minimum_quality_gain", "minimum_quality_gain", (), 1),
    ("maximum_mcnemar_p", "maximum_mcnemar_p", (), 0.00001),
    ("maximum_p95_increase_ms.first_progress_ms", "maximum_p95_increase_ms", ("first_progress_ms",), 4),
    ("maximum_p95_increase_ms.final_answer_ms", "maximum_p95_increase_ms", ("final_answer_ms",), 9),
    ("maximum_cost.cpu_ms_per_turn", "maximum_cost", ("cpu_ms_per_turn",), 9),
    ("maximum_cost.peak_rss_bytes", "maximum_cost", ("peak_rss_bytes",), 99),
    ("maximum_cost.model_files_bytes", "maximum_cost", ("model_files_bytes",), 199),
    ("maximum_cost.resident_worker_bytes", "maximum_cost", ("resident_worker_bytes",), 299),
    ("maximum_cost.training_gpu_hours", "maximum_cost", ("training_gpu_hours",), 399),
])
def test_drop_on_each_failed_threshold(tmp_path, decision_inputs, name, threshold_key, path, value):
    thresholds = synthetic_thresholds()
    if path:
        thresholds[threshold_key][path[0]] = value
    else:
        thresholds[threshold_key] = value
    decision_inputs["preregistration"] = register(tmp_path, thresholds)
    result = decide(**decision_inputs)
    assert result["outcome"] == "drop"
    assert result["own_model_justified"] is False
    assert [check["name"] for check in result["checks"] if check["status"] == "fail"] == [name]


def test_regression_threshold_checks_each_family_and_language(decision_inputs):
    decision_inputs["quality"] = quality_for_decision(regress=True)
    result = decide(**decision_inputs)
    assert result["outcome"] == "drop"
    assert [check for check in result["checks"] if check["status"] == "fail"] == [{
        "name": "maximum_regressions.factual.en",
        "status": "fail",
        "value": 1,
        "limit": 0,
        "total": 1,
    }]


def test_missing_threshold_or_required_measurements_stays_in_shadow(tmp_path, decision_inputs):
    thresholds = synthetic_thresholds()
    del thresholds["maximum_regressions"]["factual"]["en"]
    decision_inputs["preregistration"] = register(tmp_path, thresholds)
    del decision_inputs["baseline_speed"]["first_progress_ms"]
    del decision_inputs["costs"]["training_gpu_hours"]
    result = decide(**decision_inputs)
    assert result["outcome"] == "keep in shadow"
    assert result["own_model_justified"] is None
    assert {check["name"]: check["reason"] for check in result["checks"] if check["status"] == "missing"} == {
        "maximum_regressions.factual.en": "threshold_missing",
        "maximum_p95_increase_ms.first_progress_ms": "baseline_not_measured",
        "maximum_cost.training_gpu_hours": "not_measured",
    }


def test_no_model_arm_uses_shared_runtime_costs(decision_inputs):
    decision_inputs["model"] = False
    decision_inputs["costs"] = {"cpu_ms_per_turn": 1, "peak_rss_bytes": 1}
    result = decide(**decision_inputs)
    assert result["outcome"] == "keep"
    assert "own_model_justified" not in result


def test_money_requires_owner_price_and_uses_measured_costs(tmp_path, decision_inputs):
    thresholds = synthetic_thresholds()
    thresholds["maximum_cost"]["training_money"] = 1
    with pytest.raises(ValueError, match="matching hourly price"):
        register(tmp_path, thresholds)
    thresholds["prices"] = {"currency": "SAR", "cpu_hour": 2, "gpu_hour": 3}
    decision_inputs["preregistration"] = register(tmp_path, thresholds)
    result = decide(**decision_inputs)
    assert result["monetary"] == {
        "currency": "SAR",
        "money_per_turn": decision_inputs["costs"]["cpu_ms_per_turn"] / (60 * 60 * 1_000) * 2,
        "training_money": decision_inputs["costs"]["training_gpu_hours"] * 3,
    }
    assert result["outcome"] == "drop"
    assert [check["name"] for check in result["checks"] if check["status"] == "fail"] == [
        "maximum_cost.training_money",
    ]
