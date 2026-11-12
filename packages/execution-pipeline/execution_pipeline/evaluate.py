"""Independent held-out evaluation: deterministic compiler vs retrieval vs trained model.

* Tasks: the Phase 3 ``test`` split only. It was never encoded for training, never
  seen by the tokenizer, and its evidence is scoped ``test``.
* Same task text, same output budget and the same verifiers for every arm.
* Verification never trusts the executor:
  - JSON/text families: the Phase 3 domain oracle (``check_synthetic``) applied to the
    candidate text;
  - TypeScript families: actual execution of the candidate in the Windows AppContainer
    sandbox against probes whose expected values come from an independent oracle.
* Rows are Phase 4 ``TaskResult`` objects summarized with Phase 4's ``summarize_results``.
"""
from __future__ import annotations

import json
import subprocess
import time
from dataclasses import replace
from pathlib import Path
from typing import Any

from . import REPOSITORY_ROOT

from execution_training.errors import TrainingError
from execution_training.schemas import TrainingExample
from execution_training.synthetic import check_synthetic
from execution_training.tokenization import render_prompt
from execution_training.validation import matches_schema, parse_json

from execution_evaluation.baselines import _cosine, _terms  # Phase 4 lexical retrieval primitives
from execution_evaluation.common import digest
from execution_evaluation.metrics import summarize_results
from execution_evaluation.schemas import TaskResult
from execution_evaluation.statistics import paired_comparison

from .experiment import load_run_dataset
from .repair import PROBES, expected, interpret
from .tasks import render

# Phase 4 family keys: A structured spec -> operation, B short TypeScript, C repair from failure evidence.
PHASE4_FAMILY = {"typescript_function": "B", "repair": "C"}
TS_FAMILIES = {"typescript_function", "repair"}
MAX_NEW_TOKENS = 96


def phase4_family(example: TrainingExample) -> str:
    return PHASE4_FAMILY.get(example.task_family, "A")


def ts_fields(example: TrainingExample) -> tuple[str, dict[str, Any]]:
    context = example.required_context
    fields: dict[str, Any] = {"function_name": context["function_name"], "increment": context["increment"]}
    if example.task_family == "typescript_function":
        return "typescript.implement.v1:null-safe-delta", fields
    repair = example.repair
    return "typescript.repair.v1:null-safe-delta", {**fields, "failed_candidate": repair.failed_candidate,
                                                    "failure_evidence": list(repair.failure_evidence),
                                                    "failure_category": repair.failure_category}


def check_prompt_contract(examples: list[TrainingExample]) -> int:
    """The worker's typed renderer must reproduce the training prompt byte-for-byte."""
    checked = 0
    for example in examples:
        if example.task_family in TS_FAMILIES:
            capability, fields = ts_fields(example)
            if render(capability, fields) != render_prompt(example):
                raise TrainingError("PROMPT_CONTRACT_DRIFT", f"Worker prompt differs for {example.sample_id}.")
            checked += 1
    return checked


def oracle_check(example: TrainingExample, candidate: str) -> tuple[bool, bool, str | None]:
    """(structural_valid, behavioral_correct, failure_category) for non-TS families."""
    if example.output_contract["format"] == "json":
        try:
            structural = matches_schema(parse_json(candidate), example.output_contract["schema"])
        except (TrainingError, ValueError, TypeError):
            return False, False, "invalid_json"
    else:
        structural = bool(candidate.strip())
    try:
        check_synthetic(replace(example, expected_output=candidate))
        return structural, True, None
    except (TrainingError, KeyError, ValueError, TypeError):
        return structural, False, "oracle_rejected" if structural else "structurally_invalid"


def sandbox_verify(job: list[dict[str, Any]], work: Path) -> dict[str, Any]:
    work.mkdir(parents=True, exist_ok=True)
    job_path, result_path = work / "sandbox-job.json", work / "sandbox-result.json"
    job_path.write_text(json.dumps({"candidates": job}), encoding="utf-8")
    completed = subprocess.run(["npx.cmd", "tsx", "scripts/execution-sandbox-verify.ts", str(job_path), str(result_path)],
                               cwd=REPOSITORY_ROOT, capture_output=True, text=True, timeout=1800)
    if completed.returncode != 0:
        raise RuntimeError("sandbox verifier failed: " + completed.stderr[-500:])
    result = json.loads(result_path.read_text(encoding="utf-8"))
    if not result.get("available") or not all(r.get("isolationVerified") and r.get("network") == "denied" for r in result["receipts"]):
        raise RuntimeError("AppContainer isolation unavailable; refusing to report behavioral results.")
    return result


