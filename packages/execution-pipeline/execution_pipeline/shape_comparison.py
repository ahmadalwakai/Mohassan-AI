"""Pinned 85M pilot on the selected 38M experiment's identical logical windows."""
from __future__ import annotations

import ctypes
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import tempfile

from . import REPOSITORY_ROOT as ROOT
from .ads_finetune import _atomic_json, _sha256
from .chat_diagnostics import GpuJob
from .comparison_eval import FrozenEnglishDevelopment
from .comparison_sampling import FrozenComparisonSampler
from .foundation_comparison import APPROVED_PREPARATION, APPROVED_PREPARATION_SHA256, MODEL_RUN
from .language_adaptation import ComparisonSettings, PilotSettings, adapt
from .pretrain import TextEncoder
from execution_model.config import ModelConfig


CAMPAIGN = ROOT / "artifacts/chat-training/v4/stage-2-shape-20261118"
RUN = ROOT / "artifacts/execution-model-runs/text-b4-2026-11-18/stage-2-shape"
PREP = ROOT / APPROVED_PREPARATION
BASELINE = ROOT / MODEL_RUN / "existing-simplewiki_enriched-1729/checkpoints/tokens-000100000000/manifest.json"
FOUNDATION = ROOT / "artifacts/execution-model-runs/text-b4-2026-11-16/gate2-continuation-20261118/38m/status.json"
HISTORICAL = ROOT / "artifacts/execution-model-runs/text-b3-ar-2026-11-15/language-ar-v1/status.json"
BENCHMARK = ROOT / "artifacts/chat-training/v4/stage-0-3-guardclarified-20261116/config.json"
MILESTONES = (32_000_000, 100_000_000)
IDENTITY = {"view": "existing", "mix": "simplewiki_enriched", "seed": 1729}


def _read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _checked(path: Path, expected: str):
    if _sha256(path) != expected:
        raise ValueError(f"Pinned input changed: {path}")


def prepare() -> dict:
    """Create new immutable inputs; never modify an existing experiment."""
    _checked(PREP / "manifest.json", APPROVED_PREPARATION_SHA256)
    baseline = _read(BASELINE)
    if (baseline["tokens"] != MILESTONES[-1] or not baseline["exact_evaluation_milestone"]
            or baseline["settings"]["seed"] != IDENTITY["seed"]):
        raise ValueError("The comparison baseline is not the selected scheduled 100M checkpoint.")
    _checked(BASELINE.parent / "checkpoint.pt", baseline["checkpoint_sha256"])
    model_dict = dict(_read(BENCHMARK)["shapes"]["85m"]["config"], seed=IDENTITY["seed"])
    model = ModelConfig.from_dict(model_dict)
    if model.parameter_count() != 85_133_440:
        raise ValueError("Expected the benchmarked 85M shape.")
    source_run = ROOT / MODEL_RUN
    code_files = set(baseline["code_sha256"]) | {
        "packages/execution-pipeline/execution_pipeline/shape_comparison.py",
        "packages/execution-pipeline/scripts/compare_chat_shape.py",
    }
    code_files = {name for name in code_files if name.startswith(("packages/", "docs/"))}
    verifier = f"{APPROVED_PREPARATION}/budgets/verify.py"
    code_files.add(verifier)
    inputs = [PREP / "manifest.json", BASELINE, FOUNDATION, HISTORICAL, BENCHMARK,
              BASELINE.parent / "checkpoint.pt", source_run / "tokenizer.json", source_run / "tokenizer-report.json"]
    config = {"stage": 2, "shape": "85m", "identity": IDENTITY, "model_config": model.to_dict(),
              "model_config_identity": model.identity, "parameters": model.parameter_count(),
              "run": RUN.relative_to(ROOT).as_posix(), "campaign": CAMPAIGN.relative_to(ROOT).as_posix(),
              "prep": APPROVED_PREPARATION, "prep_sha256": APPROVED_PREPARATION_SHA256,
              "milestones": list(MILESTONES), "checkpoint_every_tokens": 20_000_000,
              "job_runtime_limit_seconds": 72 * 3600,
              "code_sha256": {name: _sha256(ROOT / name) for name in sorted(code_files)},
              "input_sha256": {path.relative_to(ROOT).as_posix(): _sha256(path) for path in inputs},
              "shape_selection_rule": "At least 0.15 lower fixed-reference loss in each language and a projected 1B foundation plus 8h later training within 72h.",
              "historical_gpu_time_in_budget": False, "holdout_accessed": False,
              "ready_for_chat": False, "phone_activated": False}
    CAMPAIGN.mkdir(parents=True, exist_ok=False)
    RUN.mkdir(parents=True, exist_ok=False)
    for name in ("tokenizer.json", "tokenizer-report.json"):
        shutil.copyfile(source_run / name, RUN / name)
    _atomic_json(CAMPAIGN / "config.json", config)
    return {"config": str(CAMPAIGN / "config.json"), "sha256": _sha256(CAMPAIGN / "config.json"),
            "parameters": model.parameter_count(), "gpu_started": False}


