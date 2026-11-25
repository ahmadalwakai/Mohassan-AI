"""Fit, calibrate and package a single head without opening sealed cases."""

from __future__ import annotations

import json
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime
from pathlib import Path

from . import REPOSITORY_ROOT
from .calibration import fit_calibration
from .config import Job, OwnerSource, Pin, ScheduleConfig, TrunkPins, digest, integer, nonempty, obj
from .datasets import Example, load_dataset
from .encoding import TextEncoder, encode_input
from .export import HeadExport, export_head, write_worker_config
from .foundation import foundation_pins, read_json, sha256_file, verify_pin
from .gates import write_gate_packet
from .lineage import verify_corpus_lineage
from .model import HeadModel, load_trunk
from .owner_data import read_owner_source
from .scheduler import TrainingGuard
from .splits import SealedReference, read_sealed_reference, split_examples
from .training import EncodedExample, TrainingConfig, predict, train


def _json(path: Path, record: Mapping[str, object]) -> None:
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(record, stream, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False, default=str)
        stream.write("\n")


def _counts(rows: Sequence[Example]) -> dict[str, int]:
    return dict(sorted(Counter(row.language for row in rows).items()))


def _code_pins(root: Path) -> dict[str, str]:
    paths = (
        *sorted(Path(__file__).resolve().parent.glob("*.py")),
        *sorted((root / "packages/execution-model/execution_model").glob("*.py")),
        root / "packages/execution-pipeline/execution_pipeline/pretrain.py",
        root / "packages/execution-pipeline/execution_pipeline/chat_diagnostics.py",
        root / "scripts/agent-capability-bench/v2/exclusion.py",
    )
    return {path.relative_to(root).as_posix(): sha256_file(path) for path in paths if path.is_file()}


def _load_rows(job: Job, cache: Path, custody: set[Path]) -> tuple[list[Example], list[dict[str, object]]]:
    examples: list[Example] = []
    sources: list[dict[str, object]] = []
    for source in job.sources:
        if isinstance(source, OwnerSource):
            if custody & {source.path.path, source.card.path}:
                raise ValueError("Sealed cases cannot supply fitting rows or a data card.")
            rows, provenance = read_owner_source(source, job.task)
            examples.extend(rows)
            sources.append(provenance)
            continue
        dataset = load_dataset(source.name, source.task, cache)
        labels = source.label_map
        missing: set[str] = set()
        selected = 0
        for row in dataset.examples:
            label = row.label
            if labels is not None:
                if label is None:
                    raise ValueError("Label maps require classification examples.")
                if label not in labels:
                    missing.add(label)
                    continue
                label = labels[label]
                if label is None:
                    continue
            examples.append(replace(row, task=job.task, label=label))
            selected += 1
        if missing:
            raise ValueError(f"{source.name} label map is missing: {', '.join(sorted(missing))}.")
        sources.append({"card": asdict(dataset.card), "fingerprint": dataset.fingerprint,
                        "provenance": [asdict(item) for item in dataset.provenance],
                        "loader_sha256": dataset.loader_sha256, "catalog_sha256": dataset.catalog_sha256,
                        "label_map": labels, "selected_rows": selected, "source_rows": dataset.exclusion.input_rows})
    return examples, sources


def _labels(job: Job, training: Sequence[Example]) -> tuple[str, ...] | None:
    if job.kind != "classification":
        return None
    observed = {row.label for row in training if row.label is not None}
    labels = job.labels or tuple(sorted(observed))
    if set(labels) != observed:
        raise ValueError("The explicit taxonomy must match labels represented in training.")
    if not 2 <= len(labels) <= 256:
        raise ValueError("Training needs 2–256 distinctly represented class labels.")
    return labels