def probe_job(job_id: str, function_name: str, increment: int, content: str) -> dict[str, Any]:
    probes = [{"arg": "null" if p is None else p, "expected": expected(p, increment)} for p in PROBES]
    return {"id": job_id, "functionName": function_name, "content": content, "probes": probes}


class ModelArm:
    def __init__(self, checkpoint: Path, device: str = "cuda"):
        import torch
        from execution_model.config import ModelConfig
        from execution_model.inference import InferenceEngine
        from execution_model.resources import ResourceConfig
        self.torch = torch
        config = ModelConfig.from_dict(json.loads((checkpoint / "config.json").read_text(encoding="utf-8")))
        manifest = json.loads((checkpoint / "manifest.json").read_text(encoding="utf-8"))
        self.engine = InferenceEngine(ResourceConfig(device=device, dtype="float32", max_context_length=config.max_context_length,
                                                     max_output_tokens=MAX_NEW_TOKENS, max_input_bytes=65_536))
        self.metadata = self.engine.load_local_model(checkpoint.resolve(), expected_config=config,
                                                     expected_tokenizer_identity=manifest["tokenizer_identity"])
        self.device = device

    def generate(self, prompt: str) -> tuple[str | None, float, int]:
        from execution_model.generation import GenerationConfig
        started = time.perf_counter()
        available = self.engine.resources.max_context_length - len(self.engine.encode_task_input(prompt))
        if available < 1:
            return None, (time.perf_counter() - started) * 1000, 0
        response = self.engine.generate_candidate(prompt, GenerationConfig(max_new_tokens=min(MAX_NEW_TOKENS, available)))
        elapsed = (time.perf_counter() - started) * 1000
        if response.status != "completed" or response.candidate is None:
            return None, elapsed, 0
        return response.candidate.text, elapsed, response.candidate.generation.output_tokens


def _row(example: TrainingExample, arm: str, **values: Any) -> TaskResult:
    return TaskResult(task_id=example.sample_id, task_family=phase4_family(example), project_family=example.project_family,
                      template_family=example.template_family, tier="atomic", dataset_version="execution-synthetic-2026-11-12",
                      arm_id=arm, mode="executor_only", **values)


