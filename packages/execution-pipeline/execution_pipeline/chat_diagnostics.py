"""Pinned Stage-0 diagnostics using the existing scratch SFT implementation.

The config is written before results. This module never selects new settings after
observing losses, never reads chat evaluation cases, and never runs a later stage.
"""
from __future__ import annotations

import csv
import gc
import json
import logging
import math
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time
from datetime import datetime, timezone

from . import ads_finetune as training


DEDICATED_LIMIT_MIB = 3700
SHARED_GROWTH_LIMIT_BYTES = 256 * 1024**2
MEMORY_SAMPLE_FAILURE_LIMIT = 3
MEMORY_SAMPLE_STALE_SECONDS = 90
SPEED_BASELINE_SECONDS = 60
SPEED_SAMPLE_SECONDS = 5
SLOW_SPEED_FRACTION = 0.70
SLOW_SPEED_STOP_SECONDS = 120


def now():
    return datetime.now(timezone.utc).isoformat()


def gate_interval(log, minimum=1000):
    """Owner-approved observed-point criterion; no interpolation between evals."""
    if not log or [point["step"] for point in log] != list(range(0, len(log) * 100, 100)):
        raise ValueError("Gate0 requires ordered complete evaluations at steps0,100,200,...")
    if any(not math.isfinite(point["validation_metrics"]["macro_language_answer_loss"]) for point in log):
        raise ValueError("Gate0 requires finite validation losses.")
    baseline = log[0]["validation_metrics"]["macro_language_answer_loss"]
    first = None
    for point in log[1:]:
        step = point["step"]
        value = point["validation_metrics"]["macro_language_answer_loss"]
        if value < baseline:
            first = step if first is None else first
            if step - first >= minimum:
                return {"passed": True, "start_step": first, "end_step": step, "baseline": baseline}
        else:
            first = None
    return {"passed": False, "baseline": baseline, "last_contiguous_start": first}


