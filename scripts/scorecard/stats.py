"""Paired quality summaries and owner-registered value decisions."""

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from math import isfinite
from operator import ge, le
from pathlib import Path
import re

from ..gates.common import GateError, fields, nonempty, now, parse_json, require_file, sha256
from ..gates.decision import mcnemar_exact, wilson


SPEED_METRICS = ("first_progress_ms", "final_answer_ms")
RUN_COST_METRICS = ("cpu_ms_per_turn", "peak_rss_bytes")
MODEL_COST_METRICS = ("model_files_bytes", "resident_worker_bytes", "training_gpu_hours")
MONEY_METRICS = {"money_per_turn": "cpu_hour", "training_money": "gpu_hour"}


@dataclass(frozen=True)
class CaseResult:
    suite_id: str
    case_id: str
    family: str
    language: str
    correct: bool


@dataclass(frozen=True)
class PrivateComparison:
    family: str
    language: str
    total: int
    correct: int
    improved: int
    regressed: int


@dataclass(frozen=True)
class Preregistration:
    thresholds: dict
    sha256: str
    stamped_at: str

    @property
    def stamp(self) -> dict:
        return {
            "schema_version": self.thresholds["schema_version"],
            "sha256": self.sha256,
            "stamped_at": self.stamped_at,
        }


def _case_index(cases: Sequence[CaseResult]) -> dict[tuple[str, str], CaseResult]:
    index = {}
    for case in cases:
        key = (case.suite_id, case.case_id)
        if not all(map(nonempty, (*key, case.family, case.language))) or type(case.correct) is not bool:
            raise ValueError("Invalid public case metadata or verdict.")
        if key in index:
            raise ValueError("Duplicate case within a public suite.")
        index[key] = case
    return index


def _quality_row(pairs, private) -> dict:
    total = len(pairs) + sum(row.total for row in private)
    correct = sum(after.correct for _, after in pairs) + sum(row.correct for row in private)
    improved = sum(after.correct and not before.correct for before, after in pairs)
    improved += sum(row.improved for row in private)
    regression_ids = [before.case_id for before, after in pairs if before.correct and not after.correct]
    private_regressions = sum(row.regressed for row in private)
    regressed = len(regression_ids) + private_regressions
    return {
        "total": total,
        "correct": correct,
        "interval95": wilson(correct, total),
        "baseline_correct": correct - improved + regressed,
        "gain": (improved - regressed) / total if total else None,
        "mcnemar_p": mcnemar_exact(improved, regressed) if total else None,
        "improved": improved,
        "regressed": regressed,
        "regression_ids": regression_ids,
        "private_regressions": private_regressions,
    }


def compare_quality(
    baseline: Sequence[CaseResult],
    candidate: Sequence[CaseResult],
    *,
    private: Sequence[PrivateComparison] = (),
) -> dict:
    """Pair public cases by suite and ID and include paired private sufficient statistics."""
    before, after = _case_index(baseline), _case_index(candidate)
    if before.keys() != after.keys():
        raise ValueError("Paired arms must contain the same public cases.")

    pairs = []
    public_groups = defaultdict(list)
    for key in sorted(before):
        original, changed = before[key], after[key]
        family, language = original.family, original.language
        if (family, language) != (changed.family, changed.language):
            raise ValueError("Paired arms must use the same public case metadata.")
        pair = (original, changed)
        pairs.append(pair)
        public_groups[family, language].append(pair)
        public_groups[None, language].append(pair)

    private_groups = defaultdict(list)
    for row in private:
        key = (row.family, row.language)
        if (
            not all(map(nonempty, key))
            or not all(type(count) is int for count in (row.total, row.correct, row.improved, row.regressed))
            or not 0 <= row.improved <= row.correct <= row.total
            or not 0 <= row.regressed <= row.total - row.correct
            or row.total == 0
        ):
            raise ValueError("Invalid private comparison counts or group.")
        if key in private_groups:
            raise ValueError("Duplicate private family and language aggregate.")
        private_groups[key].append(row)
        private_groups[None, row.language].append(row)

    overall = {"family": None, "language": None, **_quality_row(pairs, private)}
    groups = []
    for family, language in sorted(public_groups.keys() | private_groups.keys(),
                                   key=lambda key: (key[0] or "", key[1])):
        groups.append({
            "family": family,
            "language": language,
            **_quality_row(public_groups[family, language], private_groups[family, language]),
        })
    return {
        "overall": overall,
        "groups": groups,
        "regression_ids": overall["regression_ids"],
        "private_regressions": overall["private_regressions"],
    }


def _finite(value) -> bool:
    try:
        return type(value) in (int, float) and isfinite(value)
    except OverflowError:
        return False


