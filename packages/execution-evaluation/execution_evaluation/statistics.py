"""Paired, contamination-aware comparisons with conservative cluster intervals."""

from __future__ import annotations

from collections import Counter
from math import isfinite, log, sqrt
from typing import Any, Mapping, Sequence

from .common import digest

Result = Mapping[str, Any]
_PAIR_FIELDS = ("task_family", "project_family", "template_family", "tier", "mode")
_PIN_FIELDS = ("task_digest", "conditions_digest", "dataset_manifest_digest", "verification_fixture_digest")


def _index(results: Sequence[Result]) -> dict[tuple[str, str], Result]:
    indexed: dict[tuple[str, str], Result] = {}
    arms = {row.get("arm_id") for row in results}
    modes = {row.get("mode") for row in results}
    if len(arms) > 1 or len(modes) > 1:
        raise ValueError("Each comparison arm must contain one arm_id and one mode")
    for row in results:
        key = (row.get("dataset_version"), row.get("task_id"))
        if any(not isinstance(value, str) or not value for value in key):
            raise ValueError("Every result needs immutable dataset_version and task_id")
        if key in indexed:
            raise ValueError(f"Duplicate paired observation: {key}")
        indexed[key] = row
    return indexed


def _clusters(rows: Sequence[tuple[Result, bool, bool]]) -> list[list[int]]:
    """Connect tasks sharing either project or template; do not count them as independent."""
    parents = list(range(len(rows)))

    def root(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    seen: dict[tuple[str, str], int] = {}
    for index, (row, _, _) in enumerate(rows):
        for field in ("project_family", "template_family"):
            key = (field, str(row[field]))
            if key in seen:
                parents[root(index)] = root(seen[key])
            else:
                seen[key] = index
    groups: dict[int, list[int]] = {}
    for index in range(len(rows)):
        groups.setdefault(root(index), []).append(index)
    return list(groups.values())


def paired_comparison(
    baseline: Sequence[Result], candidate: Sequence[Result], *,
    metric: str = "success_within_budget", independent_clusters: bool = False,
    contaminated: bool = False, min_clusters: int = 30, confidence: float = 0.95,
) -> dict[str, Any]:
    """Compare binary observations on identical task/condition pins.

    The CI uses a weighted Hoeffding bound for independent cluster means in
    [-1, 1]. Clusters connect shared project OR template families, accounting for
    those dependencies. Independence between remaining clusters must come from
    the evaluation sampling design, never from this function. The interval is
    intentionally wide on small or heavily dependent suites. No normality,
    pretrained statistics package, random seeds, or benchmark execution is used.
    """
    if type(independent_clusters) is not bool or type(contaminated) is not bool:
        raise ValueError("Sampling and contamination flags must be booleans")
    if type(min_clusters) is not int or min_clusters < 2:
        raise ValueError("min_clusters must be an integer of at least two")
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not isfinite(confidence) or not 0 < confidence < 1:
        raise ValueError("confidence must be strictly between zero and one")
    left, right = _index(baseline), _index(candidate)
    shared = sorted(left.keys() & right.keys())
    unmatched = sorted(left.keys() ^ right.keys())
    incompatible: list[dict[str, Any]] = []
    missing: list[str] = []
    pairs: list[tuple[Result, bool, bool]] = []
    for key in shared:
        before, after = left[key], right[key]
        differences = [field for field in _PAIR_FIELDS if not before.get(field) or before.get(field) != after.get(field)]
        for field in _PIN_FIELDS:
            first, second = before.get("provenance", {}).get(field), after.get("provenance", {}).get(field)
            if not first or first != second:
                differences.append(f"provenance.{field}")
        if differences:
            incompatible.append({"task_id": key[1], "fields": differences})
            continue
        a, b = before.get(metric), after.get(metric)
        if a is None or b is None:
            missing.append(key[1])
            continue
        if type(a) is not bool or type(b) is not bool:
            raise ValueError(f"{metric} must contain only booleans or null")
        pairs.append((after, a, b))
    n = len(pairs)
    baseline_rate = sum(a for _, a, _ in pairs) / n if n else None
    candidate_rate = sum(b for _, _, b in pairs) / n if n else None
    delta = candidate_rate - baseline_rate if n else None
    groups = _clusters(pairs)
    weights = [len(group) / n for group in groups] if n else []
    effective_clusters = 1 / sum(weight * weight for weight in weights) if weights else None
    limitations: list[str] = []
    if contaminated:
        limitations.append("contamination_reported")
    if not independent_clusters:
        limitations.append("independent_cluster_sampling_not_attested")
    if len(groups) < min_clusters or (effective_clusters is not None and effective_clusters < min_clusters):
        limitations.append("insufficient_independent_clusters")
    if unmatched or incompatible or missing:
        limitations.append("incomplete_or_incompatible_pairing")
    if not n:
        limitations.append("no_complete_pairs")
    interval = None
    if not limitations and delta is not None:
        radius = sqrt(2 * log(2 / (1 - confidence)) * sum(weight * weight for weight in weights))
        interval = {"lower": max(-1.0, delta - radius), "upper": min(1.0, delta + radius),
                    "confidence": confidence, "method": "weighted_independent_cluster_hoeffding",
                    "estimand": "task_weighted_expected_paired_binary_difference"}
    if len(groups) < 30 or (effective_clusters is not None and effective_clusters < 30):
        limitations.append("small_sample_exploratory_only")
    result = {"schema_version": "execution-evaluation.comparison.v1", "metric": metric,
              "baseline_arm_id": baseline[0].get("arm_id") if baseline else None,
              "candidate_arm_id": candidate[0].get("arm_id") if candidate else None,
              "mode": candidate[0].get("mode") if candidate else None,
              "baseline_results_digest": digest(list(baseline)), "candidate_results_digest": digest(list(candidate)),
              "baseline_count": len(baseline), "candidate_count": len(candidate),
              "shared_tasks": len(shared), "complete_pairs": n,
              "unmatched_task_ids": [key[1] for key in unmatched],
              "incompatible_pairs": incompatible, "missing_measurement_task_ids": missing,
              "baseline_rate": baseline_rate, "candidate_rate": candidate_rate,
              "absolute_difference": delta,
              "relative_difference": delta / baseline_rate if delta is not None and baseline_rate else None,
              "relative_difference_reason": "baseline_zero_or_unmeasured" if not baseline_rate else None,
              "candidate_wins": sum(not a and b for _, a, b in pairs),
              "baseline_wins": sum(a and not b for _, a, b in pairs),
              "ties": sum(a == b for _, a, b in pairs),
              "independent_clusters_attested": independent_clusters,
              "cluster_count": len(groups), "effective_cluster_count": effective_clusters,
              "minimum_clusters": min_clusters, "contaminated": contaminated,
              "confidence_interval": interval, "limitations": limitations,
              "superiority_established": bool(interval and interval["lower"] > 0 and not limitations),
              "sampling_note": "Intervals require independent sampled clusters; a convenience suite only supports descriptive differences."}
    result["comparison_digest"] = digest(result)
    return result


def comparison_breakdown(baseline: Sequence[Result], candidate: Sequence[Result], **options: Any) -> dict[str, Any]:
    """Family intervals are exploratory; callers must adjust confidence for gate multiplicity."""
    families = sorted({str(row["task_family"]) for row in (*baseline, *candidate)})
    return {"overall": paired_comparison(baseline, candidate, **options),
            "by_task_family": {family: paired_comparison(
                [row for row in baseline if row["task_family"] == family],
                [row for row in candidate if row["task_family"] == family], **options) for family in families},
            "failure_categories": {
                "baseline": dict(Counter(str(row.get("outcome", "unknown")) for row in baseline if row.get("success_within_budget") is not True)),
                "candidate": dict(Counter(str(row.get("outcome", "unknown")) for row in candidate if row.get("success_within_budget") is not True))},
            "multiplicity_note": "Unadjusted family intervals are descriptive; acceptance applies a Bonferroni confidence requirement."}


def compare_variants(reference: Sequence[Result], variants: Sequence[Mapping[str, Any]], **options: Any) -> list[dict[str, Any]]:
    """Compare model-size/training-dataset-budget variants on the same evaluation set.

    A variant supplies identity, parameter_count, training_examples,
    training_tokens, training_cost_usd and results. Unknown values stay null.
    Size/budget association is descriptive, not causal attribution.
    """
    output = []
    identities: set[str] = set()
    for variant in variants:
        identity = variant.get("identity")
        if not isinstance(identity, str) or not identity or identity in identities:
            raise ValueError("Variant identities must be unique nonempty strings")
        identities.add(identity)
        metadata = {key: variant.get(key) for key in ("parameter_count", "training_examples", "training_tokens", "training_cost_usd")}
        for name, value in metadata.items():
            if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value) or value < 0):
                raise ValueError(f"Invalid variant measurement {name}")
        output.append({"identity": identity, **metadata,
                       "comparison": paired_comparison(reference, variant["results"], **options),
                       "limitations": ["Model size and training budget do not isolate causality when other conditions differ."]})
    return output