class GpuJob:
    """One owned GPU lock, Windows per-process shared memory, fail-closed monitor."""
    def __init__(self, root, output, stage="0.1", max_seconds=5400):
        self.lock = root / "artifacts/chat-training/v4/gpu.lock"
        self.output = output
        self.stop = threading.Event()
        self.problem = None
        self.samples = []
        self.thread = None
        self.shared_baseline_bytes = None
        self._last_good_memory_sample = None
        self.speed_run = None
        self.started = time.perf_counter()
        self.max_seconds = max_seconds
        self.token = {"agent": "roleB", "stage": stage, "start_time": now(), "pid": os.getpid()}

    def __enter__(self):
        query = subprocess.check_output(["nvidia-smi", "--query-gpu=name,memory.total,memory.used,utilization.gpu",
                                        "--format=csv,noheader,nounits"], text=True).strip()
        if self.lock.exists():
            raise RuntimeError("GPU lock already exists; no job started.")
        compute = subprocess.check_output(["nvidia-smi", "--query-compute-apps=pid,process_name",
                                           "--format=csv,noheader,nounits"], text=True).strip()
        used, utilization = map(int, query.split(",")[2:4])
        # WDDM reports the desktop's C+G Codex UI here, even at idle. Only that
        # observed app is allowed; every other listed process blocks the job.
        other_compute = [line for line in compute.splitlines()
                         if not ("\\OpenAI.Codex_" in line and line.endswith("\\app\\ChatGPT.exe"))]
        if other_compute or used > 256 or utilization > 5:
            raise RuntimeError(f"GPU has compute activity or nontrivial memory use; no job started: {query}; {compute}")
        with self.lock.open("x", encoding="utf-8") as stream:
            json.dump(self.token, stream)
        training._atomic_json(self.output / "gpu-start.json", {"nvidia_smi": query, "compute_apps": compute, **self.token})
        return self

    def start_monitor(self):
        # Establish once after CUDA initialization and before model allocation.
        self._sample(establish_baseline=True)
        self.check()
        self._last_good_memory_sample = time.perf_counter()
        self.thread = threading.Thread(target=self._monitor, daemon=True)
        self.thread.start()

    def _sample(self, establish_baseline=False):
        command = (
            f"$s=Get-Counter '\\GPU Process Memory(pid_{os.getpid()}*)\\Shared Usage',"
            f"'\\GPU Process Memory(pid_{os.getpid()}*)\\Dedicated Usage' -ErrorAction Stop; "
            "$s.CounterSamples | Select-Object Path,CookedValue | ConvertTo-Json -Compress"
        )
        raw = subprocess.check_output(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
                                      text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), timeout=20)
        cells = json.loads(raw)
        if isinstance(cells, dict):
            cells = [cells]
        if not cells or not all(f"pid_{os.getpid()}_" in item["Path"].lower() for item in cells):
            raise RuntimeError("GPU counters must identify only this training process.")
        if not any(item["Path"].lower().endswith("shared usage") for item in cells) or not any(
                item["Path"].lower().endswith("dedicated usage") for item in cells):
            raise RuntimeError("Both dedicated and shared process counters are required.")
        shared = sum(item["CookedValue"] for item in cells if item["Path"].lower().endswith("shared usage"))
        dedicated = sum(item["CookedValue"] for item in cells if item["Path"].lower().endswith("dedicated usage"))
        smi = subprocess.check_output(["nvidia-smi", "--query-gpu=memory.used,memory.total,temperature.gpu,utilization.gpu",
                                       "--format=csv,noheader,nounits"], text=True).strip()
        used, total, temperature, utilization = map(int, smi.split(","))
        if establish_baseline:
            if self.shared_baseline_bytes is not None or self.samples:
                raise RuntimeError("Shared-memory baseline cannot be recalibrated within a job.")
            self.shared_baseline_bytes = shared
        if self.shared_baseline_bytes is None:
            raise RuntimeError("Shared-memory baseline must precede model/task allocation.")
        delta = shared - self.shared_baseline_bytes
        record = {"time": now(), "pid": os.getpid(), "shared_bytes": shared, "dedicated_bytes": dedicated,
                  "shared_baseline_bytes": self.shared_baseline_bytes, "shared_delta_bytes": delta,
                  "process_counter_paths": [item["Path"] for item in cells],
                  "gpu_used_mib": used, "gpu_total_mib": total, "temperature_c": temperature, "utilization": utilization}
        self.samples.append(record)
        if used >= DEDICATED_LIMIT_MIB and delta > SHARED_GROWTH_LIMIT_BYTES:
            self.problem = self.problem or (
                f"GPU memory stop: shared_bytes={shared}, baseline={self.shared_baseline_bytes}, "
                f"delta={delta}, dedicated={used}/{total} MiB"
            )
        self._append_memory_log(record)

    def _append_memory_log(self, record):
        with (self.output / "gpu-memory.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record) + "\n")

    def start_training(self, name):
        """Start a fresh speed baseline for an independent training run."""
        self.check()
        self.speed_run = name
        self.speed_baseline = None
        self.active_training_seconds = 0
        self.speed_window_seconds = 0
        self.speed_window_tokens = 0
        self.consecutive_slow_seconds = 0

    def record_training_update(self, tokens, elapsed_seconds):
        """Measure throughput during optimizer updates, excluding evaluation and saves."""
        self.check()
        if self.speed_run is None:
            raise RuntimeError("Start the training speed baseline before reporting updates.")
        if elapsed_seconds <= 0:
            return
        # Allocate an update's work proportionally if it crosses a sample boundary.
        update_rate = tokens / elapsed_seconds
        remaining_seconds = elapsed_seconds
        while remaining_seconds > 0:
            window = SPEED_BASELINE_SECONDS if self.speed_baseline is None else SPEED_SAMPLE_SECONDS
            available = window - self.speed_window_seconds
            seconds = min(available, remaining_seconds)
            self.speed_window_seconds += seconds
            self.speed_window_tokens += update_rate * seconds
            remaining_seconds -= seconds
            if seconds < available:
                break
            self.active_training_seconds += window
            rate = self.speed_window_tokens / window
            if self.speed_baseline is None:
                self.speed_baseline = rate
            elif rate < self.speed_baseline * SLOW_SPEED_FRACTION:
                self.consecutive_slow_seconds += window
            else:
                self.consecutive_slow_seconds = 0
            record = {"time": now(), "run": self.speed_run, "active_training_seconds": self.active_training_seconds,
                      "tokens_per_second": rate, "first_minute_tokens_per_second": self.speed_baseline,
                      "consecutive_slow_seconds": self.consecutive_slow_seconds}
            with (self.output / "training-speed.jsonl").open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(record) + "\n")
            if self.consecutive_slow_seconds >= SLOW_SPEED_STOP_SECONDS:
                self.problem = self.problem or (
                    f"GPU speed stop: {rate:.2f} tokens/s versus first-minute {self.speed_baseline:.2f} tokens/s "
                    f"for {self.consecutive_slow_seconds} training seconds"
                )
            self.check()
            self.speed_window_seconds = 0
            self.speed_window_tokens = 0

    def _monitor(self):
        consecutive_failures = 0
        while not self.stop.wait(5):
            self._check_memory_sample_age(time.perf_counter())
            if self.problem:
                return
            try:
                self._sample()
            except Exception as error:
                consecutive_failures += 1
                self._check_memory_sample_age(time.perf_counter())
                if consecutive_failures >= MEMORY_SAMPLE_FAILURE_LIMIT:
                    self.problem = self.problem or (
                        f"GPU memory monitor failed {consecutive_failures} consecutive samples: {error}"
                    )
                try:
                    self._append_memory_log({"time": now(), "pid": os.getpid(), "sample_error": str(error)})
                except OSError as log_error:
                    logging.getLogger(__name__).warning("Could not log GPU sample error %s: %s", error, log_error)
            else:
                sampled_at = time.perf_counter()
                self._check_memory_sample_age(sampled_at)
                self._last_good_memory_sample = sampled_at
                consecutive_failures = 0
            if self.problem:
                return

    def _check_memory_sample_age(self, timestamp):
        last_good = self._last_good_memory_sample
        if last_good is not None and timestamp - last_good >= MEMORY_SAMPLE_STALE_SECONDS:
            self.problem = self.problem or (
                f"GPU memory monitor failed: no successful sample for {MEMORY_SAMPLE_STALE_SECONDS} seconds"
            )

    def check(self):
        timestamp = time.perf_counter()
        self._check_memory_sample_age(timestamp)
        if not self.problem and timestamp - self.started >= self.max_seconds:
            self.problem = f"GPU Stage {self.token['stage']} bounded runtime reached {self.max_seconds} seconds."
        if self.problem:
            raise RuntimeError(self.problem)

    def __exit__(self, *_):
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=25)
        training._atomic_json(self.output / "gpu-summary.json", {
            "samples": len(self.samples), "problem": self.problem,
            "peak_dedicated_mib": max((s["gpu_used_mib"] for s in self.samples), default=None),
            "peak_process_dedicated_bytes": max((s["dedicated_bytes"] for s in self.samples), default=None),
            "shared_baseline_bytes": self.shared_baseline_bytes,
            "peak_shared_delta_bytes": max((s["shared_delta_bytes"] for s in self.samples), default=None),
            "peak_shared_bytes": max((s["shared_bytes"] for s in self.samples), default=None),
            "end_time": now()})
        if self.lock.exists() and json.loads(self.lock.read_text(encoding="utf-8")) == self.token:
            self.lock.unlink()


