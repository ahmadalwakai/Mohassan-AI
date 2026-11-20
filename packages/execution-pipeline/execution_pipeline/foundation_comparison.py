"""Run one arm of the frozen bilingual comparison under the existing GPU guard."""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import tempfile

from . import REPOSITORY_ROOT
from .ads_finetune import _atomic_json, _sha256
from .chat_diagnostics import GpuJob
from .comparison_eval import FrozenEnglishDevelopment
from .comparison_sampling import FrozenComparisonSampler
from .language_adaptation import ComparisonRecovery, ComparisonSettings, PilotSettings, adapt
from .pretrain import TextEncoder
from execution_model.config import ModelConfig


APPROVED_PREPARATION = "artifacts/chat-training/v4/dataset/comparison-prep-20261116"
APPROVED_PREPARATION_SHA256 = "c4b0ac26cdfb6aaef7340c6997ed8f74f20be9217d565ee225ef0d1c50442be0"
MODEL_RUN = "artifacts/execution-model-runs/text-b4-2026-11-16/comparison-frozen-20261116"
MILESTONES = (32_000_000, 100_000_000)


def _read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _check_digest(path: Path, expected: str):
    if _sha256(path) != expected:
        raise ValueError(f"Pinned comparison file changed: {path}")


def _config_version(path: Path) -> int:
    if path.name == "config.json":
        return 0
    if path.name == "config-recovery.json":
        return 1
    match = re.fullmatch(r"config-recovery-([0-9]{2,})\.json", path.name)
    if match is None or int(match[1]) < 2:
        raise ValueError(f"Invalid comparison recovery configuration filename: {path.name}")
    return int(match[1])


def _recovery_entries(config: dict) -> dict:
    if "recovery" in config:
        specification = config["recovery"]
        if "recoveries" in config or not isinstance(specification, dict) or not isinstance(specification.get("arm"), str):
            raise ValueError("Rule 4 recovery must use one valid configuration schema.")
        return {specification["arm"]: specification}
    if "recoveries" not in config:
        return {}
    entries = config["recoveries"]
    if not isinstance(entries, dict) or not entries:
        raise ValueError("Rule 4 recoveries must be a nonempty map keyed by arm.")
    return entries


def _is_sha256(value) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _recovery_plan(config_path: Path, config: dict):
    entries = _recovery_entries(config)
    if not entries:
        if config_path.name.startswith("config-recovery"):
            raise ValueError("A comparison recovery configuration must include its recovery entries.")
        return {}
    original_path = config_path.parent / "config.json"

    def immutable(value):
        return {key: item for key, item in value.items() if key not in ("code_sha256", "recovery", "recoveries")}

    original = immutable(_read(original_path))
    checked: dict[Path, tuple[str, dict]] = {}

    def verify(path, value, items):
        version = _config_version(path)
        if immutable(value) != original or bool(items) != bool(version):
            raise ValueError("Rule 4 recovery cannot alter the original comparison configuration.")
        for arm, specification in items.items():
            if (not isinstance(specification, dict)
                    or set(specification) != {"arm", "checkpoint_positions", "checkpoint_sha256", "max_microbatch_rows",
                                              "previous_config"}
                    or arm != specification["arm"] or not _is_sha256(specification["checkpoint_sha256"])
                    or type(specification["checkpoint_positions"]) is not int
                    or not 0 < specification["checkpoint_positions"] < MILESTONES[-1]
                    or type(specification["max_microbatch_rows"]) is not int or specification["max_microbatch_rows"] != 1):
                raise ValueError("Rule 4 recovery requires an arm, one row per execution microbatch and a pinned checkpoint.")
            previous = specification["previous_config"]
            if (not isinstance(previous, dict) or set(previous) != {"path", "sha256"}
                    or not isinstance(previous["path"], str) or not _is_sha256(previous["sha256"])
                    or Path(previous["path"]).is_absolute()):
                raise ValueError("Rule 4 recovery predecessor requires a repository-relative path and SHA-256.")
            previous_path = (REPOSITORY_ROOT / previous["path"]).resolve()
            if previous_path.parent != path.parent or _config_version(previous_path) >= version:
                raise ValueError("Rule 4 recovery must pin an earlier configuration in the same campaign.")
            if previous_path in checked:
                if checked[previous_path][0] != previous["sha256"]:
                    raise ValueError("Conflicting SHA-256 pins for one comparison configuration.")
            else:
                _check_digest(previous_path, previous["sha256"])
                prior = _read(previous_path)
                verify(previous_path, prior, _recovery_entries(prior))
                checked[previous_path] = (previous["sha256"], prior)
            if any(items.get(name) != earlier for name, earlier in _recovery_entries(checked[previous_path][1]).items()):
                raise ValueError("Later comparison configurations must preserve earlier recovery entries.")

    verify(config_path, config, entries)
    return {arm: (specification, checked[(REPOSITORY_ROOT / specification["previous_config"]["path"]).resolve()][1])
            for arm, specification in entries.items()}


