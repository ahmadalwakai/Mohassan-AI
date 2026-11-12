"""Regression scope and independent evidence comparison; no test execution."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class RegressionCheckSpec:
    check_id: str
    scope: str
    source_paths: tuple[str, ...]
    required_observation: str
    applicability: str = "required"  # conditional requires trusted inventory evidence
    status: str = "pending_isolated_adapter"
    production_execution_allowed: bool = False


REGRESSION_CATALOGUE: tuple[RegressionCheckSpec, ...] = (
    RegressionCheckSpec("regression.application.v1", "existing_application_behavior", ("tests/assistant-flow.test.ts", "tests/studio-api.test.ts"), "Matched baseline and candidate independent application assertions."),
    RegressionCheckSpec("regression.shared_contracts.v1", "shared_api_contracts", ("packages/contracts/src/index.ts", "tests/api-security.test.ts"), "Shared public contract snapshots remain compatible and unchanged."),
    RegressionCheckSpec("regression.frontend_backend.v1", "frontend_backend_compatibility", ("tests/e2e/workspace.spec.ts", "tests/inference-api.test.ts"), "Recorded/mock frontend requests and backend responses remain mutually compatible."),
    RegressionCheckSpec("regression.customer.v1", "customer_consumer", (), "Concrete customer consumer identified by trusted inventory and its contract fixtures compared.", "conditional"),
    RegressionCheckSpec("regression.driver.v1", "driver_consumer", (), "Concrete driver consumer identified by trusted inventory and its contract fixtures compared.", "conditional"),
    RegressionCheckSpec("regression.admin.v1", "admin_consumer", ("tests/isolation-admin-plan.test.ts",), "Concrete admin consumer identified by trusted inventory; role and contract fixtures compared.", "conditional"),
    RegressionCheckSpec("regression.database.v1", "database_operations", ("tests/postgres-connection-recovery.test.ts", "tests/e2e-isolation.test.ts"), "Ephemeral non-production database transaction, isolation and rollback assertions."),
    RegressionCheckSpec("regression.permissions.v1", "permission_enforcement", ("tests/skills-security.test.ts", "tests/api-security.test.ts", "tests/members-access.test.ts"), "Denied/revoked/foreign-scope requests remain denied with no side effect."),
    RegressionCheckSpec("regression.gateway.v1", "tool_gateway", ("tests/skills-gateway.test.ts", "tests/skills-concurrency.test.ts"), "Schema, authorization, independent result verification and idempotent effects are preserved."),
    RegressionCheckSpec("regression.chat_loop.v1", "existing_chat_loop", ("tests/assistant-flow.test.ts", "tests/assistant-recovery.test.ts", "tests/assistant-verification.test.ts"), "Bounded chat orchestration and evidence-based completion remain compatible."),
    RegressionCheckSpec("regression.runtime.v1", "existing_runtime_execution", ("packages/runtime/src/runtime.test.ts", "packages/runtime/src/planning-runtime.test.ts", "tests/coding-runtime.test.ts"), "Task lifecycle, cancellation, claims, retries and independent completion remain correct."),
    RegressionCheckSpec("regression.google_ads.v1", "google_ads_workflows", ("tests/google-ads.test.ts", "tests/google-ads-paused.test.ts", "tests/fixtures/google-ads-mock.ts"), "Mock/recorded advertising workflow, permission and paused-state assertions; no live account requests."),
)


@dataclass(frozen=True)
class RegressionObservation:
    check_id: str
    baseline_passed: bool | None
    candidate_passed: bool | None
    independent: bool
    receipt_id: str
    environment: str  # isolated_fixture | recorded_mock
    matched_task_and_check_versions: bool
    applicable: bool | None = True
    not_applicable_inventory_receipt: str | None = None


def assess_regressions(
    observations: tuple[RegressionObservation, ...],
    authenticate: Callable[[RegressionObservation], bool] | None = None,
    required_checks: tuple[RegressionCheckSpec, ...] = REGRESSION_CATALOGUE,
) -> dict[str, Any]:
    """A regression requires a passing baseline and failing matched candidate.

    Existing failing baselines are reported as baseline failures, not invented
    candidate regressions. Unknown comparisons remain missing. Authentication
    must verify the isolated environment, check version and independent receipt.
    """
    if len({check.check_id for check in required_checks}) != len(required_checks):
        raise ValueError("Duplicate regression check identities")
    seen: dict[str, RegressionObservation] = {}
    duplicates: set[str] = set()
    for item in observations:
        if item.check_id in seen:
            duplicates.add(item.check_id)
        seen[item.check_id] = item
    checks: list[dict[str, Any]] = []
    regression_count = 0
    comparable_count = 0
    baseline_failures = 0
    missing: list[str] = []
    for spec in required_checks:
        item = seen.get(spec.check_id)
        authenticated = False
        if item is not None and authenticate is not None:
            try:
                authenticated = authenticate(item) is True
            except Exception:
                authenticated = False
        valid = (item is not None and spec.check_id not in duplicates and authenticated
                 and item.independent is True and bool(item.receipt_id)
                 and item.environment in {"isolated_fixture", "recorded_mock"}
                 and item.matched_task_and_check_versions is True)
        status = "unavailable"
        if valid and item is not None:
            if (item.applicable is False and spec.applicability == "conditional"
                    and item.not_applicable_inventory_receipt):
                status = "not_applicable"
            elif item.applicable is True and type(item.baseline_passed) is bool and type(item.candidate_passed) is bool:
                if item.baseline_passed:
                    comparable_count += 1
                    if item.candidate_passed:
                        status = "passed"
                    else:
                        status = "regression_failed"
                        regression_count += 1
                else:
                    status = "baseline_failed"
                    baseline_failures += 1
        if status in {"unavailable", "baseline_failed"}:
            missing.append(spec.check_id)
        checks.append({"check_id": spec.check_id, "scope": spec.scope, "status": status,
                       "receipt_id": item.receipt_id if valid and item else None})
    unknown = sorted(set(seen) - {spec.check_id for spec in required_checks})
    complete = bool(required_checks) and not missing and not duplicates and not unknown
    return {"checks": checks, "complete": complete,
            "regression_failed": True if regression_count else False if complete and comparable_count else None,
            "regression_count": regression_count, "comparable_count": comparable_count,
            "regression_failure_rate": regression_count / comparable_count if comparable_count else None,
            "baseline_failure_count": baseline_failures, "missing_checks": missing,
            "duplicate_check_ids": sorted(duplicates), "unknown_check_ids": unknown,
            "limitations": ["Source paths identify integration targets, not executed tests.",
                            "No production workflows or live advertising operations are permitted."]}