def _encode_rows(
    rows: Sequence[Example],
    job: Job,
    encoder: TextEncoder,
    eos: int,
    labels: tuple[str, ...] | None,
) -> tuple[list[EncodedExample], dict[str, dict[str, int]]]:
    encoded: list[EncodedExample] = []
    used: Counter[str] = Counter()
    omitted: Counter[str] = Counter()
    label_indexes = {label: index for index, label in enumerate(labels or ())}
    for row in rows:
        if labels is not None:
            if row.label not in label_indexes or row.candidates or row.gold:
                raise ValueError("Classification examples must use the fitted taxonomy and carry no candidate labels.")
            if job.task == "sufficiency":
                if not row.history:
                    raise ValueError("Sufficiency examples require evidence in history.")
                question_width = len(encoder.encode(row.text))
                evidence_width = sum(len(encoder.encode(evidence)) + 1 for evidence in row.history)
                if question_width > job.max_tokens // 2 or question_width + evidence_width + 1 > job.max_tokens:
                    # Human answerability labels apply to the complete evidence.
                    omitted[row.language] += 1
                    continue
            inputs = encode_input(encoder, row.text, eos_token_id=eos, max_tokens=job.max_tokens, history=row.history)
            encoded.append(EncodedExample(inputs.input_ids, class_index=label_indexes[row.label]))
        else:
            if not row.candidates or not row.gold or row.label is not None:
                raise ValueError("Selection examples require candidates and one or more gold indices.")
            inputs = encode_input(encoder, row.text, eos_token_id=eos, max_tokens=job.max_tokens,
                                  history=row.history, candidates=row.candidates)
            gold = tuple(index for index, original in enumerate(inputs.candidate_indices) if original in row.gold)
            if not gold or len(inputs.candidate_indices) < 2 or (
                job.kind == "pairwise" and len(gold) == len(inputs.candidate_indices)
            ):
                # Keep the same label-blind context policy at fitting and inference.
                # Report how many examples this leaves unusable in every partition.
                omitted[row.language] += 1
                continue
            encoded.append(EncodedExample(inputs.input_ids, candidate_positions=inputs.candidate_positions, gold=gold))
        used[row.language] += 1
    return encoded, {"used": dict(sorted(used.items())), "omitted": dict(sorted(omitted.items()))}


@dataclass(frozen=True)
class JobResult:
    record: dict[str, object]
    exported: HeadExport
    tokenizer_id: str
    eos: int


def _worker_config(path: Path, exported: Mapping[str, HeadExport], tokenizer_id: str, eos: int) -> str:
    checkpoint = next(iter(exported.values()))
    return write_worker_config(path, heads=exported, checkpoint=checkpoint.checkpoint,
                               checkpoint_sha256=checkpoint.checkpoint_sha256,
                               tokenizer_identity=tokenizer_id, eos_token_id=eos)


