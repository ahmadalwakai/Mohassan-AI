"""Plan v5 (docs/CHAT-MODEL-TRAINING-PLAN.md section 8): the conversation-first 85M foundation run.

prepare   Pin the corpus, the Gate A receipt, the shape, the code and every setting in one config. CPU only.
check     Verify every pin; loads no model.
run       Fresh 85M weights through the existing pilot path of language_adaptation.adapt, under the GpuJob
          guard (chat-training lock, Rule 4 memory and speed stops, runtime budget) and the shared
          .data/gpu.lock. --minutes N pauses after a committed checkpoint: the resume test.
snapshot  Copy one committed milestone checkpoint into its own folder, for CPU probe generation (Gate B),
          without touching the running job.
export    Publish the best checkpoint of a finished run as the single Gate 3 candidate.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import ctypes
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline import REPOSITORY_ROOT as ROOT  # noqa: E402
from execution_pipeline.ads_finetune import _atomic_json, _sha256  # noqa: E402
from execution_pipeline.chat_diagnostics import GpuJob  # noqa: E402
from execution_pipeline.language_adaptation import PilotSettings, adapt, corpus_manifest  # noqa: E402
from execution_pipeline.pretrain import TextEncoder  # noqa: E402
from execution_model.config import ModelConfig  # noqa: E402

CAMPAIGN = ROOT / "artifacts/chat-training/v5/foundation-20261123"
RUN = ROOT / "artifacts/execution-model-runs/text-b5-2026-11-23"
CORPUS = ROOT / "artifacts/corpora/foundation-v5/corpus-20261123b"
GATE_A = ROOT / "artifacts/chat-training/v5/gate-a-20261123/assessment.json"
# Gate A failed on 2026-11-23; the owner then allowed this data for the foundation stage only («تجربة محدودة»).
GATE_A_OVERRIDE = ROOT / "artifacts/chat-training/v5/gate-a-20261123/owner-override.json"
TOKENIZER_RUN = ROOT / "artifacts/execution-model-runs/text-b3-ar-2026-11-15"
BENCHMARK = ROOT / "artifacts/chat-training/v4/stage-0-3-guardclarified-20261116/config.json"
SHARED_GPU_LOCK = ROOT / ".data/gpu.lock"
SCRIPT = Path(__file__).resolve()
SHAPE = "85m"
# One full 85M checkpoint (weights and optimizer) is about 1 GB, scaled from v4's 459 MB at 38M; every 100M keeps
# the run near 10 GB on a disk with about 31 GB free (measured 2026-11-23).
INTERVAL = 100_000_000
TARGET = 1_000_000_000
MILESTONES = tuple(range(INTERVAL, TARGET + 1, INTERVAL))
SEED = 1729
PLATEAU = 200_000_000  # two evaluations without a better validation loss
RUNTIME_LIMIT_SECONDS = 72 * 3600
CODE = (
    SCRIPT,
    ROOT / "packages/execution-pipeline/execution_pipeline/language_adaptation.py",
    ROOT / "packages/execution-pipeline/execution_pipeline/pretrain.py",
    ROOT / "packages/execution-pipeline/execution_pipeline/ads_finetune.py",
    ROOT / "packages/execution-pipeline/execution_pipeline/chat_diagnostics.py",
    *sorted((ROOT / "packages/execution-model/execution_model").glob("*.py")),
)


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def checked(path: Path, digest: str):
    if _sha256(path) != digest:
        raise ValueError(f"Pinned v5 input changed: {path}")


def relative(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def gate_a():
    """Gate A passed for this corpus, or the owner's foundation-only override bound to this corpus and that verdict."""
    if not GATE_A.exists():
        raise ValueError(f"No Gate A receipt at {GATE_A}; the corpus has not been judged, so no GPU time for v5.")
    receipt = read(GATE_A)
    corpus_sha = _sha256(CORPUS / "manifest.json")
    if receipt.get("gate_a_passed") is True and receipt.get("corpus_manifest_sha256") == corpus_sha:
        return {"gate_a_passed": True, "basis": "passed"}
    if not GATE_A_OVERRIDE.exists():
        raise ValueError("Gate A has not passed for this corpus and the owner has not overridden it; no GPU time for v5.")
    override = read(GATE_A_OVERRIDE)
    if (override.get("decision") != "foundation_only_override" or override.get("approved_in_chat") is not True
            or override.get("corpus_manifest_sha256") != corpus_sha
            or override.get("failed_assessment", {}).get("sha256") != _sha256(GATE_A)):
        raise ValueError("The Gate A override does not bind this corpus and the recorded Gate A verdict.")
    return {"gate_a_passed": False, "basis": "owner_foundation_only_override",
            "override": {"path": relative(GATE_A_OVERRIDE), "sha256": _sha256(GATE_A_OVERRIDE)}}


