"""Validated scorecard evidence and aggregate-only private suite scoring."""

from collections import defaultdict
from collections.abc import Callable, Sequence
from datetime import datetime, timedelta, timezone
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory

from ..gates.common import digest, fields, nonempty, parse_json, require_file, sha256, valid_sha


SAMPLE_METRICS = {"first_progress_ms", "final_answer_ms", "cpu_ms_per_turn"}
BYTE_METRICS = {"peak_rss_bytes", "model_files_bytes", "resident_worker_bytes"}
ARM_METRICS = SAMPLE_METRICS | BYTE_METRICS
MODEL_METRICS = {"model_latency_ms", "model_files_bytes", "resident_worker_bytes", "worker_peak_rss_bytes"}
PRIVATE_SUITE = "private-local"
PROTECTED_PATHS = (
    ("artifacts", "brain-lab", "holdout-v1"),
    ("artifacts", "chat-training", "conversation-v1", "holdout"),
)
_IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]*\Z")
_COMMIT = re.compile(r"[0-9a-f]{40}\Z")


def _reject_protected(path: Path) -> None:
    parts = tuple(part for part in str(path).replace("\\", "/").casefold().split("/") if part not in ("", "."))
    if any(parts[index:index + len(protected)] == protected
           for protected in PROTECTED_PATHS for index in range(len(parts))):
        raise ValueError("Scorecard input paths may not reference a sealed holdout.")


def safe_input_path(path: Path) -> Path:
    """Check direct and symlink-resolved paths before reading any content."""
    path = Path(path).absolute()
    _reject_protected(path)
    resolved = path.resolve()
    _reject_protected(resolved)
    return resolved


def sha256_file(path: Path) -> str:
    return digest(safe_input_path(path))


def _load(path: Path) -> tuple[Path, dict, str]:
    source = safe_input_path(path)
    require_file(source)
    raw = source.read_bytes()
    return source, parse_json(raw, source), sha256(raw)


def _identifier(value, context: str) -> None:
    if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value):
        raise ValueError(f"Invalid identifier in {context}.")


def _commit(value) -> None:
    if not isinstance(value, str) or not _COMMIT.fullmatch(value):
        raise ValueError("Evidence requires a full lowercase Git commit.")


def _date(value) -> datetime:
    if not isinstance(value, str) or "T" not in value:
        raise ValueError("Evidence requires an ISO 8601 timestamp.")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("Evidence requires an ISO 8601 timestamp.") from None
    if result.utcoffset() is None:
        raise ValueError("Evidence timestamp requires a time zone.")
    return result.astimezone(timezone.utc)


def _command(value) -> None:
    if not isinstance(value, list) or not value or not all(nonempty(item) for item in value):
        raise ValueError("Evidence requires the original command as a nonempty argv array.")


def _evidence(value) -> None:
    fields(value, {"command", "recorded_at", "raw_output"}, "measurement evidence", {"started_at", "sha256"})
    _command(value["command"])
    recorded_at = _date(value["recorded_at"])
    if not nonempty(value["raw_output"]):
        raise ValueError("Evidence requires a raw output file path.")
    if "started_at" in value and _date(value["started_at"]) > recorded_at:
        raise ValueError("Measurement evidence starts after it was recorded.")
    if "sha256" in value and not valid_sha(value["sha256"]):
        raise ValueError("Evidence raw output SHA-256 is malformed.")


def _pin_evidence(root: Path, evidence: dict) -> dict:
    source = safe_input_path(root / evidence["raw_output"])
    actual = sha256_file(source)
    if evidence.get("sha256", actual) != actual:
        raise ValueError("Evidence raw output SHA-256 differs from the receipt.")
    return {**evidence, "raw_output": str(source), "sha256": actual}


def _number(value) -> bool:
    return type(value) is int and value >= 0 or type(value) is float and math.isfinite(value) and value >= 0


def _count(value) -> bool:
    return type(value) is int and value >= 0


def _metrics(value, reasons, names: set[str], sample_names: set[str]) -> None:
    fields(value, set(), "measured metric values", names)
    fields(reasons, set(), "unmeasured metric reasons", names)
    for name in names:
        observed = value.get(name)
        if observed is None or observed == []:
            if not nonempty(reasons.get(name)):
                raise ValueError(f"The unmeasured metric {name} requires a reason.")
        elif name in reasons:
            raise ValueError(f"The measured metric {name} cannot also have an unmeasured reason.")
        elif name in sample_names:
            if not isinstance(observed, list) or not all(map(_number, observed)):
                raise ValueError(f"Invalid nonnegative samples for {name}.")
        elif not _count(observed):
            raise ValueError(f"Invalid nonnegative byte count for {name}.")