def _recovery_anchor(output: Path, specification: dict, previous: dict, attempts: Path) -> ComparisonRecovery:
    positions = specification["checkpoint_positions"]
    anchor = output / "checkpoints" / f"tokens-{positions:012d}"
    receipt = _read(anchor / "manifest.json")
    sha256 = specification["checkpoint_sha256"]
    previous_config_sha256 = specification["previous_config"]["sha256"]
    if (receipt["tokens"] != positions or receipt["checkpoint_sha256"] != sha256
            or receipt["settings"]["pilot_config_sha256"] != previous_config_sha256
            or receipt["code_sha256"] != previous["code_sha256"]):
        raise ValueError("The recovery anchor does not match the original pinned settings and payload.")
    if receipt["settings"]["comparison"].get("execution_microbatch_rows", 2) <= specification["max_microbatch_rows"]:
        raise ValueError("Rule 4 recovery cannot reduce grouping below the anchor's one-row microbatch.")
    _check_digest(anchor / "checkpoint.pt", sha256)
    stopped = False
    for manifest in attempts.glob("attempt-*/manifest.json"):
        prior = _read(manifest)
        if prior["config_sha256"] != previous_config_sha256 or prior["arm"] != specification["arm"]:
            continue
        summary = manifest.parent / "gpu-summary.json"
        if summary.name not in prior["files"]:
            continue
        _check_digest(summary, prior["files"][summary.name])
        problem = _read(summary).get("problem") or ""
        if problem.startswith(("GPU memory stop:", "GPU speed stop:")) and prior["failure"] == f"RuntimeError: {problem}":
            stopped = True
            break
    if not stopped:
        raise ValueError("The original attempt does not show a recorded Rule 4 memory or speed stop.")
    return ComparisonRecovery(previous_config_sha256, previous["code_sha256"], positions, sha256)