def historical_audit(config, output, guard):
    import torch
    for item in config["historical_audits"]:
        guard.check()
        run, dataset = Path(item["run"]), Path(item["dataset"])
        model, tokenizer, model_config = training._load_pretrained(run, "cuda", Path(item["checkpoint"]))
        model.register_forward_pre_hook(lambda *_: guard.check())
        encoder = training.TextEncoder(run)
        records = training.load_split("validation", dataset)
        rows = [training.encode_pair(encoder, record) for record in records]
        if any(len(ids) > model_config.max_context_length for ids, _ in rows):
            raise ValueError("Historical validation exceeds context; stop instead of changing the original denominator.")
        groups = training._balanced_language_groups(records, "validation")
        metrics = training._balanced_validation_metrics(model, rows, groups, tokenizer.pad_token_id, "cuda", 2)
        sources = training._source_validation_metrics(model, rows, records, tokenizer.pad_token_id, "cuda", 2)
        train_records = training.load_split("train", dataset)
        selected, counts = [], {}
        for record in sorted(train_records, key=lambda record: str(record.get("id", ""))):
            key = (record.get("source"), record.get("language"))
            if counts.get(key, 0) < 32:
                selected.append(record)
                counts[key] = counts.get(key, 0) + 1
        train_rows = [training.encode_pair(encoder, record) for record in selected]
        train_sources = training._source_validation_metrics(model, train_rows, selected, tokenizer.pad_token_id, "cuda", 2)
        training._atomic_json(output / (item["name"] + ".json"), {
            "configuration": item, "checkpoint_sha256": training._sha256(run / item["checkpoint"]),
            "dataset_validation_sha256": training._sha256(dataset / "validation.jsonl"),
            "validation_metrics": metrics, "validation_by_source_language": sources,
            "fixed_training_sample_by_source_language": train_sources,
            "fixed_training_sample_rule": "First up to32 IDs per source-language in sorted ID order; not population estimate"})
        del model
        gc.collect()
        torch.cuda.empty_cache()


