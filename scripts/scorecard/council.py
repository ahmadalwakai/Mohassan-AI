"""Run the published council suite through isolated, commit-pinned servers."""

from collections import Counter
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
import json
import os
import re
import shlex
import subprocess

from ..gates.common import now, sha256, write_once
from .live import PRODUCTION_COMMIT, PROTECTED, SUITES, development_modules
from .receipts import SAMPLE_METRICS, safe_input_path


_COPIED_ADAPTERS = ("council-run.ts", "council-cases.ts", "council-resources.ts")
COUNCIL_SWITCHES = {
    "MOHASSAN_MODEL_COUNCIL": {"off", "owner"},
    "MOHASSAN_JUDGE_SHADOW": {"0", "1"},
    "MOHASSAN_JUDGE_FIX": {"0", "1"},
    "MOHASSAN_JUDGE_WITHHOLD": {"0", "1"},
    "MOHASSAN_MIND": {"0", "1"},
}


@contextmanager
def _product(root: Path, output: Path, commit: str, excluded: tuple[str, ...]):
    with TemporaryDirectory(prefix="council-", dir=output) as temporary:
        checkout = Path(temporary) / "product"

        def git(directory, *args, **kwargs):
            return subprocess.run(["git", "-C", str(directory), *args], check=True, **kwargs)

        git(root, "worktree", "add", "--detach", "--no-checkout", str(checkout), commit)
        try:
            patterns = "\n".join(("/*", *(f"!/{name}/" for name in excluded))) + "\n"
            git(checkout, "sparse-checkout", "set", "--no-cone", "--stdin", input=patterns, text=True)
            git(checkout, "checkout", "--detach")
            yield checkout
        finally:
            git(root, "worktree", "remove", "--force", str(checkout))


def _measure(args: list[str], cwd: Path, log: Path, *, environment=None) -> dict:
    started = now()
    with log.open("xb") as stream:
        completed = subprocess.run(args, cwd=cwd, env=environment, stdout=stream, stderr=subprocess.STDOUT)
    if completed.returncode:
        raise ValueError(f"Council fixture exited {completed.returncode}. See {log}.")
    return {"command": args, "started_at": started, "recorded_at": now(), "raw_output": str(log)}


def _normalize(arm: dict, observed: dict, evidence: dict, sources: list[dict], family: str) -> dict:
    rows = observed["rows"]
    selected = arm.get("model_version")
    if selected and not any(member["model"] == selected and member["outcome"] in {"ok", "abstained"}
                            for row in rows for member in row["members"]):
        raise ValueError(f"Council did not execute selected local model {selected}; see {evidence['raw_output']}.")
    if any(row.get("family") != family for row in rows):
        raise ValueError("Council case family differs from the suite manifest.")
    cases = [{"suite_id": "council", "case_id": row["case_id"], "family": row["family"],
              "language": row["language"], "correct": row["correct"]} for row in rows]
    metrics = {
        key: [row[key] for row in rows if row[key] is not None] or None
        for key in sorted(SAMPLE_METRICS)
    } | {
        "peak_rss_bytes": observed["peak_rss_bytes"],
        "model_files_bytes": observed["model"]["bytes"] if observed["model"] is not None else None,
        "resident_worker_bytes": observed["resident_worker_bytes"],
    }
    if selected:
        # Linux API counters do not account for an independently running model worker.
        metrics["cpu_ms_per_turn"] = None
        metrics["peak_rss_bytes"] = None
    reasons = {
        "first_progress_ms": "The HTTP observer saw no progress event.",
        "final_answer_ms": "The HTTP observer saw no final answer.",
        "cpu_ms_per_turn": "Linux API process CPU counters were unavailable.",
        "peak_rss_bytes": "Linux API process RSS high-water mark was unavailable.",
        "model_files_bytes": "No selected model artifact set was staged, and bundled model files were not inventoried.",
        "resident_worker_bytes": "No selected model worker's resident memory could be sampled after a turn.",
    }
    if selected:
        reasons["cpu_ms_per_turn"] = "The API-only counter does not include model worker CPU time."
        reasons["peak_rss_bytes"] = "The API-only high-water mark does not include model worker memory."
    turns = dict(Counter(row["language"] for row in rows))
    samples = {key: Counter(row["language"] for row in rows if row[key] is not None)
               for key in SAMPLE_METRICS if metrics[key] is not None}
    return {
        "arm": arm["id"], "commit": arm["commit"], **({"model_version": selected} if selected else {}),
        "cases": cases, "turns_by_language": turns,
        "samples_by_language": {key: {language: counts[language] for language in turns} for key, counts in samples.items()},
        "metrics": metrics, "unmeasured": {key: reasons[key] for key in metrics if metrics[key] is None},
        "machine": observed["machine"], "evidence": evidence, "sources": sources,
    }