def prepare():
    receipt = gate_a()
    tokenizer = TextEncoder(TOKENIZER_RUN).tokenizer
    manifest = corpus_manifest(CORPUS, tokenizer.identity, 512)
    if manifest["tokenizer_sha256"] != _sha256(TOKENIZER_RUN / "tokenizer.json"):
        raise ValueError("Corpus and tokenizer run pin different tokenizer bytes.")
    shape = read(BENCHMARK)["shapes"][SHAPE]["config"]
    model = ModelConfig.from_dict(dict(shape, seed=SEED))
    if model.vocab_size != tokenizer.vocab_size or model.max_context_length != 512:
        raise ValueError("The 85M shape does not match the pinned tokenizer or context.")
    config = {
        "plan": "docs/CHAT-MODEL-TRAINING-PLAN.md section 8", "stage": "v5-2-foundation", "shape": SHAPE,
        "model_config": model.to_dict(), "model_identity": model.identity, "parameters": model.parameter_count(),
        "target_positions": TARGET, "milestones": list(MILESTONES), "checkpoint_every_tokens": INTERVAL,
        "early_stop_flat_tokens": PLATEAU, "seed": SEED, "sequence": 512, "microbatch": 2, "accumulation": 8,
        "peak_lr": 0.0002, "warmup": 100, "learning_rate_decay_tokens": TARGET, "arabic_fraction": 0.5,
        "fresh_random_initialization": True, "external_pretrained_weights": False,
        "corpus": relative(CORPUS), "corpus_manifest_sha256": _sha256(CORPUS / "manifest.json"),
        "validation_reference": relative(CORPUS),
        "gate_a": {"path": relative(GATE_A), "sha256": _sha256(GATE_A), **receipt},
        "shape_source": {"path": relative(BENCHMARK), "sha256": _sha256(BENCHMARK)},
        "code_sha256": {relative(path): _sha256(path) for path in CODE},
        "tokenizer_sha256": {name: _sha256(TOKENIZER_RUN / name) for name in ("tokenizer.json", "tokenizer-report.json")},
        "runtime_limit_seconds": RUNTIME_LIMIT_SECONDS, "holdout_accessed": False,
        "ready_for_chat": False, "phone_activated": False,
    }
    CAMPAIGN.mkdir(parents=True, exist_ok=False)
    RUN.mkdir(parents=True, exist_ok=False)
    for name in ("tokenizer.json", "tokenizer-report.json"):
        shutil.copyfile(TOKENIZER_RUN / name, RUN / name)
    _atomic_json(CAMPAIGN / "config.json", config)
    return {"config": str(CAMPAIGN / "config.json"), "sha256": _sha256(CAMPAIGN / "config.json"), "shape": SHAPE,
            "parameters": config["parameters"], "target_positions": TARGET, "gpu_started": False}