def _machine(value) -> None:
    if not isinstance(value, dict) or not value or not all(
        nonempty(key) and (nonempty(item) or _number(item) or item is None) for key, item in value.items()
    ):
        raise ValueError("Measurement requires machine details with scalar values.")


def validate_arm_receipt(value: dict) -> None:
    fields(value, {"arm", "commit", "cases", "metrics", "evidence"}, "arm receipt",
           {"format", "unmeasured", "machine", "model_version", "turn_count", "turns_by_language",
            "samples_by_language", "sources"})
    if value.get("format", "scorecard-arm-v1") != "scorecard-arm-v1":
        raise ValueError("Unsupported arm receipt format.")
    _identifier(value["arm"], "arm")
    _commit(value["commit"])
    if value.get("model_version") is not None:
        _identifier(value["model_version"], "model_version")
    _evidence(value["evidence"])
    sources = value.get("sources", [])
    if not isinstance(sources, list):
        raise ValueError("Receipt sources must be an array of measurement evidence.")
    for source in sources:
        _evidence(source)
    _metrics(value["metrics"], value.get("unmeasured", {}), ARM_METRICS, SAMPLE_METRICS)
    if "machine" in value or any(value["metrics"].get(name) for name in SAMPLE_METRICS):
        _machine(value.get("machine"))
    cases = value["cases"]
    if not isinstance(cases, list) or not cases:
        raise ValueError("Arm receipt requires case verdicts.")
    seen = set()
    for case in cases:
        fields(case, {"suite_id", "case_id", "family", "language", "correct"}, "public case receipt")
        for key in ("suite_id", "case_id", "family", "language"):
            _identifier(case[key], f"case {key}")
        if case["suite_id"] == PRIVATE_SUITE:
            raise ValueError("Private case rows are never accepted in public receipts.")
        key = case["suite_id"], case["case_id"]
        if key in seen or type(case["correct"]) is not bool:
            raise ValueError("Invalid or duplicate case verdict.")
        seen.add(key)
    turn_count = value.get("turn_count")
    turns_by_language = value.get("turns_by_language")
    if "turn_count" in value and (not _count(turn_count) or turn_count < len(cases)):
        raise ValueError("Turn denominator must cover the observed public cases.")
    if "turns_by_language" in value:
        per_language_cases = defaultdict(int)
        for case in cases:
            per_language_cases[case["language"]] += 1
        if (not isinstance(turns_by_language, dict) or turns_by_language.keys() != per_language_cases.keys()
                or any(not _count(count) or count < per_language_cases[language]
                       for language, count in turns_by_language.items())):
            raise ValueError("Turn denominators must cover public cases in every observed language.")
        if turn_count is not None and turn_count != sum(turns_by_language.values()):
            raise ValueError("Turn denominators disagree.")
        turn_count = sum(turns_by_language.values())
    if any(value["metrics"].get(name) for name in SAMPLE_METRICS) and turn_count is None:
        raise ValueError("Measured per-turn samples require a turn denominator.")
    if turn_count is not None and any(len(value["metrics"].get(name) or []) > turn_count for name in SAMPLE_METRICS):
        raise ValueError("Measured sample count exceeds the turn denominator.")

    by_language = value.get("samples_by_language", {})
    fields(by_language, set(), "language sample counts", SAMPLE_METRICS)
    for name, counts in by_language.items():
        if (turns_by_language is None or not isinstance(counts, dict) or counts.keys() != turns_by_language.keys()
                or any(not _count(count) or count > turns_by_language[language] for language, count in counts.items())
                or sum(counts.values()) != len(value["metrics"].get(name) or [])):
            raise ValueError(f"Sample coverage for {name} disagrees with language denominators or sample length.")


def read_arm_receipt(path: Path) -> dict:
    source, value, checksum = _load(path)
    validate_arm_receipt(value)
    evidence = _pin_evidence(source.parent, value["evidence"])
    return {**value, "evidence": evidence,
            "sources": [_pin_evidence(source.parent, item) for item in value.get("sources", [])],
            "receipt_sha256": checksum, "raw_output_sha256": evidence["sha256"]}


def _ablation_groups(groups) -> None:
    if not isinstance(groups, list) or not groups:
        raise ValueError("Ablation receipt needs paired group counts.")
    seen = set()
    for group in groups:
        labels = ("suite_id", "family", "language")
        counts = ("total", "baseline_correct", "correct", "improved", "regressed")
        fields(group, set(labels + counts), "ablation group")
        for key in labels:
            _identifier(group[key], f"ablation group {key}")
        key = tuple(group[label] for label in labels)
        if group["suite_id"] == PRIVATE_SUITE or key in seen or not all(_count(group[name]) for name in counts):
            raise ValueError("Ablation groups must be distinct public groups with nonnegative integer counts.")
        total, baseline_correct, correct, improved, regressed = (group[name] for name in counts)
        if (total == 0 or baseline_correct > total or correct > total
                or improved > total - baseline_correct or regressed > baseline_correct
                or correct != baseline_correct + improved - regressed):
            raise ValueError("Inconsistent paired ablation counts.")
        seen.add(key)


