"""Evaluate pre-registered release rules against paired, case-level scores."""
from __future__ import annotations

from collections import defaultdict
from fractions import Fraction
from math import fsum, sqrt

from .common import GateError


SCOPED_RULES = {
    "minimum_counts": "total",
    "minimum_passes": "passed",
    "minimum_pass_rate": "pass_rate",
    "minimum_wilson_lower": "wilson_95",
}
SCOPES = ("overall", "languages", "categories")


def wilson(passed: int, total: int) -> list[float] | None:
    """Two-sided 95% Wilson score interval, undefined for an empty sample."""
    if total == 0:
        return None
    z = 1.959963984540054
    rate = passed / total
    denominator = 1 + z * z / total
    center = (rate + z * z / (2 * total)) / denominator
    margin = z * sqrt(rate * (1 - rate) / total + z * z / (4 * total**2)) / denominator
    lower = 0.0 if passed == 0 else max(0.0, center - margin)
    upper = 1.0 if passed == total else min(1.0, center + margin)
    return [lower, upper]


def _mcnemar_probability(candidate_only: int, baseline_only: int) -> Fraction:
    """Exact two-sided binomial tail on discordant pairs, as a rational number."""
    if abs(candidate_only - baseline_only) <= 1:
        return Fraction(1)
    total = candidate_only + baseline_only
    term = tail = 1
    for k in range(1, min(candidate_only, baseline_only) + 1):
        term = term * (total - k + 1) // k
        tail += term
    return Fraction(2 * tail, 2**total)


def mcnemar_exact(candidate_only: int, baseline_only: int) -> float:
    return float(_mcnemar_probability(candidate_only, baseline_only))


def cohen_kappa(first: list[bool], second: list[bool]) -> float | None:
    """Unweighted Cohen's kappa for binary decisions on the same items."""
    if len(first) != len(second):
        raise GateError("Cohen's kappa requires ratings for the same items.")
    total = len(first)
    first_passes, second_passes = sum(first), sum(second)
    agreement = sum(a == b for a, b in zip(first, second))
    expected = first_passes * second_passes + (total - first_passes) * (total - second_passes)
    denominator = total**2 - expected
    return (agreement * total - expected) / denominator if denominator else None


def _object(value, fields: set[str], location: str) -> None:
    if not isinstance(value, dict):
        raise GateError(f"{location} must be an object.")
    extra = set(value) - fields
    if extra:
        raise GateError(f"{location} has unknown fields: {', '.join(sorted(extra))}.")


def _number(value, low: float, high: float) -> bool:
    return type(value) in (int, float) and low <= value <= high


def _targets(scope_values: dict):
    """Yield each threshold with the scope and optional group it applies to."""
    if "overall" in scope_values:
        yield "overall", None, scope_values["overall"]
    for scope in ("languages", "categories"):
        for group, value in sorted(scope_values.get(scope, {}).items()):
            yield scope, group, value


def _validate_scoped_rule(name: str, targets: dict) -> None:
    location = f"rule.{name}"
    _object(targets, set(SCOPES), location)
    if not targets:
        raise GateError(f"{location} needs at least one threshold.")
    for scope in ("languages", "categories"):
        if scope in targets:
            groups = targets[scope]
            if not isinstance(groups, dict) or not groups or any(not group.strip() for group in groups):
                raise GateError(f"{location}.{scope} needs named groups with thresholds.")
    for _, _, value in _targets(targets):
        if name == "minimum_counts":
            valid = type(value) is int and value > 0
        elif name == "minimum_passes":
            valid = type(value) is int and value >= 0
        else:
            valid = _number(value, 0, 1)
        if not valid:
            raise GateError(f"{location} has an invalid threshold.")