def check(config_sha: str):
    checked(CAMPAIGN / "config.json", config_sha)
    config = read(CAMPAIGN / "config.json")
    if (config["target_positions"] != TARGET or tuple(config["milestones"]) != MILESTONES
            or config["checkpoint_every_tokens"] != INTERVAL or config["early_stop_flat_tokens"] != PLATEAU
            or config["shape"] != SHAPE or config["seed"] != SEED):
        raise ValueError("v5 token limits, shape, seed or plateau policy changed.")
    for name, digest in config["code_sha256"].items():
        checked(ROOT / name, digest)
    checked(CORPUS / "manifest.json", config["corpus_manifest_sha256"])
    checked(GATE_A, config["gate_a"]["sha256"])
    if "override" in config["gate_a"]:
        checked(GATE_A_OVERRIDE, config["gate_a"]["override"]["sha256"])
    gate_a()
    checked(BENCHMARK, config["shape_source"]["sha256"])
    for name, digest in config["tokenizer_sha256"].items():
        checked(RUN / name, digest)
    model = ModelConfig.from_dict(config["model_config"])
    if model.identity != config["model_identity"]:
        raise ValueError("v5 model identity changed.")
    corpus_manifest(CORPUS, TextEncoder(RUN).tokenizer.identity, config["sequence"])
    return config, model