def read_supplement(path: Path) -> dict:
    source, value, checksum = _load(path)
    common = {"format", "arm", "commit", "evidence"}
    format_id = value.get("format") if isinstance(value, dict) else None
    if format_id == "scorecard-model-runtime-v1":
        fields(value, common | {"model_version", "metrics", "machine"}, "model runtime receipt", {"unmeasured"})
        _identifier(value["model_version"], "model_version")
        _machine(value["machine"])
        _metrics(value["metrics"], value.get("unmeasured", {}), MODEL_METRICS, {"model_latency_ms"})
    elif format_id == "scorecard-dev-bench-ablation-v1":
        fields(value, common | {"baseline_arm", "baseline_commit", "switch", "groups"}, "dev-bench ablation receipt")
        _identifier(value["baseline_arm"], "baseline_arm")
        _commit(value["baseline_commit"])
        _identifier(value["switch"], "switch")
        if value["baseline_arm"] == value["arm"]:
            raise ValueError("Ablation requires two different arms.")
        _ablation_groups(value["groups"])
    else:
        raise ValueError("Unsupported measurement supplement format.")
    _identifier(value["arm"], "arm")
    _commit(value["commit"])
    _evidence(value["evidence"])
    evidence = _pin_evidence(source.parent, value["evidence"])
    return {**value, "evidence": evidence, "receipt_sha256": checksum, "raw_output_sha256": evidence["sha256"]}


def read_training_run(directory: Path, command: list[str]) -> dict:
    """Read a single-GPU training allocation from GpuJob start and summary receipts."""
    _command(command)
    path = safe_input_path(directory)
    start_path, start, start_sha = _load(path / "gpu-start.json")
    end_path, end, end_sha = _load(path / "gpu-summary.json")
    if (not isinstance(start, dict) or not isinstance(end, dict) or "problem" not in end or end["problem"] is not None
            or not nonempty(start.get("nvidia_smi")) or len(start["nvidia_smi"].strip().splitlines()) != 1
            or not _count(end.get("samples")) or end["samples"] == 0):
        raise ValueError("Training cost requires a completed, instrumented single-GPU run.")
    first, last = _date(start.get("start_time")), _date(end.get("end_time"))
    if first >= last:
        raise ValueError("Training timestamps are out of order.")
    return {"gpu_hours": (last - first) / timedelta(hours=1),
            "started_at": start["start_time"], "completed_at": end["end_time"],
            "evidence": {"command": command, "recorded_at": end["end_time"], "raw_output": str(end_path),
                         "sha256": end_sha},
            "raw_output_sha256": end_sha, "started_receipt": str(start_path), "started_receipt_sha256": start_sha}


def private_suite_path(path: Path, repo_root: Path) -> Path:
    """Only local files outside any Git checkout can contain private cases."""
    source = safe_input_path(path)
    repo = Path(repo_root).resolve()
    if source.is_relative_to(repo) or any(
        (directory / ".git").is_file() or (directory / ".git" / "HEAD").is_file() for directory in source.parents
    ):
        raise ValueError("Private suite must be stored outside Git checkouts.")
    return source


def _private_cases(path: Path, repo_root: Path, families: set[str], languages: set[str]) -> list[dict]:
    try:
        source = private_suite_path(path, repo_root)
        require_file(source)
        cases = parse_json(source.read_bytes(), PRIVATE_SUITE)
        if not isinstance(cases, list) or not cases:
            raise ValueError("Empty private suite.")
        for case in cases:
            fields(case, {"family", "language", "text", "required"}, "private case", {"forbidden"})
            if (case["family"] not in families or case["language"] not in languages or not nonempty(case["text"])
                    or not isinstance(case["required"], list) or not case["required"]
                    or not all(map(nonempty, case["required"]))
                    or not isinstance(case.get("forbidden", []), list)
                    or not all(map(nonempty, case.get("forbidden", [])))):
                raise ValueError("Invalid private case.")
        return cases
    except (OSError, TypeError, ValueError, RuntimeError):
        raise ValueError("Private suite could not be read or validated outside Git.") from None