def _validate_thresholds(data) -> None:
    fields(data, {
        "schema_version", "minimum_quality_gain", "maximum_mcnemar_p",
        "maximum_regressions", "maximum_p95_increase_ms", "maximum_cost",
    }, "pre-registration", {"prices"})
    if type(data["schema_version"]) is not int or data["schema_version"] != 1:
        raise GateError("Unsupported pre-registration schema version.")
    gain = data["minimum_quality_gain"]
    if not _finite(gain) or not 0 <= gain <= 1:
        raise GateError("minimum_quality_gain must be a fraction from zero to one.")
    alpha = data["maximum_mcnemar_p"]
    if not _finite(alpha) or not 0 < alpha < 1:
        raise GateError("maximum_mcnemar_p must be between zero and one.")

    regressions = data["maximum_regressions"]
    if not isinstance(regressions, dict) or not regressions:
        raise GateError("maximum_regressions needs limits per family and language.")
    for family, languages in regressions.items():
        if not nonempty(family) or not isinstance(languages, dict) or not languages:
            raise GateError("maximum_regressions needs limits per family and language.")
        for language, limit in languages.items():
            if not nonempty(language) or type(limit) is not int or limit < 0:
                raise GateError("Regression limits must be nonnegative case counts.")

    speed = data["maximum_p95_increase_ms"]
    fields(speed, set(SPEED_METRICS), "maximum_p95_increase_ms")
    if not all(map(_finite, speed.values())):
        raise GateError("p95 limits must be finite increases in milliseconds.")

    costs = data["maximum_cost"]
    fields(costs, set(RUN_COST_METRICS + MODEL_COST_METRICS), "maximum_cost", set(MONEY_METRICS))
    if not all(_finite(limit) and limit >= 0 for limit in costs.values()):
        raise GateError("Cost limits must be finite nonnegative numbers.")

    prices = data.get("prices", {})
    if "prices" in data:
        fields(prices, {"currency"}, "prices", set(MONEY_METRICS.values()))
        currency = prices["currency"]
        rates = {key: value for key, value in prices.items() if key != "currency"}
        if (
            not isinstance(currency, str) or re.fullmatch(r"[A-Z]{3}", currency) is None
            or not rates or not all(_finite(rate) and rate >= 0 for rate in rates.values())
        ):
            raise GateError("Prices need a three-letter currency code and nonnegative hourly rates.")
    for metric in costs.keys() & MONEY_METRICS.keys():
        if MONEY_METRICS[metric] not in prices:
            raise GateError("A monetary ceiling needs the owner's matching hourly price.")


def load_preregistration(path: Path | None, *, decisive: bool) -> Preregistration | None:
    """Validate the owner's exact bytes and stamp them before any measurement."""
    if path is None:
        if decisive:
            raise GateError("A decisive run requires an owner pre-registration file.")
        return None
    require_file(path)
    raw = path.read_bytes()
    thresholds = parse_json(raw, "pre-registration")
    _validate_thresholds(thresholds)
    return Preregistration(thresholds, sha256(raw), now())


def _check(name, value, limit, compare=le, *, reason=None) -> dict:
    if value is None or limit is None:
        status = "missing"
        if reason is None:
            reason = "threshold_missing" if limit is None else "not_measured"
    else:
        status = "pass" if compare(value, limit) else "fail"
    return {
        "name": name,
        "status": status,
        "value": value,
        "limit": limit,
        **({"reason": reason} if reason is not None else {}),
    }


def _money(prices, costs, *, model: bool) -> dict:
    if not prices:
        return {}
    money = {"currency": prices["currency"]}
    cpu = costs.get("cpu_ms_per_turn")
    if "cpu_hour" in prices:
        value = cpu / (1_000 * 60 * 60) * prices["cpu_hour"] if _finite(cpu) else None
        money["money_per_turn"] = value if _finite(value) else None
    training = costs.get("training_gpu_hours")
    if model and "gpu_hour" in prices:
        value = training * prices["gpu_hour"] if _finite(training) else None
        money["training_money"] = value if _finite(value) else None
    return money


def decide(
    *,
    preregistration: Preregistration | None,
    quality: dict,
    baseline_speed: dict,
    candidate_speed: dict,
    costs: dict,
    model: bool = False,
    baseline: bool = False,
    decisive: bool = True,
) -> dict:
    """Evaluate threshold checks and preserve the reason for each missing measurement."""
    thresholds = preregistration.thresholds if preregistration else {}
    money = _money(thresholds.get("prices"), costs, model=model)
    result = {"monetary": money} if money else {}
    if baseline:
        return {**result, "outcome": "keep", "reason": "reference", "checks": []}
    if preregistration is None or not decisive:
        return {
            **result, "outcome": "keep in shadow", "reason": "exploratory", "checks": [],
            **({"own_model_justified": None} if model else {}),
        }

    overall = quality["overall"]
    checks = [
        _check("minimum_quality_gain", overall["gain"], thresholds["minimum_quality_gain"], ge),
        _check("maximum_mcnemar_p", overall["mcnemar_p"], thresholds["maximum_mcnemar_p"]),
    ]
    for group in quality["groups"]:
        family, language = (group["family"], group["language"])
        if family is not None:
            limit = thresholds["maximum_regressions"].get(family, {}).get(language)
            checks.append({
                **_check(f"maximum_regressions.{family}.{language}", group["regressed"], limit),
                "total": group["total"],
            })

    for metric in SPEED_METRICS:
        before, after = baseline_speed.get(metric), candidate_speed.get(metric)
        delta = after - before if _finite(before) and _finite(after) else None
        reason = "baseline_not_measured" if not _finite(before) else "candidate_not_measured"
        checks.append(_check(f"maximum_p95_increase_ms.{metric}", delta,
                             thresholds["maximum_p95_increase_ms"][metric],
                             reason=reason if delta is None else None))

    cost_metrics = RUN_COST_METRICS + MODEL_COST_METRICS if model else RUN_COST_METRICS
    for metric in cost_metrics:
        checks.append(_check(f"maximum_cost.{metric}", costs.get(metric), thresholds["maximum_cost"][metric]))
    for metric in MONEY_METRICS:
        if metric in thresholds["maximum_cost"] and (model or metric != "training_money"):
            checks.append(_check(f"maximum_cost.{metric}", money.get(metric), thresholds["maximum_cost"][metric]))

    statuses = {check["status"] for check in checks}
    outcome = "drop" if "fail" in statuses else "keep in shadow" if "missing" in statuses else "keep"
    return {
        **result, "outcome": outcome, "checks": checks,
        **({"own_model_justified": None if outcome == "keep in shadow" else outcome == "keep"} if model else {}),
    }