def validate_rule(rule: dict, adapter: str, has_baseline: bool) -> None:
    _object(rule, set(SCOPED_RULES) | {"no_zero_pass_categories", "test", "classifier"}, "rule")
    for name in SCOPED_RULES.keys() & rule.keys():
        _validate_scoped_rule(name, rule[name])
    if type(rule.get("no_zero_pass_categories", False)) is not bool:
        raise GateError("rule.no_zero_pass_categories must be a boolean.")

    test = rule.get("test")
    _object(test, {"name", "alpha"}, "rule.test")
    if test.get("name") == "mcnemar_exact":
        alpha = test.get("alpha")
        if not has_baseline or not _number(alpha, 0, 1) or not 0 < alpha < 1:
            raise GateError("Exact McNemar requires a pinned baseline and an alpha between zero and one.")
    elif test != {"name": "none"}:
        raise GateError("rule.test must select none or mcnemar_exact.")

    classifier = {}
    if adapter == "classifier":
        classifier = rule.get("classifier")
        _object(classifier, {"ece_bins", "max_ece", "max_wrong_confidence", "router"}, "rule.classifier")
        bins = classifier.get("ece_bins")
        if type(bins) is not int or bins < 1:
            raise GateError("rule.classifier.ece_bins must be a positive integer.")
        if type(classifier.get("router", False)) is not bool:
            raise GateError("rule.classifier.router must be a boolean.")
        for field in ("max_ece", "max_wrong_confidence"):
            if field in classifier and not _number(classifier[field], 0, 1):
                raise GateError(f"rule.classifier.{field} must be between zero and one.")
    elif "classifier" in rule:
        raise GateError("rule.classifier is available only for the classifier adapter.")

    performance_threshold = any(
        value > 0
        for name in ("minimum_passes", "minimum_pass_rate", "minimum_wilson_lower")
        for _, _, value in _targets(rule.get(name, {}))
    )
    if not (performance_threshold or rule.get("no_zero_pass_categories") or test["name"] == "mcnemar_exact"
            or classifier.get("router") or classifier.get("max_ece", 1) < 1
            or "max_wrong_confidence" in classifier):
        raise GateError("The rule needs at least one decision criterion beyond minimum sample counts.")


def _count(values: list[bool]) -> dict:
    passed, total = sum(values), len(values)
    return {
        "passed": passed,
        "total": total,
        "pass_rate": passed / total if total else None,
        "wilson_95": wilson(passed, total),
    }


def _counts(cases: list[dict], passed: dict[str, bool]) -> dict:
    languages = defaultdict(list)
    categories = defaultdict(list)
    for case in cases:
        value = passed[case["id"]]
        languages[case["language"]].append(value)
        categories[case["category"]].append(value)
    return {
        "overall": _count(list(passed.values())),
        "languages": {key: _count(values) for key, values in sorted(languages.items())},
        "categories": {key: _count(values) for key, values in sorted(categories.items())},
    }


def _check(rule: str, status: str, message: str, **details) -> dict:
    return {"rule": rule, "status": status, "message": message, **details}


def _scoped_checks(rule: dict, counts: dict) -> list[dict]:
    checks = []
    for name, field in SCOPED_RULES.items():
        for scope, group, target in _targets(rule.get(name, {})):
            measured = counts[scope] if group is None else counts[scope].get(group)
            rule_id = f"{name}.{scope}" if group is None else f"{name}.{scope}.{group}"
            actual = measured[field] if measured else None
            if field == "wilson_95" and actual is not None:
                actual = actual[0]
            if name == "minimum_counts":
                actual = actual or 0
            if actual is None or actual < target:
                insufficient = name == "minimum_counts" or not measured or not measured["total"]
                status = "inconclusive" if insufficient else "stop"
            else:
                status = "pass"
            details = {"scope": scope, "group": group, "actual": actual, "minimum": target}
            checks.append(_check(rule_id, status, f"{rule_id}: measured {actual}; minimum {target}.", **details))
    return checks


def _paired_result(passed: dict[str, bool], baseline: dict[str, bool]) -> tuple[dict, Fraction]:
    candidate_only = sum(value and not baseline[key] for key, value in passed.items())
    baseline_only = sum(baseline[key] and not value for key, value in passed.items())
    probability = _mcnemar_probability(candidate_only, baseline_only)
    return {
        "pairs": len(passed),
        "candidate_only": candidate_only,
        "baseline_only": baseline_only,
        "p_value": float(probability),
    }, probability


def _calibration(passed: dict[str, bool], observations: dict, bins: int) -> tuple[float | None, list[dict]]:
    buckets = defaultdict(list)
    for key, value in passed.items():
        confidence = observations[key]["confidence"]
        numerator, denominator = confidence.as_integer_ratio()
        index = numerator * bins // denominator
        # Decimal bin boundaries such as 0.3 round to binary floats.
        if index + 1 < bins and confidence == (index + 1) / bins:
            index += 1
        buckets[min(bins - 1, index)].append((confidence, value))
    total = len(passed)
    calibration_bins = []
    errors = []
    for index, bucket in sorted(buckets.items()):
        count = len(bucket)
        confidence_sum = fsum(confidence for confidence, _ in bucket)
        correct = sum(value for _, value in bucket)
        errors.append(abs(confidence_sum - correct))
        calibration_bins.append({
            "index": index, "count": count, "mean_confidence": confidence_sum / count,
            "accuracy": correct / count,
        })
    return (fsum(errors) / total if total else None), calibration_bins