def private_evaluator(path: Path, repo_root: Path, arms: Sequence[dict]) -> Callable[[str, Sequence[str]], list[str]]:
    """Launch an owner-local evaluator with loopback-only networking and ephemeral scratch space."""
    try:
        program = private_suite_path(path, repo_root)
        require_file(program)
        if not os.access(program, os.X_OK):
            raise ValueError("Private evaluator is not executable.")
    except (OSError, ValueError, RuntimeError):
        raise ValueError("Private evaluator requires a local executable outside Git.") from None
    unshare, ip, shell = (shutil.which(name) for name in ("unshare", "ip", "sh"))
    if sys.platform != "linux" or not all((unshare, ip, shell)):
        raise ValueError("Private evaluator requires Linux with unshare and ip.")
    namespace = [unshare, "--user", "--map-root-user", "--net", "--pid", "--fork", "--kill-child", "--"]
    try:
        probe = subprocess.run([*namespace, ip, "link", "set", "lo", "up"], stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    except OSError:
        raise ValueError("Private evaluator could not start Linux network isolation.") from None
    if probe.returncode:
        raise ValueError("Private evaluator could not create an isolated Linux network namespace.")
    configurations = {arm["id"]: arm for arm in arms}
    checkout = Path(repo_root).resolve()

    def evaluate(arm: str, prompts: Sequence[str]) -> list[str]:
        # No case input is passed through argv, the environment, or the filesystem.
        # The owner-supplied program starts its local fixture inside this namespace.
        command = [*namespace, shell, "-c", '"$1" link set lo up && shift && exec "$@"',
                   "scorecard-private", ip, str(program)]
        with TemporaryDirectory(prefix="scorecard-private-") as temporary:
            directory = private_suite_path(Path(temporary), checkout)
            environment = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(directory),
                           "TMPDIR": str(directory), "TEMP": str(directory), "TMP": str(directory)}
            request = {"arm": configurations[arm], "checkout": str(checkout), "prompts": prompts}
            completed = subprocess.run(command, input=json.dumps(request).encode(), cwd=directory,
                                       env=environment, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
            if completed.returncode:
                raise ValueError("Private evaluator did not complete successfully.")
            try:
                result = parse_json(completed.stdout, PRIVATE_SUITE)
            except ValueError:
                raise ValueError("Private evaluator requires an ordered reply array.") from None
            if not isinstance(result, list) or not all(isinstance(reply, str) for reply in result):
                raise ValueError("Private evaluator requires an ordered reply array.")
            return result

    return evaluate


def _private_comparison(cases: Sequence[dict], reference: Sequence[bool], verdicts: Sequence[bool]) -> list[dict]:
    counts = {}
    for case, baseline, correct in zip(cases, reference, verdicts, strict=True):
        group = case["family"], case["language"]
        row = counts.setdefault(group, {"family": group[0], "language": group[1],
                                        "total": 0, "correct": 0, "improved": 0, "regressed": 0})
        row["total"] += 1
        row["correct"] += int(correct)
        row["improved"] += int(correct and not baseline)
        row["regressed"] += int(baseline and not correct)
    return [counts[key] for key in sorted(counts)]


def run_private_suite(path: Path, repo_root: Path, arms: Sequence[str], baseline: str,
                      evaluator: Callable[[str, Sequence[str]], Sequence[str]], *,
                      families: set[str], languages: set[str],
                      additional_references: dict[str, str] | None = None) -> dict[str, list[dict]]:
    """Score ordered single-turn requests. Export paired aggregate counts only."""
    references = {arm: baseline for arm in arms} | (additional_references or {})
    if baseline not in arms or len(set(arms)) != len(arms) or not set(references) <= set(arms) or not set(references.values()) <= set(arms):
        raise ValueError("Private suite requires distinct arms including every reference.")
    cases = _private_cases(path, repo_root, families, languages)
    prompts = tuple(case["text"] for case in cases)
    verdicts = {}
    for arm in (baseline, *(arm for arm in arms if arm != baseline)):
        try:
            replies = evaluator(arm, prompts)
            if isinstance(replies, str) or len(replies) != len(cases) or not all(isinstance(reply, str) for reply in replies):
                raise ValueError("Incomplete private evaluation.")
        except Exception:
            raise ValueError("Local private suite evaluation failed.") from None
        verdicts[arm] = [all(fragment in reply for fragment in case["required"])
                         and not any(fragment in reply for fragment in case.get("forbidden", []))
                         for case, reply in zip(cases, replies, strict=True)]
    comparisons = {arm: _private_comparison(cases, verdicts[baseline], verdicts[arm]) for arm in arms}
    for arm, reference in (additional_references or {}).items():
        comparisons[f"{arm}/{reference}"] = _private_comparison(cases, verdicts[reference], verdicts[arm])
    return comparisons