@contextmanager
def shared_gpu_lock(purpose: str):
    """The owner's one-job rule for every GPU user (.data/gpu.lock); a held lock stops this run instead of waiting."""
    SHARED_GPU_LOCK.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(SHARED_GPU_LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        raise RuntimeError(f"The GPU is held by another job: {SHARED_GPU_LOCK.read_text(encoding='utf-8').strip()}") from None
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump({"owner": "Claude Code, own chat model v5 (packages/execution-pipeline)", "purpose": purpose,
                   "pid": os.getpid(), "started": datetime.now(timezone.utc).isoformat()}, handle)
    try:
        yield
    finally:
        SHARED_GPU_LOCK.unlink(missing_ok=True)


def execute(config_sha: str, *, resume: bool = False, minutes: float | None = None):
    import torch
    config, model = check(config_sha)
    output = RUN / SHAPE
    if output.exists() != resume:
        raise ValueError("Use --resume exactly when the run output already exists.")
    if resume and read(output / "status.json")["status"] in ("completed", "early_stopped"):
        raise ValueError("The v5 foundation run has already finished; use export.")
    attempt = Path(tempfile.mkdtemp(prefix="attempt-", dir=CAMPAIGN))
    pilot = PilotSettings(model, CORPUS, MILESTONES, INTERVAL, attempt, config_sha, config["code_sha256"],
                          lr_decay_tokens=TARGET)
    result = failure = None
    torch.set_num_threads(4)
    awake = ctypes.windll.kernel32.SetThreadExecutionState
    if not awake(0x80000001):
        raise RuntimeError("Windows could not reserve system wakefulness.")
    try:
        prior_seconds = read(output / "status.json")["minutes"] * 60 + 1 if resume else 0
        remaining = config["runtime_limit_seconds"] - prior_seconds
        if remaining <= 0:
            raise RuntimeError("The cumulative 72-hour v5 budget is exhausted.")
        with shared_gpu_lock("v5 foundation run, 85M, 1B positions"), \
                GpuJob(ROOT, attempt, stage="v5-2-foundation", max_seconds=remaining) as guard:
            torch.empty(1, device="cuda")
            guard.start_monitor()
            result = adapt(RUN, corpus=CORPUS, out_name=SHAPE, total_tokens=TARGET, sequence=config["sequence"],
                           microbatch=config["microbatch"], accumulation=config["accumulation"],
                           peak_lr=config["peak_lr"], warmup=config["warmup"], arabic_fraction=config["arabic_fraction"],
                           seed=SEED, device="cuda", resume=resume, max_minutes=minutes, pilot=pilot, guard=guard,
                           early_stop_flat_tokens=config["early_stop_flat_tokens"])
        if result["status"] in ("completed", "early_stopped"):
            export(config_sha)
        return result
    except BaseException as error:
        failure = f"{type(error).__name__}: {error}"
        raise
    finally:
        awake(0x80000000)
        _atomic_json(attempt / "manifest.json", {"stage": "v5-2-foundation", "resumed": resume, "minutes_limit": minutes,
            "config_sha256": config_sha, "end_time": datetime.now(timezone.utc).isoformat(),
            "files": {path.relative_to(attempt).as_posix(): _sha256(path) for path in attempt.rglob("*") if path.is_file()},
            "result": result, "failure": failure})


def _publish(source: Path, destination: Path, extra: dict):
    """Copy one committed checkpoint and the run settings into a new folder the existing worker can load."""
    manifest = read(source / "manifest.json")
    checked(source / "checkpoint.pt", manifest["checkpoint_sha256"])
    if not destination.exists():
        with tempfile.TemporaryDirectory(prefix=".publish-", dir=RUN) as temporary:
            pending = Path(temporary) / destination.name
            pending.mkdir()
            shutil.copyfile(source / "checkpoint.pt", pending / "best.pt")
            shutil.copyfile(RUN / SHAPE / "settings.json", pending / "settings.json")
            checked(pending / "best.pt", manifest["checkpoint_sha256"])
            _atomic_json(pending / "manifest.json", {"source_manifest_sha256": _sha256(source / "manifest.json"),
                "files": {name: _sha256(pending / name) for name in ("best.pt", "settings.json")}, **extra})
            pending.rename(destination)
    checked(destination / "best.pt", manifest["checkpoint_sha256"])
    if read(destination / "manifest.json").get("source_manifest_sha256") != _sha256(source / "manifest.json"):
        raise ValueError(f"{destination} belongs to a different checkpoint.")
    return manifest


def snapshot(config_sha: str, tokens: int):
    check(config_sha)
    if tokens not in MILESTONES:
        raise ValueError("Snapshots are taken only at fixed milestones.")
    source = RUN / SHAPE / "checkpoints" / f"tokens-{tokens:012d}"
    manifest = _publish(source, RUN / f"snapshot-{tokens:012d}", {"config_sha256": config_sha, "positions": tokens})
    return {"finetune": f"snapshot-{tokens:012d}", "checkpoint_sha256": manifest["checkpoint_sha256"],
            "positions": tokens, "validation": manifest.get("fixed_reference_validation_loss"), "gpu_used": False}


def export(config_sha: str):
    config, _ = check(config_sha)
    status = read(RUN / SHAPE / "status.json")
    if status["status"] not in ("completed", "early_stopped"):
        raise ValueError("Only a finished v5 run may publish a Gate 3 candidate.")
    point = status["best_checkpoint_tokens"]
    source = RUN / SHAPE / "checkpoints" / f"tokens-{point:012d}"
    manifest = _publish(source, RUN / "selected", {"config_sha256": config_sha, "positions": point})
    receipt = {"stage": "v5-2-foundation", "status": "awaiting_gate3_and_chat_probe_judging",
        "candidate_checkpoint_sha256": manifest["checkpoint_sha256"], "best_checkpoint_positions": point,
        "processed_positions": status["processed_tokens"], "language_tokens": status["language_tokens"],
        "best_weighted_validation_loss": status["best_weighted_validation_loss"], "last_validation": status["last_validation"],
        "run_status": status["status"], "config_sha256": config_sha, "gate3_passed": None,
        "ready_for_chat": False, "phone_activated": False, "holdout_accessed": False}
    destination = CAMPAIGN / "assessment.json"
    if destination.exists() and read(destination) != receipt:
        raise ValueError("Existing v5 assessment differs; never overwrite it.")
    _atomic_json(destination, receipt)
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("action", choices=("prepare", "check", "run", "snapshot", "export"))
    parser.add_argument("--config-sha256")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--minutes", type=float)
    parser.add_argument("--tokens", type=int)
    args = parser.parse_args()
    if args.action == "prepare":
        result = prepare()
    elif not args.config_sha256:
        parser.error("check, run, snapshot and export need --config-sha256")
    elif args.action == "check":
        config, _ = check(args.config_sha256)
        result = {"passed": True, "shape": config["shape"], "parameters": config["parameters"],
                  "target_positions": TARGET, "gpu_started": False}
    elif args.action == "snapshot":
        if args.tokens is None:
            parser.error("snapshot needs --tokens")
        result = snapshot(args.config_sha256, args.tokens)
    elif args.action == "export":
        result = export(args.config_sha256)
    else:
        result = execute(args.config_sha256, resume=args.resume, minutes=args.minutes)
    print(json.dumps(result, indent=2, ensure_ascii=False))