def _classifier_result(config: dict, passed: dict[str, bool], observations: dict) -> tuple[dict, list[dict]]:
    ece, calibration_bins = _calibration(passed, observations, config["ece_bins"])
    metrics = {
        "accuracy": sum(passed.values()) / len(passed) if passed else None,
        "expected_calibration_error": ece,
        "ece_bins": config["ece_bins"],
        "calibration_bins": calibration_bins,
    }
    checks = []
    if "max_ece" in config:
        target = config["max_ece"]
        status = "inconclusive" if ece is None else "pass" if ece <= target else "stop"
        checks.append(_check("classifier.max_ece", status,
                             f"Expected calibration error {ece}; maximum {target}.", actual=ece, maximum=target))
    if config.get("router"):
        violations = sorted(key for key, observation in observations.items() if observation["never_web_violation"])
        metrics["never_web_violations"] = len(violations)
        checks.append(_check("classifier.router", "stop" if violations else "pass",
                             f"Never-web cases sent to web_search: {len(violations)}.", case_ids=violations))
    if "max_wrong_confidence" in config:
        cutoff = config["max_wrong_confidence"]
        violations = sorted(key for key, value in passed.items() if not value and observations[key]["confidence"] >= cutoff)
        checks.append(_check("classifier.max_wrong_confidence", "stop" if violations else "pass",
                             f"Incorrect predictions with confidence at least {cutoff}: {len(violations)}.",
                             threshold=cutoff, case_ids=violations))
    return metrics, checks


def decide(rule: dict, cases: list[dict], passed: dict[str, bool], baseline: dict[str, bool] | None,
           observations: dict | None) -> dict:
    """Apply registered criteria, preserving safety failures even with insufficient counts."""
    case_ids = {case["id"] for case in cases}
    if len(case_ids) != len(cases) or set(passed) != case_ids or (baseline is not None and set(baseline) != case_ids):
        raise GateError("Decision scores must cover every case exactly once in each arm.")
    if "classifier" in rule and (observations is None or set(observations) != case_ids):
        raise GateError("Classifier observations must cover every case.")
    counts = _counts(cases, passed)
    checks = _scoped_checks(rule, counts)
    if not cases:
        checks.append(_check("coverage", "inconclusive", "The frozen set has no cases."))
    if rule.get("no_zero_pass_categories"):
        zeros = [group for group, values in counts["categories"].items() if values["passed"] == 0]
        checks.append(_check("no_zero_pass_categories", "stop" if zeros else "pass",
                             f"Categories with zero passes: {len(zeros)}.", categories=zeros))

    paired = None
    if baseline is not None:
        paired, probability = _paired_result(passed, baseline)
        if rule["test"]["name"] == "mcnemar_exact":
            alpha = rule["test"]["alpha"]
            better = paired["candidate_only"] > paired["baseline_only"]
            significant = probability < alpha and better
            checks.append(_check("test.mcnemar_exact", "pass" if significant else "stop",
                                 f"Exact McNemar p={paired['p_value']}; requires p < {alpha} and candidate superiority.",
                                 alpha=alpha, **paired))

    metrics = None
    if "classifier" in rule:
        metrics, classifier_checks = _classifier_result(rule["classifier"], passed, observations)
        checks.extend(classifier_checks)

    stops = [check for check in checks if check["status"] == "stop"]
    insufficient = [check for check in checks if check["status"] == "inconclusive"]
    hard_stops = [check for check in stops if check["rule"] in {"classifier.router", "classifier.max_wrong_confidence"}]
    if hard_stops:
        decision, reasons = "stop", hard_stops + insufficient
    elif insufficient:
        decision, reasons = "inconclusive", insufficient
    elif stops:
        decision, reasons = "stop", stops
    else:
        decision, reasons = "pass", checks
    return {
        "decision": decision, "reasons": reasons, "checks": checks, "counts": counts,
        "mcnemar": paired, "metrics": metrics,
    }