def check(expected_sha256: str):
    config_path = CAMPAIGN / "config.json"
    _checked(config_path, expected_sha256)
    config = _read(config_path)
    if (config["run"] != RUN.relative_to(ROOT).as_posix() or config["identity"] != IDENTITY
            or tuple(config["milestones"]) != MILESTONES or config["checkpoint_every_tokens"] != 20_000_000):
        raise ValueError("The shape pilot must retain its fixed run, windows and checkpoints.")
    for filename, digest in (config["code_sha256"] | config["input_sha256"]).items():
        _checked(ROOT / filename, digest)
    _checked(PREP / "manifest.json", APPROVED_PREPARATION_SHA256)
    prep = _read(PREP / "manifest.json")
    for filename, digest in prep["sha256"].items():
        _checked(PREP / filename, digest)
    for item in prep["fixed_validation"].values():
        _checked(ROOT / item["path"], item["sha256"])
    for filename in ("tokenizer.json", "tokenizer-report.json"):
        _checked(RUN / filename, config["input_sha256"][f"{MODEL_RUN}/{filename}"])
    allocation = _read(PREP / "budgets/allocation.json")
    if (IDENTITY not in allocation["starts"] or tuple(map(int, allocation["milestones"])) != MILESTONES
            or allocation["learning_rate_decay_horizon_positions"] != 300_000_000):
        raise ValueError("The shape comparison requires the original frozen schedule.")
    sampler = FrozenComparisonSampler(PREP, allocation, **IDENTITY,
        verifier_sha256=config["code_sha256"][f"{APPROVED_PREPARATION}/budgets/verify.py"])
    baseline = _read(BASELINE)
    sampler.seek(100_000_000, baseline["step"])
    if sampler.receipt(100_000_000) != baseline["comparison_sampling_receipt"]:
        raise ValueError("85M windows do not reproduce the selected 38M sampling receipt.")
    sampler.seek(0, 0)
    model = ModelConfig.from_dict(config["model_config"])
    if model.identity != config["model_config_identity"] or model.parameter_count() != 85_133_440:
        raise ValueError("Shape identity changed.")
    return config, prep, allocation, sampler, model