def run_council(root, output, arms, *, offline=False, models_root=None, python=None):
    """The caller requires explicit owner authorization for live public fact retrieval."""
    root, output = Path(root).resolve(), safe_input_path(output)
    if output.is_relative_to(root):
        raise ValueError("Write council receipts outside the checkout.")
    if bool(models_root) != bool(python):
        raise ValueError("A council model arm requires the local model root and a local Python executable.")
    if any(arm.get("model_version") for arm in arms) and models_root is None:
        raise ValueError("Select a local model root and Python to run council model arms.")
    if models_root is not None:
        models_root = safe_input_path(models_root)
        # Preserve the invoked Python path so a venv symlink retains its own pyvenv.cfg.
        python = Path(python).absolute()
        safe_input_path(python)
        if not models_root.is_dir() or not python.is_file() or not os.access(python, os.X_OK):
            raise ValueError("Local council model store or Python executable is unavailable.")
    with development_modules(root) as (_, bench):
        excluded = (*bench.HOLDOUTS, *PROTECTED)
        allowed = bench.OVERRIDES | COUNCIL_SWITCHES
    spec = SUITES["suites"]["council"]
    question_source = subprocess.check_output(["git", "-C", str(root), "show", f"{PRODUCTION_COMMIT}:{spec['runner']}"])
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    receipts = []
    for arm in arms:
        switches = dict(arm["switches"])
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", arm["id"]) or not re.fullmatch(r"[a-f0-9]{40}", arm["commit"]):
            raise ValueError("Council arms require a valid ID and full hexadecimal commit.")
        for key, value in switches.items():
            if key == "TEST_DRIVEN_CODING_PYTHON" and Path(value).is_absolute():
                switches[key] = str(safe_input_path(value))
            elif value not in allowed.get(key, ()):
                raise ValueError(f"Unsupported council scorecard switch {key}.")
        if switches.get("MOHASSAN_MIND") == "1":
            switches["MOHASSAN_LOCAL_LAB"] = "1"
        destination = output / arm["id"]
        destination.mkdir(mode=0o700)
        with _product(root, destination, arm["commit"], excluded) as checkout:
            adapter = checkout / "scripts/scorecard"
            adapter.mkdir(parents=True, exist_ok=True)
            if adapter.resolve() != adapter:
                raise ValueError("Council adapter directory must not be a symlink.")
            pins = {spec["runner"]: sha256(question_source)}
            for name in _COPIED_ADAPTERS:
                content = (Path(__file__).parent / name).read_bytes()
                pins[f"scripts/scorecard/{name}"] = sha256(content)
                destination_file = adapter / name
                if destination_file.resolve() != destination_file:
                    raise ValueError("Council adapter file must not be a symlink.")
                destination_file.write_bytes(content)
            # These are temporary inputs. The raw receipt records their pins, independently of product commits.
            cases = checkout.parent / "questions.ts"
            cases.write_bytes(question_source)
            sources = [_measure(["npm", "ci", "--no-audit", "--no-fund", *(["--offline"] if offline else [])],
                                checkout, destination / "npm-ci.log",
                                environment=os.environ | ({"ELECTRON_SKIP_BINARY_DOWNLOAD": "1"} if offline else {}))]
            raw = destination / "receipt.json"
            script_settings = checkout.parent / "settings.json"
            try:
                ticks = int(subprocess.check_output(["getconf", "CLK_TCK"], text=True))
            except (ValueError, OSError, subprocess.CalledProcessError):
                ticks = None
            settings = {"cases": str(cases), "family": spec["area"], "output": str(raw), "store": str(checkout.parent / "models"),
                        "environment": switches, "apiPort": 4170, "ticksPerSecond": ticks,
                        "inputs": pins}
            if arm.get("model_version"):
                executable = python
                if os.name == "posix":
                    # The existing worker launches Python with a scrubbed environment. Hide CUDA at exec.
                    executable = checkout.parent / "cpu-python"
                    executable.write_text(f"#!/bin/sh\nexport CUDA_VISIBLE_DEVICES=-1\nexec {shlex.quote(str(python))} \"$@\"\n")
                    executable.chmod(0o700)
                settings["model"] = {"id": arm["model_version"], "root": str(models_root), "python": str(executable)}
            write_once(script_settings, settings)
            command = ["node", "--import", "tsx", "scripts/scorecard/council-run.ts", str(script_settings)]
            run = _measure(command, checkout, destination / "council.log")
            sources.append(run)
            observed = json.loads(raw.read_bytes())
            receipts.append(_normalize(arm, observed, {**run, "raw_output": str(raw)}, sources, spec["area"]))
    return receipts