def _run_job(
    job: Job,
    output: Path,
    pins: TrunkPins,
    settings: ScheduleConfig,
    sealed: SealedReference | None,
    custody: set[Path],
    guard: TrainingGuard | None,
    command: Sequence[str],
    run_provenance: dict[str, object],
) -> JobResult:
    started = datetime.now(UTC).isoformat()
    config = TrainingConfig(device=settings.device, **job.training)
    rows, sources = _load_rows(job, settings.dataset_cache, custody)
    splits = split_examples(rows, seed=config.seed, sealed=sealed)
    labels = _labels(job, splits.train)
    trunk, encoder = load_trunk(
        pins.checkpoint.path, pins.checkpoint.sha256, pins.tokenizer.path, pins.tokenizer.sha256,
        tokenizer_report_sha256=pins.tokenizer_report.sha256 if pins.tokenizer_report else None,
    )
    if job.max_tokens > trunk.config.max_context_length:
        raise ValueError(f"{job.name} max_tokens exceeds the pinned trunk context length.")
    eos = encoder.tokenizer.eos_token_id
    pad = encoder.tokenizer.pad_token_id
    encoded = {}
    split_details: dict[str, object] = {}
    for phase, phase_rows in (("train", splits.train), ("development", splits.development),
                               ("calibration", splits.calibration)):
        encoded[phase], counts = _encode_rows(phase_rows, job, encoder, eos, labels)
        if not encoded[phase]:
            raise ValueError(f"{job.name} has no usable rows in {phase}.")
        split_details[phase] = {"counts": _counts(phase_rows), **counts}
    output.mkdir()
    model = HeadModel(trunk, kind=job.kind, num_classes=len(labels) if labels is not None else None,
                      seed=config.seed, lora_rank=job.lora_rank, lora_budget=job.lora_budget)
    result = train(model, encoded["train"], encoded["development"], config=config,
                   checkpoint_dir=output / "fit", pad_token_id=pad,
                   progress_check=guard.check if guard is not None else None,
                   training_update=guard.record_training_update if guard is not None else None)
    predicted = predict(model, encoded["calibration"], batch_size=config.batch_size, pad_token_id=pad,
                        progress_check=guard.check if guard is not None else None)
    logits, targets = zip(*predicted, strict=True)
    calibration = fit_calibration(logits, targets, min_accuracy=job.min_calibration_accuracy, bins=job.calibration_bins)
    worker_calibration = calibration.as_worker_record()
    exported = export_head(output / "sidecar", model, pins.checkpoint.path, pins.checkpoint.sha256, labels=labels)
    worker_config = output / "worker.json"
    worker_pin = _worker_config(worker_config, {job.name: exported}, encoder.tokenizer.identity, eos)
    manifest = output / "manifest.json"
    sealed_record = None if sealed is None else {
        "sha256": sealed.sha256, "receipt_sha256": sealed.receipt_sha256, "review_kind": sealed.review_kind,
    }
    inference = {"operation": "classify" if labels is not None else "select", "head": job.name,
                 "max_tokens": job.max_tokens, "labels": labels, "eos_token_id": eos,
                 "codec": "head_training.encoding.encode_input", "calibration": worker_calibration}
    _json(manifest, {
        "schema_version": 1, "head": job.name, "task": job.task, "architecture": job.kind,
        "started": started, "finished": datetime.now(UTC).isoformat(), "command": list(command),
        "sources": sources, "run": run_provenance, "trunk": asdict(pins),
        "split_fingerprints": splits.fingerprints, "splits": split_details,
        "reserved_public_rows": splits.reserved_count, "cross_split_duplicates_dropped": splits.duplicate_count,
        "sealed_reference": sealed_record,
        "training": {"config": asdict(config), "lora_rank": job.lora_rank, "lora_budget": job.lora_budget,
                     **asdict(result)},
        "calibration": {**asdict(calibration), "coverage": calibration.coverage,
                        "requested_accuracy": job.min_calibration_accuracy},
        "inference": inference, "worker": asdict(Pin(worker_config, worker_pin)),
        "artifacts": {path.relative_to(output).as_posix(): sha256_file(path)
                      for path in sorted(output.rglob("*")) if path.is_file()},
    })
    manifest_pin = sha256_file(manifest)
    gate_packet = None
    gate_state = "awaiting_owner_registration"
    if sealed is not None and job.gate is not None:
        if worker_calibration is None:
            gate_state = "calibration_no_accepted_operating_point"
        else:
            gate_packet = register_trained_head(job, Pin(manifest, manifest_pin), output / "gate", command)
            gate_state = "registered_for_evaluator"
    return JobResult({"manifest": str(manifest), "manifest_sha256": manifest_pin, "worker": str(worker_config),
                      "worker_sha256": worker_pin, "gate_state": gate_state,
                      "gate_registration": str(gate_packet) if gate_packet else None},
                     exported, encoder.tokenizer.identity, eos)