def assessment(config_sha256: str) -> dict:
    """Report the measured comparison without activating or testing chat."""
    _checked(CAMPAIGN / "config.json", config_sha256)
    config = _read(CAMPAIGN / "config.json")
    for filename, digest in config["input_sha256"].items():
        _checked(ROOT / filename, digest)
    result = _read(RUN / "85m/status.json")
    if result["status"] != "completed" or result["processed_tokens"] != 100_000_000:
        raise ValueError("85M comparison must finish before shape selection.")
    manifest_path = RUN / "85m/checkpoints/tokens-000100000000/manifest.json"
    manifest = _read(manifest_path)
    _checked(manifest_path.parent / "checkpoint.pt", manifest["checkpoint_sha256"])
    baseline = _read(BASELINE)["fixed_reference_validation_loss"]
    bigger = manifest["fixed_reference_validation_loss"]
    foundation = _read(FOUNDATION)
    historical = _read(HISTORICAL)["last_validation"]
    small300 = foundation["last_validation"]
    gains = {lang: baseline[lang] - bigger[lang] for lang in ("ar", "en")}
    reference_pass = (foundation["status"] == "completed" and foundation["processed_tokens"] == 300_000_000 and all(
        small300[lang] < min(baseline[lang], historical[lang]) for lang in ("ar", "en")))
    seconds = result["minutes"] * 60
    rate = result["processed_tokens"] / seconds
    projections = {str(tokens): {"foundation_hours": tokens / rate / 3600,
        "remaining_foundation_hours": (tokens - 100_000_000) / rate / 3600,
        "foundation_plus_reserved_adaptation_sft_hours": tokens / rate / 3600 + 8,
        "fits_72_hours_with_8h_reserve": tokens / rate / 3600 + 8 <= 72}
        for tokens in (1_000_000_000, 1_500_000_000)}
    gain_pass = all(value >= 0.15 for value in gains.values())
    selected = "85m" if gain_pass and projections["1000000000"]["fits_72_hours_with_8h_reserve"] else "38m"
    report = {"stage": 2, "comparison_completed": True, "fixed_reference_curve_passed": reference_pass,
        "fixed_reference_38m_100m": baseline, "fixed_reference_85m_100m": bigger,
        "loss_reduction_by_language": gains, "macro_loss_reduction": sum(gains.values()) / 2,
        "at_least_015_reduction_each_language": gain_pass,
        "at_least_015_macro_reduction": sum(gains.values()) / 2 >= 0.15,
        "selected_shape": selected, "gate2_passed": reference_pass,
        "fixed_reference_38m_300m": small300, "historical_32m_reference": historical,
        "historical_english_improvement": historical["en"] - small300["en"],
        "measured_wall_positions_per_second": rate, "projected_85m": projections,
        "budget_excludes_completed_historical_experiments": True,
        "config_sha256": config_sha256, "checkpoint_sha256": manifest["checkpoint_sha256"],
        "development_is_independent_test": False, "chat_readiness_tested": False,
        "ready_for_chat": False, "phone_activated": False, "holdout_accessed": False}
    destination = CAMPAIGN / "assessment.json"
    if destination.exists():
        if _read(destination) != report:
            raise ValueError("Existing shape assessment differs; never overwrite it.")
        return report
    if any((CAMPAIGN / name).exists() for name in ("report.md", "report-manifest.json")):
        raise FileExistsError("An incomplete prior report exists; preserve it for review.")
    _atomic_json(destination, report)
    lines = ["# Stage 2 shape comparison", "", f"Completed 85M at 100M positions; selected shape: {selected}.", "",
        "| Language | 38M at 100M | 85M at 100M | Loss reduction |", "| --- | ---: | ---: | ---: |"]
    lines += [f"| {lang} | {baseline[lang]:.9f} | {bigger[lang]:.9f} | {gains[lang]:+.9f} |" for lang in gains]
    lines += ["", f"Fixed-reference curve gate: {'passed' if reference_pass else 'failed'}.",
        f"Equal-language macro loss reduction: {report['macro_loss_reduction']:+.9f}.",
        "Larger shape requires at least 0.15 improvement in each language and a 1B full run plus 8 hours reserved for later training within 72 hours.",
        f"Measured 85M wall speed: {rate:.1f} positions/s.",
        f"Projected 85M 1B/1.5B foundation: {projections['1000000000']['foundation_hours']:.2f}/{projections['1500000000']['foundation_hours']:.2f} hours, before the reserved 8 hours.",
        "The projection excludes completed historical experiments. Fresh long-run training includes a new learning-rate schedule; optimizer continuation is not established by this pilot.",
        "English 300M improvement over the historical reference is very small; the precise number is in assessment.json.",
        "No chat replies were judged, no independent holdout was accessed, and phone activation remains false."]
    (CAMPAIGN / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    _atomic_json(CAMPAIGN / "report-manifest.json", {"config_sha256": config_sha256,
        "files": {name: _sha256(CAMPAIGN / name) for name in ("assessment.json", "report.md")},
        "input_status_sha256": _sha256(RUN / "85m/status.json"),
        "checkpoint_manifest_sha256": _sha256(manifest_path)})
    return report


def execute(config_sha256: str, *, resume: bool = False, max_minutes: float | None = None) -> dict:
    """Run or resume this exact experiment; max_minutes saves a smoke checkpoint."""
    import torch

    config, prep, allocation, sampler, model = check(config_sha256)
    output = RUN / "85m"
    if output.exists() != resume:
        raise ValueError("Resume requires this pilot's existing output directory.")
    if resume and _read(output / "status.json")["status"] == "completed":
        raise ValueError("The 85M pilot is already completed.")
    attempt = Path(tempfile.mkdtemp(prefix="attempt-", dir=CAMPAIGN))
    tokenizer = TextEncoder(RUN).tokenizer
    development = FrozenEnglishDevelopment(PREP / "splits/frozen-v4",
        prep["sha256"]["splits/frozen-v4/manifest.json"], pad_token_id=tokenizer.pad_token_id,
        eos_token_id=tokenizer.eos_token_id)
    packed = _read(PREP / "packed/streams/manifest.json")
    identity = {**IDENTITY, "prep_sha256": APPROVED_PREPARATION_SHA256,
        "packed_manifest_sha256": prep["sha256"]["packed/streams/manifest.json"],
        "frozen_development_sha256": prep["sha256"]["splits/frozen-v4/manifest.json"],
        "sampler_ledger_sha256": prep["sha256"]["budgets/sampling-verification.json"],
        "stream_sha256": {source: views["existing"]["binary_sha256"] for source, views in packed["streams"].items()}}
    reference = (ROOT / prep["fixed_validation"]["ar"]["path"]).parent
    pilot = PilotSettings(model, reference, MILESTONES, config["checkpoint_every_tokens"], attempt,
        config_sha256, config["code_sha256"], lr_decay_tokens=allocation["learning_rate_decay_horizon_positions"],
        comparison=ComparisonSettings(sampler, development, identity))
    result = failure = None
    torch.set_num_threads(4)
    awake = ctypes.windll.kernel32.SetThreadExecutionState
    if not awake(0x80000001):
        raise RuntimeError("Windows could not reserve system wakefulness.")
    try:
        with GpuJob(ROOT, attempt, stage="2-85m-shape", max_seconds=config["job_runtime_limit_seconds"]) as guard:
            torch.empty(1, device="cuda")
            guard.start_monitor()
            result = adapt(RUN, corpus=(ROOT / packed["arabic_training"]["path"]).parent,
                out_name="85m", total_tokens=MILESTONES[-1], sequence=allocation["sequence_length"],
                microbatch=allocation["microbatch_rows_at_most"], accumulation=allocation["regular_accumulation_microbatches"],
                peak_lr=allocation["peak_learning_rate"], warmup=allocation["warmup_optimizer_updates"],
                arabic_fraction=0.5, seed=IDENTITY["seed"], device="cuda", resume=resume,
                max_minutes=max_minutes, pilot=pilot, guard=guard)
        if result["status"] == "completed":
            if (result["processed_tokens"] != 100_000_000
                    or result["step"] != allocation["milestones"]["100000000"]["optimizer_updates"]):
                raise ValueError("Completed pilot missed its frozen token or update count.")
            assessment(config_sha256)
        return result
    except BaseException as error:
        failure = f"{type(error).__name__}: {error}"
        raise
    finally:
        awake(0x80000000)
        files = {path.relative_to(attempt).as_posix(): _sha256(path) for path in attempt.rglob("*") if path.is_file()}
        _atomic_json(attempt / "manifest.json", {"stage": 2, "shape": "85m", "resumed": resume,
            "max_minutes": max_minutes, "end_time": datetime.now(timezone.utc).isoformat(),
            "config_sha256": config_sha256, "files": files, "result": result, "failure": failure,
            "trainer_status_sha256": _sha256(output / "status.json") if (output / "status.json").exists() else None})