def run_stage_zero(config_path):
    import torch
    config_path = config_path.resolve()
    config = json.loads(config_path.read_text(encoding="utf-8"))
    output, run = Path(config["output"]), Path(config["run"])
    if (output / "started.json").exists():
        raise FileExistsError("This fixed experiment was already started; no retry.")
    output.mkdir(parents=True, exist_ok=True)
    run.mkdir(parents=True, exist_ok=False)
    root = Path(config["root"])
    base_run = Path(config["base_run"])
    for filename, expected in config["input_sha256"].items():
        if training._sha256(Path(filename)) != expected:
            raise RuntimeError(f"Predeclared input changed: {filename}")
    for filename, expected in config["code_sha256"].items():
        if training._sha256(root / filename) != expected:
            raise RuntimeError(f"Predeclared code changed: {filename}")
    for name in ("tokenizer.json", "tokenizer-report.json"):
        shutil.copy2(base_run / name, run / name)
    (run / "foundation").mkdir()
    shutil.copy2(base_run / config["base_checkpoint"], run / "foundation/best.pt")
    training._atomic_json(run / "foundation/manifest.json", {
        "origin": "copy_of_own_scratch_foundation_not_new_training", "source": str(base_run / config["base_checkpoint"]),
        "checkpoint_sha256": training._sha256(run / "foundation/best.pt"),
        "processed_tokens": 32006144, "language_tokens": {"ar": 23990272, "en": 8015872},
        "rows": None, "row_definition": "Language pretraining used packed token streams", "code_sha256": config["code_sha256"]})
    training._atomic_json(output / "started.json", {"time": now(), "config_sha256": training._sha256(config_path)})
    torch.set_num_threads(4)
    results = []
    try:
        with GpuJob(root, output) as guard:
            torch.empty(1, device="cuda")
            guard.start_monitor()
            historical_audit(config, output, guard)
            for experiment in config["experiments"]:
                guard.start_training(experiment["name"])
                print(json.dumps({"starting": experiment, "time": now()}), flush=True)
                result = training.finetune(run, **config["common"], **experiment["options"],
                    out_name=experiment["name"], data_dir=Path(config["dataset"]),
                    base_checkpoint=Path("foundation/best.pt"), progress_check=guard.check,
                    training_update=guard.record_training_update)
                folder = run / experiment["name"]
                log = [json.loads(line) for line in (folder / "log.jsonl").read_text().splitlines()]
                criterion = gate_interval(log) if experiment["eligible"] else {"eligible": False}
                manifest = {"configuration": experiment, "settings": json.loads((folder / "settings.json").read_text()),
                    "rows": {"train": 11324, "validation": 445},
                    "result": result, "measured_gate_interval": criterion,
                    "files": {name: training._sha256(folder / name) for name in
                        ("best.pt", "last.pt", "log.jsonl", "settings.json", "step-zero-equivalence.json")},
                    "code_sha256": {str(path.relative_to(root)): training._sha256(path) for path in
                        (Path(__file__), Path(training.__file__), root / "packages/execution-model/execution_model/model.py")}}
                training._atomic_json(folder / "manifest.json", manifest)
                results.append({"name": experiment["name"], "eligible": experiment["eligible"], **criterion, "result": result})
                training._atomic_json(output / "results-progress.json", results)
                gc.collect()
                torch.cuda.empty_cache()
                print(json.dumps({"finished": experiment["name"], "criterion": criterion}), flush=True)
            guard.check()
        training._atomic_json(output / "results.json", {"experiments": results,
            "gate0": "not_decided_cause_analysis_required", "completed_at": now()})
        return results
    except BaseException as error:
        training._atomic_json(output / "failure.json", {"time": now(), "type": type(error).__name__, "error": str(error),
                                                       "completed_experiments": results})
        raise