def job_callback(
    settings: ScheduleConfig, root: Path, config_pin: Pin, command: Sequence[str],
) -> Callable[[str, Path, TrainingGuard | None], dict[str, object]]:
    """Build a per-schedule callback, sharing provenance and the frozen worker configuration."""
    jobs = {job.name: job for job in settings.jobs}
    pins: TrunkPins | None = None
    sealed: dict[str, SealedReference] = {}
    custody: set[Path] = set()
    provenance: dict[str, object] = {}
    shared: dict[str, HeadExport] = {}

    def fit(name: str, output: Path, guard: TrainingGuard | None) -> dict[str, object]:
        nonlocal pins
        if pins is None:
            pins = settings.trunk or foundation_pins(root)
            sealed.update({job.name: read_sealed_reference(job.gate.sealed_reference)
                           for job in jobs.values() if job.gate is not None})
            custody.update(reference.path.resolve() for reference in sealed.values())
            if custody & {pins.checkpoint.path, pins.tokenizer.path, config_pin.path} or (
                pins.tokenizer_report is not None and pins.tokenizer_report.path in custody
            ):
                raise ValueError("Sealed files cannot be checkpoint, tokenizer or configuration inputs.")
            provenance.update(config=asdict(config_pin), code_sha256=_code_pins(REPOSITORY_ROOT))
            if settings.corpus_lineage is not None:
                corpus = settings.corpus_lineage
                if custody & {corpus.manifest, corpus.review, *(p.resolve() for p in corpus.manifest.parent.glob("*.jsonl"))}:
                    raise ValueError("Sealed cases cannot be corpus review records.")
                provenance["reviewed_corpus"] = verify_corpus_lineage(corpus.checkout, corpus.manifest, corpus.review)
        result = _run_job(jobs[name], output, pins, settings, sealed.get(name), custody, guard, command, provenance)
        if result.exported.checkpoint_sha256 == pins.checkpoint.sha256:
            shared[name] = result.exported
        if name == settings.jobs[-1].name and shared:
            path = output.parent / "model-worker.json"
            result.record["shared_worker_sha256"] = _worker_config(path, shared, result.tokenizer_id, result.eos)
            result.record["shared_worker"] = str(path)
        return result.record

    return fit


def register_trained_head(
    job: Job, manifest_pin: Pin, output: Path, command: Sequence[str],
) -> Path:
    """Register an existing immutable export for an independent evaluator."""
    if job.gate is None:
        raise ValueError(f"Job {job.name} needs gate settings in its schedule configuration.")
    sealed = read_sealed_reference(job.gate.sealed_reference)
    if manifest_pin.path.resolve() == sealed.path.resolve():
        raise ValueError("Sealed cases cannot be read as a head manifest.")
    verify_pin(manifest_pin)
    manifest = read_json(manifest_pin.path)
    if manifest.get("schema_version") != 1 or manifest.get("head") != job.name or manifest.get("task") != job.task:
        raise ValueError("Job does not match the pinned head manifest.")
    prior = manifest.get("sealed_reference")
    if prior is not None:
        if obj(prior, "prior sealed reference").get("receipt_sha256") != sealed.receipt_sha256:
            raise ValueError("The head was fitted with a different sealed receipt.")
    elif sealed.excluded_group_sha256:
        raise ValueError("Public group exclusions must be provided before fitting. Use an independent sealed set.")
    inference = obj(manifest.get("inference"), "inference record")
    if inference.get("calibration") is None:
        raise ValueError("The fitted head has no accepted calibration operating point.")
    worker = obj(manifest.get("worker"), "worker pin")
    calibration = obj(manifest.get("calibration"), "calibration record")
    worker_pin = Pin(Path(nonempty(worker.get("path"), "worker path")), digest(worker.get("sha256")))
    if worker_pin.path.resolve() == sealed.path.resolve():
        raise ValueError("Sealed cases cannot be worker inputs.")
    verify_pin(worker_pin)
    return write_gate_packet(
        output, head=job.name, sealed=sealed, candidate=manifest_pin.path, candidate_sha256=manifest_pin.sha256,
        baseline=job.gate.baseline.path, baseline_sha256=job.gate.baseline.sha256,
        extra_rule=job.gate.rule, ece_bins=integer(calibration.get("bins"), "calibration bins", 2),
        max_ece=job.gate.max_ece, router=job.task == "route", command=command,
        evaluation={**inference, "worker": {"path": str(worker_pin.path), "sha256": worker_pin.sha256}},
    )
