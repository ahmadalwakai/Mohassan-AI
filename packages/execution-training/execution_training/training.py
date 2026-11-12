"""Single-process causal PyTorch training, invoked explicitly by a trusted host.

No executable module entry point, network access, pretrained loader, or automatic
evaluation/promotion exists here. Model and tokenizer implementations belong to
Phase 2; independent behavioral evaluation belongs to Phase 4.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import random
import os
import signal
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Iterator

from .activation import configure_activation_checkpointing
from .checkpoints import CheckpointManager, capture_rng_state, restore_rng_state
from .common import atomic_json, digest, implementation_identity
from .configuration import TrainingConfig
from .curriculum import CurriculumPlan
from .dataset import PreparedDataset
from .errors import TrainingError
from .model_factory import ModelFactory, ModelRequest, validate_bundle
from .optimization import create_optimizer, create_scheduler
from .precision import resolve_precision
from .privacy import PrivacyPolicy
from .provenance import EvidenceResolver
from .resources import ResourceProfiler, memory_estimate, runtime_identity
from .sampling import DeterministicSampler
from .tokenization import TokenizerAdapter, collate_encoded, encode_example

TRAINER_VERSION = "execution-trainer-v1"


@dataclass
class StopRequest:
    requested: bool = False


@contextmanager
def graceful_signals(enabled: bool) -> Iterator[StopRequest]:
    """First SIGINT/SIGTERM requests a stop after the current optimizer window.

    Hosts using another thread/event loop should disable this and supply their own
    stop_requested callback. No signal-driven checkpoint is saved mid-update.
    """
    request = StopRequest()
    previous: dict[int, Any] = {}
    if enabled:
        if threading.current_thread() is not threading.main_thread():
            raise TrainingError("SIGNAL_HANDLER_UNAVAILABLE", "Use an explicit stop callback outside the main thread.")
        def handler(signum: int, frame: Any) -> None:
            request.requested = True
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous[signum] = signal.getsignal(signum)
            signal.signal(signum, handler)
    try:
        yield request
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def _seed(seed: int, deterministic: bool) -> None:
    import torch
    random.seed(seed)
    try:
        import numpy as np
    except ImportError:
        pass
    else:
        np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    torch.use_deterministic_algorithms(deterministic)
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = deterministic
    if hasattr(torch.backends.cuda.matmul, "allow_tf32"):
        torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False


def _loss_sum(model: Any, batch: dict, precision: Any, vocabulary_size: int) -> tuple[Any, int]:
    import torch
    import torch.nn.functional as functional
    tensors = {name: torch.tensor(values, dtype=torch.long, device=precision.device)
               for name, values in batch.items()}
    labels = tensors["labels"][:, 1:].contiguous()
    loss_tokens = int((labels != -100).sum().item())
    if not loss_tokens:
        raise TrainingError("EMPTY_TARGET", "Batch contains no causal target tokens.")
    with precision.autocast():
        output = model(input_ids=tensors["input_ids"], attention_mask=tensors["attention_mask"])
        logits = output if isinstance(output, torch.Tensor) else (
            output.get("logits") if isinstance(output, dict) else getattr(output, "logits", None))
        if (not isinstance(logits, torch.Tensor) or logits.ndim != 3
                or tuple(logits.shape[:2]) != tuple(tensors["input_ids"].shape)
                or logits.shape[-1] != vocabulary_size):
            raise TrainingError("MODEL_OUTPUT_INVALID", "Phase 2 must return [batch, sequence, vocabulary] logits.")
        # FP32 loss evaluation even under autocast. Labels are aligned to input IDs
        # and shifted here exactly once; prompt and padding labels stay ignored.
        loss = functional.cross_entropy(logits[:, :-1, :].float().reshape(-1, vocabulary_size),
                                        labels.reshape(-1), ignore_index=-100, reduction="sum")
    if not bool(torch.isfinite(loss).item()):
        raise TrainingError("INVALID_LOSS", "Loss is NaN or infinite; the window was not committed.")
    return loss, loss_tokens


def _bounded_validation(model: Any, encoded: tuple, config: TrainingConfig,
                        precision: Any, pad_token_id: int, vocabulary_size: int) -> dict:
    import torch
    if not encoded:
        return {"status": "unavailable", "examples": 0, "loss_tokens": 0}
    saved_rng = capture_rng_state()
    previous_mode = model.training
    total_loss, total_tokens, count = 0.0, 0, 0
    try:
        model.eval()
        with torch.no_grad():
            limit = min(len(encoded), config.validation_batches * config.microbatch_size)
            for start in range(0, limit, config.microbatch_size):
                records = encoded[start:min(start + config.microbatch_size, limit)]
                loss, tokens = _loss_sum(model, collate_encoded(records, pad_token_id), precision, vocabulary_size)
                total_loss += float(loss.item())
                total_tokens += tokens
                count += len(records)
    finally:
        model.train(previous_mode)
        restore_rng_state(saved_rng)
    return {"status": "measured", "mean_token_loss": total_loss / total_tokens,
            "examples": count, "loss_tokens": total_tokens, "independent_evaluation": False}


def _validate_resume_state(state: Any, samplers: dict, saved_samplers: Any,
                           plan: CurriculumPlan, unique_tokens: int, budget: int) -> None:
    required = {"step", "processed_tokens", "unique_dataset_tokens", "stage_index", "stage_tokens", "loss_tokens"}
    if not isinstance(state, dict) or set(state) != required:
        raise TrainingError("CORRUPT_CHECKPOINT", "Trainer state keys are invalid.")
    if any(type(state[key]) is not int or state[key] < 0 for key in required):
        raise TrainingError("CORRUPT_CHECKPOINT", "Trainer counters must be nonnegative integers.")
    if (state["unique_dataset_tokens"] != unique_tokens or state["processed_tokens"] > budget
            or state["stage_index"] > len(plan.stages)
            or state["loss_tokens"] > state["processed_tokens"]):
        raise TrainingError("RESUME_INCOMPATIBLE", "Dataset counters or curriculum position differ.")
    if state["stage_index"] < len(plan.stages) and state["stage_tokens"] > plan.stages[state["stage_index"]].processed_tokens:
        raise TrainingError("CORRUPT_CHECKPOINT", "Stage token counter exceeds its allocation.")
    if not isinstance(saved_samplers, dict) or set(saved_samplers) != set(samplers):
        raise TrainingError("RESUME_INCOMPATIBLE", "Curriculum sampler set differs.")
    for name, sampler in samplers.items():
        sampler.load_state_dict(saved_samplers[name])


def _train(*, config: TrainingConfig, dataset: PreparedDataset,
          evidence_resolver: EvidenceResolver, privacy_policy: PrivacyPolicy,
          curriculum: CurriculumPlan, tokenizer: TokenizerAdapter,
          model_factory: ModelFactory, output_directory: str | Path,
          trusted_resume: bool = False, resume_sha256: str | None = None,
          stop_requested: Callable[[], bool] | None = None,
          handle_signals: bool = True, optimizer_step_limit: int | None = None,
          temperature_reader: Callable[[], float | None] | None = None) -> dict:
    """Train only when explicitly called; returns measurements from this invocation.

    A trusted host must provide factory, tokenizer, evidence store and output path.
    Checkpoint trust is an explicit invocation choice, never inferred from a file.
    optimizer_step_limit bounds opt-in profiling; it does not alter the token
    schedule, and resuming continues the original configured token budget.
    """
    import torch
    config.validate()
    if optimizer_step_limit is not None and (type(optimizer_step_limit) is not int or optimizer_step_limit < 1):
        raise TrainingError("INVALID_CONFIGURATION", "Step limit must be a positive integer.")
    dataset.validate(evidence_resolver, privacy_policy)
    # Reconstruct the plan to prevent changes hidden in mutable caller data.
    curriculum = CurriculumPlan.from_dict(curriculum.to_dict())
    curriculum_payload = curriculum.to_dict()
    if sum(stage.processed_tokens for stage in curriculum.stages) != config.max_processed_tokens:
        raise TrainingError("INVALID_CURRICULUM", "Curriculum allocations must equal the configured token budget.")
    training_examples = dataset.for_split("train")
    validation_examples = dataset.for_split("validation")
    if not training_examples:
        raise TrainingError("EMPTY_TRAINING_SET", "Manifest has no training examples.")
    curriculum.validate_dataset(training_examples, dataset.manifest.dataset_version)
    enabled_stages = {stage.stage for stage in curriculum.stages}
    training_examples = tuple(item for item in training_examples if item.curriculum_stage in enabled_stages)
    validation_examples = tuple(item for item in validation_examples if item.curriculum_stage in enabled_stages)
    # Test samples are neither rendered nor encoded. Only training/validation IDs
    # enter any sampler, metrics or target construction below.
    encoded_train = {item.sample_id: encode_example(item, tokenizer, config.context_length, config.objective)
                     for item in training_examples}
    encoded_validation = tuple(encode_example(item, tokenizer, config.context_length, config.objective)
                               for item in sorted(validation_examples, key=lambda item: item.sample_id))
    unique_tokens = sum(len(item.input_ids) for item in encoded_train.values())
    samplers: dict[str, DeterministicSampler] = {}
    for index, stage in enumerate(curriculum.stages):
        eligible = curriculum.eligible_examples(training_examples, stage.stage)
        if not eligible:
            raise TrainingError("EMPTY_CURRICULUM_STAGE", "Every configured stage needs authorized training examples.")
        samplers[stage.stage] = DeterministicSampler((item.sample_id for item in eligible),
                                                    config.seed + index, dataset.identity)
    _seed(config.seed, config.deterministic_algorithms)
    precision = resolve_precision(config)
    request = ModelRequest(config.architecture_id, config.preset, config.seed,
                           tokenizer.vocabulary_size, config.context_length)
    bundle = model_factory(request)
    validate_bundle(bundle, request)
    model = bundle.model.to(device=precision.device, dtype=torch.float32)
    configure_activation_checkpointing(model, config.activation_checkpointing, bundle.activation_checkpointing_hook)
    optimizer = create_optimizer(model, config)
    scheduler = create_scheduler(optimizer, config)
    profiler = ResourceProfiler(config, precision.device, temperature_reader=temperature_reader)
    parameter_count = sum(parameter.numel() for parameter in model.parameters())
    compatibility = {
        "trainer_version": TRAINER_VERSION,
        "training_source_sha256": implementation_identity(),
        "architecture_id": bundle.architecture_id,
        "model_configuration_identity": bundle.configuration_identity,
        "factory_identity": bundle.factory_identity,
        "initialization": {"kind": "random", "seed": config.seed},
        "tokenizer_identity": tokenizer.identity_dict(),
        "dataset_manifest_identity": dataset.identity,
        "privacy_policy_identity": privacy_policy.identity(),
        "training_config_identity": config.resume_identity(),
        "curriculum_identity": digest(curriculum_payload),
        "runtime": runtime_identity(precision.device),
        "precision": precision.identity(),
    }
    output_directory = Path(output_directory)
    run_manifest = output_directory / "run-manifest.json"
    if run_manifest.exists() and config.resume_checkpoint is None:
        raise TrainingError("OUTPUT_DIRECTORY_IN_USE", "Existing run requires an explicit trusted resume or a fresh output directory.")
    atomic_json(run_manifest, {"schema_version": "execution-run-v1", "compatibility": compatibility}, immutable=True)
    session_id = uuid.uuid4().hex
    session_directory = output_directory / "sessions" / session_id
    manager = CheckpointManager(output_directory / "checkpoints",
                                min_free_disk_bytes=config.resources.min_free_disk_bytes,
                                max_checkpoint_bytes=config.resources.max_checkpoint_bytes)
    state = {"step": 0, "processed_tokens": 0, "unique_dataset_tokens": unique_tokens,
             "stage_index": 0, "stage_tokens": 0, "loss_tokens": 0}
    latest_checkpoint = None
    if config.resume_checkpoint is not None:
        payload = manager.load(config.resume_checkpoint, expected_compatibility=compatibility,
                               trusted=trusted_resume, expected_sha256=resume_sha256)
        _validate_resume_state(payload["training_state"], samplers, payload["sampler_state"],
                               curriculum, unique_tokens, config.max_processed_tokens)
        if payload["scheduler_state"].get("processed_tokens") != payload["training_state"]["processed_tokens"]:
            raise TrainingError("CORRUPT_CHECKPOINT", "Scheduler and trainer token counters differ.")
        try:
            model.load_state_dict(payload["model_state"], strict=True)
            optimizer.load_state_dict(payload["optimizer_state"])
            scheduler.load_state_dict(payload["scheduler_state"])
            precision.scaler.load_state_dict(payload["scaler_state"])
            restore_rng_state(payload["rng_state"])
        except TrainingError:
            raise
        except (RuntimeError, ValueError, KeyError, TypeError) as exc:
            raise TrainingError("RESUME_INCOMPATIBLE", "Checkpoint state cannot be restored to this training session.") from exc
        state = dict(payload["training_state"])
        latest_checkpoint = payload["loaded_checkpoint_reference"]
    optimizer.zero_grad(set_to_none=True)
    model.train()
    start_step, start_tokens = state["step"], state["processed_tokens"]
    metrics: list[dict] = []
    attempted_session_tokens = 0
    consecutive_skips = 0
    skipped_windows = 0
    last_validation: dict = {"status": "not_run", "independent_evaluation": False}
    status, failure_code = "running", None

    def save_boundary() -> None:
        nonlocal latest_checkpoint
        profiler.check_limits()
        started = time.perf_counter()
        payload = {
            "compatibility": compatibility, "model_state": model.state_dict(),
            "optimizer_state": optimizer.state_dict(), "scheduler_state": scheduler.state_dict(),
            "scaler_state": precision.scaler.state_dict(), "rng_state": capture_rng_state(),
            "training_state": dict(state),
            "sampler_state": {name: sampler.state_dict() for name, sampler in samplers.items()},
            "training_config": config.to_dict(),
            "accumulation_state": {"microsteps": 0, "pending_tokens": 0},
        }
        latest_checkpoint = manager.save(payload, step=state["step"],
                                         processed_tokens=state["processed_tokens"]).to_dict()
        profiler.record_checkpoint(time.perf_counter() - started)

    try:
        # A clean initial recovery point exists even before the first update.
        if config.resume_checkpoint is None:
            save_boundary()
        with graceful_signals(handle_signals) as interruption:
            while state["processed_tokens"] < config.max_processed_tokens:
                if interruption.requested or (stop_requested is not None and stop_requested()):
                    status = "interrupted"
                    break
                if optimizer_step_limit is not None and state["step"] - start_step >= optimizer_step_limit:
                    status = "step_limit_reached"
                    break
                if state["stage_index"] == len(curriculum.stages):
                    status = "curriculum_complete"
                    break
                profiler.check_limits()
                stage = curriculum.stages[state["stage_index"]]
                sampler = samplers[stage.stage]
                capacity = min(stage.processed_tokens - state["stage_tokens"],
                               config.max_processed_tokens - state["processed_tokens"])
                window: list = []
                window_tokens = 0
                for sample_id in sampler.peek(config.microbatch_size * config.gradient_accumulation_steps):
                    record = encoded_train[sample_id]
                    if window_tokens + len(record.input_ids) > capacity:
                        break
                    window.append(record)
                    window_tokens += len(record.input_ids)
                if not window:
                    # Whole examples only. A residual shorter than the next example
                    # is explicitly left unused; no target is silently truncated.
                    state["stage_index"] += 1
                    state["stage_tokens"] = 0
                    continue
                target_tokens = sum(sum(label != -100 for label in record.labels[1:]) for record in window)
                if target_tokens == 0:
                    raise TrainingError("EMPTY_TARGET", "Accumulation window has no supervised target tokens.")
                step_start = profiler.start_step()
                micro_start = time.perf_counter()
                window_loss = 0.0
                microsteps = 0
                for start in range(0, len(window), config.microbatch_size):
                    records = window[start:start + config.microbatch_size]
                    loss, _ = _loss_sum(model, collate_encoded(records, tokenizer.pad_token_id),
                                        precision, tokenizer.vocabulary_size)
                    attempted_session_tokens += sum(len(item.input_ids) for item in records)
                    window_loss += float(loss.detach().item())
                    # Normalize over ALL target tokens in the effective batch, not
                    # equally across differently sized microbatches or examples.
                    precision.scaler.scale(loss / target_tokens).backward()
                    microsteps += 1
                    profiler.check_limits()
                if config.profile_enabled and precision.device.type == "cuda":
                    torch.cuda.synchronize(precision.device)
                microbatch_seconds = time.perf_counter() - micro_start
                update_start = time.perf_counter()
                precision.scaler.unscale_(optimizer)
                if any(parameter.grad is not None and not bool(torch.isfinite(parameter.grad).all().item())
                       for parameter in model.parameters()):
                    if not precision.scaler.is_enabled():
                        raise TrainingError("NONFINITE_GRADIENT", "Nonfinite gradients; no optimizer update was authorized.")
                    # FP16 dynamic loss scaling expects occasional overflow. Skip this window without
                    # committing counters or the sampler, lower the scale, and replay the same examples.
                    # A bounded run of consecutive skips still fails, so real divergence is not hidden.
                    consecutive_skips += 1
                    skipped_windows += 1
                    if consecutive_skips > 25:
                        raise TrainingError("NONFINITE_GRADIENT", "Repeated nonfinite gradients; loss scaling cannot recover.")
                    precision.scaler.step(optimizer)  # no-op: scaler recorded the infs during unscale_
                    precision.scaler.update()
                    optimizer.zero_grad(set_to_none=True)
                    continue
                consecutive_skips = 0
                gradient_norm = torch.nn.utils.clip_grad_norm_(model.parameters(), config.gradient_clip_norm,
                                                               error_if_nonfinite=True)
                precision.scaler.step(optimizer)
                precision.scaler.update()
                # Counter/sampler commits occur only after the optimizer completed.
                sampler.commit(len(window))
                state["step"] += 1
                state["processed_tokens"] += window_tokens
                state["stage_tokens"] += window_tokens
                state["loss_tokens"] += target_tokens
                scheduler.step(state["processed_tokens"])
                optimizer.zero_grad(set_to_none=True)
                if config.profile_enabled and precision.device.type == "cuda":
                    torch.cuda.synchronize(precision.device)
                optimizer_seconds = time.perf_counter() - update_start
                profiler.end_step(step_start, window_tokens, microsteps,
                                   microbatch_seconds=microbatch_seconds, optimizer_seconds=optimizer_seconds)
                record = {"step": state["step"], "stage": stage.stage,
                          "processed_tokens": state["processed_tokens"], "loss_tokens": target_tokens,
                          "mean_token_loss": window_loss / target_tokens,
                          "gradient_norm": float(gradient_norm.item()),
                          "learning_rate_next_step": optimizer.param_groups[0]["lr"]}
                # Stream durable metadata, retaining only a bounded recent tail.
                atomic_json(session_directory / "metrics" / f"step-{state['step']:012d}.json", record, immutable=True)
                metrics.append(record)
                metrics = metrics[-100:]
                if state["step"] % config.validation_interval_steps == 0:
                    last_validation = _bounded_validation(model, encoded_validation, config, precision,
                                                           tokenizer.pad_token_id, tokenizer.vocabulary_size)
                    atomic_json(session_directory / "validation" / f"step-{state['step']:012d}.json", last_validation, immutable=True)
                if state["step"] % config.checkpoint_interval_steps == 0:
                    save_boundary()
            else:
                status = "token_budget_reached"
        save_boundary()
    except (KeyboardInterrupt, TrainingError, RuntimeError, OSError) as exc:
        # A failed optimizer call may have partially changed parameters/state.
        # Never persist that state as a resumable checkpoint; retain last durable.
        status = "interrupted" if isinstance(exc, KeyboardInterrupt) else "failed"
        if isinstance(exc, TrainingError):
            failure_code = exc.code
        elif isinstance(exc, torch.cuda.OutOfMemoryError):
            failure_code = "CUDA_OUT_OF_MEMORY"
        elif isinstance(exc, OSError):
            failure_code = "INSUFFICIENT_DISK_SPACE" if exc.errno == 28 else "LOCAL_IO_FAILURE"
        elif isinstance(exc, KeyboardInterrupt):
            failure_code = "INTERRUPTED_BETWEEN_CHECKPOINTS"
        else:
            failure_code = "TORCH_RUNTIME_FAILURE"
    report = {
        "schema_version": "execution-training-report-v1", "trainer_version": TRAINER_VERSION,
        "session_id": session_id,
        "status": status, "failure_code": failure_code,
        "compatibility": compatibility, "training_configuration": config.to_dict(),
        "curriculum": curriculum_payload, "state": state,
        "session_optimizer_steps": state["step"] - start_step,
        "session_skipped_fp16_overflow_windows": skipped_windows,
        "session_committed_training_tokens": state["processed_tokens"] - start_tokens,
        "session_successful_forward_tokens": attempted_session_tokens,
        "unspent_configured_tokens": config.max_processed_tokens - state["processed_tokens"],
        "unique_dataset_tokens": unique_tokens,
        "token_counter_definition": "nonpadding input tokens, including prompt and framing; committed optimizer windows only",
        "uncommitted_work": "failed/interrupted windows are excluded and replayed from the last durable checkpoint",
        "last_valid_checkpoint": latest_checkpoint, "recent_metrics": metrics,
        "bounded_validation": last_validation, "resources": profiler.summary(),
        "memory_estimate": memory_estimate(parameter_count, optimizer=config.optimizer),
        "evaluation_status": "not_independently_evaluated", "promotion_status": "not_promoted",
    }
    atomic_json(session_directory / "training-report.json", report, immutable=True)
    atomic_json(output_directory / "training-report.json", report)
    return report


def train(*, config: TrainingConfig, dataset: PreparedDataset,
          evidence_resolver: EvidenceResolver, privacy_policy: PrivacyPolicy,
          curriculum: CurriculumPlan, tokenizer: TokenizerAdapter,
          model_factory: ModelFactory, output_directory: str | Path,
          trusted_resume: bool = False, resume_sha256: str | None = None,
          stop_requested: Callable[[], bool] | None = None,
          handle_signals: bool = True, optimizer_step_limit: int | None = None,
          temperature_reader: Callable[[], float | None] | None = None) -> dict:
    """Explicit single-writer training entry point; never called on package import.

    Validation/setup failures raise classified TrainingError. Once training starts,
    runtime failures return a failed report and retain the previous valid checkpoint.
    A process crash may leave .training.lock; inspect it manually before removing it.
    """
    options = dict(locals())
    import torch
    config.validate()
    directory = Path(output_directory)
    directory.mkdir(parents=True, exist_ok=True)
    lock = directory / ".training.lock"
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as exc:
        raise TrainingError("TRAINING_OUTPUT_LOCKED", "Another or interrupted writer owns this output directory.") from exc
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(str(os.getpid()) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        try:
            return _train(**options)
        except torch.cuda.OutOfMemoryError as exc:
            raise TrainingError("CUDA_OUT_OF_MEMORY", "Model setup or restore exceeded CUDA memory; previous checkpoints remain untouched.") from exc
        except OSError as exc:
            code = "INSUFFICIENT_DISK_SPACE" if exc.errno == 28 or getattr(exc, "winerror", None) == 112 else "LOCAL_IO_FAILURE"
            raise TrainingError(code, "Local training I/O failed; inspect the latest durable checkpoint receipt.") from exc
    finally:
        lock.unlink(missing_ok=True)

