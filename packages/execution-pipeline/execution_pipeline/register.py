"""Step 14: register a trained checkpoint and bind its independent evaluation.

Uses Phase 3's immutable ``ModelVersionRegistry``. Registration and evaluation
records never activate a model; promotion stays ``unpromoted`` and production
activation requires the Phase 5 lifecycle with an explicit owner approval.
"""
from __future__ import annotations

import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import REPOSITORY_ROOT

from execution_model.config import ARCHITECTURE_VERSION
from execution_training.checkpoints import CheckpointReference
from execution_training.common import digest
from execution_training.registry import EvaluationAttestation, ModelVersionManifest, ModelVersionRegistry

# Pre-declared acceptance gate for promotion REVIEW eligibility (not activation).
GATE = {"min_typescript_behavioral_correctness": 0.9, "min_overall_behavioral_correctness": 0.8,
        "max_unauthorized_output_rate": 0.0}


def _git_head() -> str:
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPOSITORY_ROOT, capture_output=True, text=True, check=True).stdout.strip()


def register(run: Path, *, training: str, version: str, rollback: str | None = None) -> dict[str, Any]:
    report = json.loads((run / training / "training-report.json").read_text(encoding="utf-8"))
    checkpoint = report["last_valid_checkpoint"]
    compatibility = report["compatibility"]
    summary = json.loads((run / "dataset-summary.json").read_text(encoding="utf-8"))
    registry = ModelVersionRegistry(run.parent / "registry")
    manifest = ModelVersionManifest(
        model_version=version, architecture_identity=ARCHITECTURE_VERSION,
        tokenizer_version=compatibility["tokenizer_identity"], dataset_version=summary["dataset_version"],
        dataset_manifest_identity=compatibility["dataset_manifest_identity"],
        training_configuration=report["training_configuration"],
        checkpoint=CheckpointReference(checkpoint["path"], checkpoint["sha256"]),
        training_provenance={"initialization": "random", "run_id": report["session_id"],
                             "source_revision": _git_head() + "+uncommitted:" + compatibility["training_source_sha256"],
                             "report_reference": str(run / training / "training-report.json")},
        rollback_reference=rollback)
    path = registry.register(manifest)
    return {"registered": str(path), "inspect": registry.inspect(version)}


def gate_decision(evaluation: dict[str, Any]) -> dict[str, Any]:
    model = evaluation["summaries"]["trained-model-17m"]["rates"]
    families = evaluation["per_family"]
    ts_tasks = sum(families[f]["tasks"] for f in ("typescript_function", "repair") if f in families)
    ts_correct = sum(families[f]["model_final"] for f in ("typescript_function", "repair") if f in families)
    overall = model["success_within_bounded_repair"]["value"]
    ts_rate = ts_correct / ts_tasks if ts_tasks else None
    checks = {"typescript_behavioral": ts_rate is not None and ts_rate >= GATE["min_typescript_behavioral_correctness"],
              "overall_behavioral": overall is not None and overall >= GATE["min_overall_behavioral_correctness"]}
    return {"gate": GATE, "typescript_behavioral_correctness": ts_rate, "overall_success_within_bounded_repair": overall,
            "checks": checks, "passed": all(checks.values())}


def record_evaluation(run: Path, *, version: str, evaluation_path: Path) -> dict[str, Any]:
    registry = ModelVersionRegistry(run.parent / "registry")
    manifest = registry.inspect(version)
    evaluation = json.loads(evaluation_path.read_text(encoding="utf-8"))
    decision = gate_decision(evaluation)
    reference = "local-evaluation:" + digest(evaluation)
    attestation = EvaluationAttestation(
        reference=reference, evaluator_identity="execution-pipeline.evaluate+appcontainer+phase3-oracles",
        model_version=version, checkpoint_sha256=manifest["checkpoint"]["sha256"],
        dataset_manifest_identity=manifest["dataset_manifest_identity"],
        suite_identity=evaluation["evaluation_digest"], completed_at=datetime.now(timezone.utc).isoformat(),
        independent=True, passed=decision["passed"])
    path = registry.record_evaluation(version, reference, lambda ref: attestation)
    return {"evaluation_receipt": str(path), "decision": decision, "inspect": registry.inspect(version)}