def evaluate(run: Path, checkpoint: Path, *, device: str = "cuda", repair_budget: int = 1) -> dict[str, Any]:
    dataset, _ = load_run_dataset(run)
    train_examples = list(dataset.for_split("train"))
    tests = sorted(dataset.for_split("test"), key=lambda item: item.sample_id)
    prompt_contract_checked = check_prompt_contract(tests)
    work = run / "evaluation"
    work.mkdir(parents=True, exist_ok=True)

    # ---- arm 2: lexical retrieval over the training split (Phase 4 primitives) ----
    corpus = [(_terms({"prompt": render_prompt(e)}), e) for e in train_examples]
    retrieval: dict[str, tuple[str, float, float]] = {}
    for example in tests:
        started = time.perf_counter()
        query = _terms({"prompt": render_prompt(example)})
        score, best = max(((_cosine(query, terms), item) for terms, item in corpus), key=lambda pair: (pair[0], pair[1].sample_id))
        retrieval[example.sample_id] = (best.expected_output, score, (time.perf_counter() - started) * 1000)

    # ---- arm 3: trained model, first attempt ----
    model = ModelArm(checkpoint, device)
    if device == "cuda":
        model.torch.cuda.reset_peak_memory_stats()
    generated: dict[str, tuple[str | None, float, int]] = {}
    for example in tests:
        generated[example.sample_id] = model.generate(render_prompt(example))
    peak = int(model.torch.cuda.max_memory_allocated()) if device == "cuda" else None

    # ---- independent verification ----
    jobs = []
    for example in tests:
        if example.task_family not in TS_FAMILIES:
            continue
        name, increment = example.required_context["function_name"], example.required_context["increment"]
        jobs.append(probe_job("retrieval|" + example.sample_id, name, increment, retrieval[example.sample_id][0]))
        text = generated[example.sample_id][0]
        if text is not None:
            jobs.append(probe_job("model|" + example.sample_id, name, increment, text))
    sandbox = sandbox_verify(jobs, work / "attempt-1")

    def verdict(arm: str, example: TrainingExample, text: str | None) -> tuple[bool, bool, str | None]:
        if text is None:
            return False, False, "generation_failed"
        if example.task_family in TS_FAMILIES:
            outcome = sandbox["results"].get(arm + "|" + example.sample_id, {})
            structural = bool(outcome.get("loaded")) and bool(outcome.get("exported"))
            behavioral = structural and outcome.get("passed") == len(PROBES) and not outcome.get("failed")
            return structural, behavioral, None if behavioral else ("load_or_export_failed" if not structural else "probe_failed")
        return oracle_check(example, text)

    # ---- bounded repair: one extra attempt for failed TS implementations, using sandbox evidence ----
    repairs: dict[str, dict[str, Any]] = {}
    repair_jobs = []
    for example in tests:
        if example.task_family != "typescript_function":
            continue
        text = generated[example.sample_id][0]
        structural, behavioral, _ = verdict("model", example, text)
        if behavioral or repair_budget < 1 or text is None:
            continue
        outcome = sandbox["results"].get("model|" + example.sample_id, {})
        evidence = [f"{example.required_context['function_name']}({f['arg']}) returned {f['observed']}; expected {f['expected']}"
                    for f in outcome.get("failed", [])][:2]
        try:
            interpret(text)  # the repair skill only accepts the trained closed grammar
        except TrainingError:
            repairs[example.sample_id] = {"status": "repair_unsupported", "reason": "candidate outside repair grammar"}
            continue
        if not evidence:
            repairs[example.sample_id] = {"status": "repair_unsupported", "reason": "no concrete failure evidence"}
            continue
        category = ("missing_null_guard" if "null" in evidence[0] and "?" not in text else
                    "wrong_operator" if " - " in text else "wrong_default")
        fields = {"function_name": example.required_context["function_name"], "increment": example.required_context["increment"],
                  "failed_candidate": text, "failure_evidence": evidence, "failure_category": category}
        repaired, latency, _ = model.generate(render("typescript.repair.v1:null-safe-delta", fields))
        repairs[example.sample_id] = {"status": "attempted", "text": repaired, "latency_ms": latency, "category": category}
        if repaired is not None:
            repair_jobs.append(probe_job("repair|" + example.sample_id, fields["function_name"], fields["increment"], repaired))
    repair_sandbox = sandbox_verify(repair_jobs, work / "attempt-2") if repair_jobs else {"results": {}, "receipts": []}

    rows: list[TaskResult] = []
    records = []
    for example in tests:
        # Deterministic arm: Phase 1's registry has only structured.replace-file.v1.
        rows.append(_row(example, "deterministic-compiler-v1", outcome="unsupported", attempts=1,
                         first_attempt_success=False, success_within_budget=False, structural_valid=None,
                         behavioral_correct=False, predicted_response="unsupported", external_escalated=False,
                         latency_ms=0.0, cost_usd=0.0, failure_categories=("no_registered_transformation",)))
        text, score, latency = retrieval[example.sample_id]
        structural, behavioral, failure = verdict("retrieval", example, text)
        rows.append(_row(example, "lexical-retrieval-v1", outcome="verified_success" if behavioral else "verification_failed",
                         attempts=1, first_attempt_success=behavioral, success_within_budget=behavioral,
                         structural_valid=structural, behavioral_correct=behavioral, predicted_response="candidate",
                         external_escalated=False, latency_ms=latency, cost_usd=0.0,
                         failure_categories=() if behavioral else (failure,)))
        text, latency, tokens = generated[example.sample_id]
        structural, behavioral, failure = verdict("model", example, text)
        final = behavioral
        attempts = 1
        repair = repairs.get(example.sample_id)
        if repair and repair.get("status") == "attempted":
            attempts = 2
            outcome = repair_sandbox["results"].get("repair|" + example.sample_id, {})
            final = bool(outcome.get("loaded")) and outcome.get("passed") == len(PROBES) and not outcome.get("failed")
            latency += repair["latency_ms"]
        rows.append(_row(example, "trained-model-17m", outcome="verified_success" if final else "verification_failed",
                         attempts=attempts, first_attempt_success=behavioral, success_within_budget=final,
                         structural_valid=structural, behavioral_correct=final, predicted_response="candidate",
                         external_escalated=False, independent_local_contribution=final, latency_ms=latency,
                         peak_memory_bytes=peak, cost_usd=0.0, failure_categories=() if final else (failure or "repair_failed",)))
        records.append({"task_id": example.sample_id, "family": example.task_family, "expected": example.expected_output,
                        "model_output": text, "model_first_attempt_correct": behavioral, "model_final_correct": final,
                        "repair": repair, "retrieval_output": retrieval[example.sample_id][0],
                        "retrieval_similarity": retrieval[example.sample_id][1]})

    by_arm: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        by_arm.setdefault(row.arm_id, []).append(row.to_dict())
    summaries = {arm: summarize_results(values) for arm, values in by_arm.items()}
    per_family: dict[str, dict[str, Any]] = {}
    for record in records:
        family = per_family.setdefault(record["family"], {"tasks": 0, "model_first_attempt": 0, "model_final": 0, "retrieval": 0})
        family["tasks"] += 1
        family["model_first_attempt"] += record["model_first_attempt_correct"]
        family["model_final"] += record["model_final_correct"]
    for row in rows:
        if row.arm_id == "lexical-retrieval-v1" and row.behavioral_correct:
            per_family[next(r["family"] for r in records if r["task_id"] == row.task_id)]["retrieval"] += 1
    try:
        comparison = paired_comparison([r.to_dict() for r in rows if r.arm_id == "lexical-retrieval-v1"],
                                       [r.to_dict() for r in rows if r.arm_id == "trained-model-17m"])
    except Exception as error:  # report, never hide
        comparison = {"unavailable": str(error)[:300]}
    report = {"test_tasks": len(tests), "prompt_contract_checked": prompt_contract_checked,
              "checkpoint": str(checkpoint), "model_metadata": model.metadata.to_dict(), "device": device,
              "summaries": summaries, "per_family": per_family, "paired_comparison_retrieval_vs_model": comparison,
              "sandbox_receipts": {"attempt_1": sandbox["receipts"], "attempt_2": repair_sandbox["receipts"]},
              "repairs_attempted": sum(1 for r in repairs.values() if r.get("status") == "attempted"),
              "repairs_unsupported": sum(1 for r in repairs.values() if r.get("status") == "repair_unsupported"),
              "verifiers": {"json_text": "Phase 3 check_synthetic domain oracle", "typescript": "AppContainer sandbox execution with oracle probes"},
              "evaluation_digest": digest(records)}
    (work / "records.json").write_text(json.dumps(records, indent=1, ensure_ascii=False), encoding="utf-8")
    (work / "report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False, default=str), encoding="utf-8")
    return report


def phase4_split_audit(run: Path) -> dict[str, Any]:
    """Run Phase 4's own leakage audit over (training corpus, held-out tasks). Reported as-is."""
    from execution_evaluation.schemas import EvaluationTask, ExecutionBudget
    from execution_evaluation.splits import CorpusRecord, audit_splits, corpus_hash
    from execution_evaluation.dataset import public_input
    dataset, _ = load_run_dataset(run)

    def task_for(example: TrainingExample) -> EvaluationTask:
        return EvaluationTask(
            task_id=example.sample_id, task_family=phase4_family(example), project_family=example.project_family,
            template_family=example.template_family,
            input_specification={"prompt": render_prompt(example)}, available_context={}, allowed_symbols=(),
            expected_behavior={"target_sha256": example.target_hash}, acceptance_criteria=tuple(example.acceptance_criteria),
            hidden_test_ref="oracle:" + example.verification.reference, required_capabilities=(),
            allowed_execution_budget=ExecutionBudget(time_ms=120_000, output_tokens=MAX_NEW_TOKENS, max_attempts=2),
            expected_output_language=example.language, safety_constraints={"risk_classes": ["standard"]},
            dataset_version="execution-synthetic-2026-11-12", tier="atomic")

    tests = [task_for(e) for e in dataset.for_split("test")]
    records = []
    for example in dataset.for_split("train"):
        records.append(CorpusRecord(record_id=example.sample_id, source_split="training", project_family=example.project_family,
                                    template_family=example.template_family, public_input=public_input(task_for(example)),
                                    response_hash=example.target_hash, source_manifest_hash=dataset.manifest.identity,
                                    authorization_reference=example.authorization.authorization_reference,
                                    authorized_uses=("training", "retrieval")))
    audit = audit_splits(tests, records, evaluation_manifest_hash=digest([t.task_id for t in tests]),
                         pinned_corpus_hash=corpus_hash(records), inventory_complete=True,
                         inventory_reference=str(run / "dataset" / "split-manifest.json"), max_comparisons=2_000_000)
    kinds: dict[str, int] = {}
    for pair in audit.duplicate_pairs:
        kinds[pair.kind] = kinds.get(pair.kind, 0) + 1
    return {"clean": audit.clean, "project_isolation": audit.project_isolation, "template_isolation": audit.template_isolation,
            "near_detection_complete": audit.near_detection_complete, "comparisons": audit.comparisons,
            "duplicate_pairs_by_kind": kinds, "issues": sorted(set(i.split(":")[0] for i in audit.issues)),
            "warnings": list(audit.warnings)}