def run_comparison(config_path: Path, expected_sha256: str, view: str, mix: str, seed: int, *, resume: bool = False):
    import torch

    config_path = config_path.resolve()
    _check_digest(config_path, expected_sha256)
    config = _read(config_path)
    if (config["prep"] != APPROVED_PREPARATION or config["prep_sha256"] != APPROVED_PREPARATION_SHA256
            or config["run"] != MODEL_RUN):
        raise ValueError("Comparison configuration does not use the approved freeze and run directory.")
    recoveries = _recovery_plan(config_path, config)
    for filename, sha256 in config["code_sha256"].items():
        _check_digest(REPOSITORY_ROOT / filename, sha256)

    prep = REPOSITORY_ROOT / APPROVED_PREPARATION
    _check_digest(prep / "manifest.json", APPROVED_PREPARATION_SHA256)
    preparation = _read(prep / "manifest.json")
    for filename, sha256 in preparation["sha256"].items():
        _check_digest(prep / filename, sha256)
    allocation = _read(prep / "budgets/allocation.json")
    identity = {"view": view, "mix": mix, "seed": seed}
    if identity not in allocation["starts"]:
        raise ValueError(f"Unapproved comparison arm: {identity}")
    if tuple(map(int, allocation["milestones"])) != MILESTONES:
        raise ValueError("Comparison requires the authorized 32M and 100M evaluation points.")
    if config["checkpoint_every_tokens"] != 20_000_000:
        raise ValueError("Comparison recovery checkpoints require the configured 20M interval.")
    if recoveries.keys() - {f"{start['view']}-{start['mix']}-{start['seed']}" for start in allocation["starts"]}:
        raise ValueError("Rule 4 recovery names an unapproved comparison arm.")
    run = REPOSITORY_ROOT / MODEL_RUN
    arm = f"{view}-{mix}-{seed}"
    output = run / arm
    if output.exists() != resume:
        raise ValueError("Use resume only for an already-started comparison arm.")
    status = output / "status.json"
    if resume and status.is_file() and _read(status)["status"] == "completed":
        raise ValueError("Comparison arm already completed.")
    attempts = config_path.parent / arm
    if arm in recoveries and not resume:
        raise ValueError("The named Rule 4 repair is valid only when resuming its existing arm.")
    approved_anchors = {
        slug: _recovery_anchor(run / slug, specification, previous, config_path.parent / slug)
        for slug, (specification, previous) in recoveries.items()
    }
    recovery = approved_anchors.get(arm)
    arm_recovery = recoveries[arm][0] if recovery else None

    model = replace(ModelConfig.from_dict(config["model_config"]), seed=seed)
    context = allocation["sequence_length"]
    if model.max_context_length != context or model.parameter_count() != 38_281_728:
        raise ValueError("Comparison configuration must match the frozen 38M model shape.")
    tokenizer_path = run / "tokenizer.json"
    packed = _read(prep / "packed/streams/manifest.json")
    reference_files = preparation["fixed_validation"]
    for item in reference_files.values():
        _check_digest(REPOSITORY_ROOT / item["path"], item["sha256"])
    reference = (REPOSITORY_ROOT / reference_files["ar"]["path"]).parent
    reference_manifest = _read(reference / "manifest.json")
    _check_digest(tokenizer_path, reference_manifest["tokenizer_sha256"])
    _check_digest(run / "tokenizer-report.json", reference_manifest["tokenizer_report_sha256"])
    tokenizer = TextEncoder(run).tokenizer
    sampler = FrozenComparisonSampler(prep, allocation, seed=seed, mix=mix, view=view,
                                       verifier_sha256=config["code_sha256"][f"{APPROVED_PREPARATION}/budgets/verify.py"],
                                       max_microbatch_rows=arm_recovery["max_microbatch_rows"] if arm_recovery else None)
    development_path = prep / "splits/frozen-v4"
    development = FrozenEnglishDevelopment(development_path, preparation["sha256"]["splits/frozen-v4/manifest.json"],
                                            pad_token_id=tokenizer.pad_token_id, eos_token_id=tokenizer.eos_token_id)
    attempts.mkdir(exist_ok=True)
    attempt = Path(tempfile.mkdtemp(prefix="attempt-", dir=attempts))
    settings = {
        **identity, "prep_sha256": APPROVED_PREPARATION_SHA256,
        "packed_manifest_sha256": preparation["sha256"]["packed/streams/manifest.json"],
        "frozen_development_sha256": preparation["sha256"]["splits/frozen-v4/manifest.json"],
        "sampler_ledger_sha256": preparation["sha256"]["budgets/sampling-verification.json"],
        "stream_sha256": {source: views[view]["binary_sha256"] for source, views in packed["streams"].items()},
    }
    if arm_recovery:
        settings.update(execution_microbatch_rows=arm_recovery["max_microbatch_rows"], recovery=arm_recovery)
    comparison = ComparisonSettings(sampler=sampler, development=development, identity=settings, recovery=recovery)
    pilot = PilotSettings(model=model, reference=reference, milestones=MILESTONES,
                          checkpoint_every_tokens=config["checkpoint_every_tokens"], attempt_output=attempt,
                          config_sha256=expected_sha256, code_sha256=config["code_sha256"],
                          lr_decay_tokens=allocation["learning_rate_decay_horizon_positions"], comparison=comparison)
    torch.set_num_threads(4)
    result = failure = None
    try:
        with GpuJob(REPOSITORY_ROOT, attempt, stage="comparison", max_seconds=config["job_runtime_limit_seconds"]) as guard:
            torch.empty(1, device="cuda")
            guard.start_monitor()
            result = adapt(run, corpus=(REPOSITORY_ROOT / packed["arabic_training"]["path"]).parent,
                           out_name=arm, total_tokens=MILESTONES[-1], sequence=context,
                           microbatch=allocation["microbatch_rows_at_most"],
                           accumulation=allocation["regular_accumulation_microbatches"],
                           peak_lr=allocation["peak_learning_rate"], warmup=allocation["warmup_optimizer_updates"],
                           arabic_fraction=0.5, seed=seed, device="cuda", resume=resume, pilot=pilot, guard=guard)
            if result["status"] == "completed" and (result["processed_tokens"] != MILESTONES[-1]
                    or result["step"] != allocation["milestones"][str(MILESTONES[-1])]["optimizer_updates"]):
                raise ValueError("Completed comparison arm did not finish at its authorized token and update counts.")
        return result
    except (Exception, KeyboardInterrupt) as error:
        failure = f"{type(error).__name__}: {error}"
        raise
    finally:
        files = {path.relative_to(attempt).as_posix(): _sha256(path) for path in attempt.rglob("*") if path.is_file()}
        _atomic_json(attempt / "manifest.json", {
            "stage": "comparison", "arm": arm, **identity, "resumed": resume, "files": files,
            "end_time": datetime.now(timezone.utc).isoformat(), "config_sha256": expected_sha256,
            "result": result, "failure": failure,
            "trainer_status_sha256": _sha256(status) if status.is_file() else None,
        })
