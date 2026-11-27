"""Run paired development measurements and publish an Arabic value scorecard."""
from __future__ import annotations

import argparse
from collections import defaultdict
from math import ceil
from pathlib import Path
import re
from statistics import fmean
import subprocess
import sys

from ..gates.common import fields, now, parse_json, sha256, write_once
from ..gates.decision import mcnemar_exact, wilson
from . import live
from .receipts import read_arm_receipt, read_supplement, read_training_run, safe_input_path, sha256_file, validate_arm_receipt
from .report import METRIC_LABELS, append_history, render, write_report


ROOT = Path(__file__).resolve().parents[2]
BASELINE = "baseline"
SPEED = ("first_progress_ms", "final_answer_ms")


def arguments(argv):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--output", type=Path, required=True, help="new directory outside the checkout")
    parser.add_argument("--history", type=Path, help="append-only JSONL outside the checkout (default: next to output)")
    parser.add_argument("--suite", choices=["development", "council"], action="append",
                        help="repeat for both suites; defaults to development (pinned V1 and V2)")
    parser.add_argument("--arm", action="append", default=[], metavar="ID=COMMIT",
                        help="add a candidate at a full commit (baseline and production are built in)")
    parser.add_argument("--production-profile", type=Path,
                        help="owner-local JSON of production switches and optional registered model ID")
    parser.add_argument("--set", action="append", default=[], metavar="ID:SWITCH=VALUE")
    parser.add_argument("--model", action="append", default=[], metavar="ID=REGISTRY_ID")
    parser.add_argument("--model-control", action="append", default=[], metavar="ID=CONTROL_ARM")
    parser.add_argument("--models-root", type=Path)
    parser.add_argument("--model-python", type=Path)
    parser.add_argument("--coding-python", type=Path)
    parser.add_argument("--council-live", action="store_true", help="authorize council suite's public source reads")
    parser.add_argument("--private-suite", type=Path)
    parser.add_argument("--private-evaluator", type=Path)
    parser.add_argument("--supplement", type=Path, action="append", default=[])
    parser.add_argument("--training", action="append", default=[], metavar="ID=GPU_RUN_DIRECTORY")
    parser.add_argument("--training-command", action="append", default=[], metavar="ID=JSON_ARGV")
    parser.add_argument("--preregister", type=Path)
    parser.add_argument("--decisive", action="store_true", help="apply the owner-supplied pre-registration")
    parser.add_argument("--workers", type=int, choices=range(1, 9), default=1)
    parser.add_argument("--offline", action="store_true", help="install benchmark dependencies from the npm cache")
    return parser.parse_args(argv)


def mapping(values, label):
    result = {}
    for spec in values:
        key, delimiter, value = spec.partition("=")
        if not delimiter or not value or key in result:
            raise ValueError(f"Expected a unique KEY=VALUE for {label}.")
        result[key] = value
    return result


def plan(args, root):
    baseline, production = live.default_arms(root)
    arms = {arm["id"]: arm for arm in (baseline, production)}
    modes = set(args.suite or ["development"])
    with live.development_modules(root) as (_, bench):
        switches = bench.OVERRIDES | {name: {"0", "1"} for name in live.FIXTURE_SWITCHES}
    if modes == {"council"}:
        from .council import COUNCIL_SWITCHES
        switches |= COUNCIL_SWITCHES
    profile_sha256 = None
    if args.production_profile:
        raw = safe_input_path(args.production_profile).read_bytes()
        profile = parse_json(raw, "production profile")
        fields(profile, {"switches"}, "production profile", {"model_version"})
        if (not isinstance(profile["switches"], dict)
                or any(not isinstance(value, str) or value not in switches.get(key, ())
                       for key, value in profile["switches"].items())):
            raise ValueError("The production profile contains a setting unsupported by the selected suites.")
        production["switches"] = production["switches"] | profile["switches"]
        if "model_version" in profile:
            version = profile["model_version"]
            if not isinstance(version, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", version):
                raise ValueError("The production profile model_version must be a registry ID.")
            production["model_version"] = version
        profile_sha256 = sha256(raw)
    for arm, commit in mapping(args.arm, "--arm").items():
        if arm in arms or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", arm) or not re.fullmatch("[a-f0-9]{40}", commit):
            raise ValueError("Expected a new arm ID and a full lowercase commit SHA.")
        arms[arm] = {"id": arm, "commit": commit, "switches": dict(production["switches"])}
    for key, value in mapping(args.set, "--set").items():
        arm, delimiter, switch = key.partition(":")
        if not delimiter or arm not in arms or arm in (BASELINE, "production") or value not in switches.get(switch, ()):
            raise ValueError("Switch overrides require a named candidate arm and a supported setting for the selected suites.")
        arms[arm]["switches"][switch] = value
    if args.coding_python:
        if not args.coding_python.is_absolute():
            raise ValueError("--coding-python requires an absolute interpreter path.")
        for arm in arms.values():
            arm["switches"]["TEST_DRIVEN_CODING_PYTHON"] = str(safe_input_path(args.coding_python))
    for arm, version in mapping(args.model, "--model").items():
        if arm not in arms or arm in (BASELINE, "production") or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", version):
            raise ValueError("Select a registry ID for an explicit candidate arm.")
        arms[arm]["model_version"] = version
    controls = mapping(args.model_control, "--model-control")
    for arm, control in controls.items():
        if arm not in arms or not arms[arm].get("model_version") or control not in arms or arms[control].get("model_version"):
            raise ValueError("A model control must match a model arm to a model-free arm.")
        if any(arms[arm][field] != arms[control][field] for field in ("commit", "switches")):
            raise ValueError("A model control needs the same commit and brain switches as its model arm.")
    if ("council" in modes) != args.council_live:
        raise ValueError("The council suite requires explicit --suite council --council-live.")
    if bool(args.private_suite) != bool(args.private_evaluator):
        raise ValueError("Supply both --private-suite and --private-evaluator for a local private comparison.")
    suites = [*live.SUITES["default_suites"]] if "development" in modes else []
    if "council" in modes:
        suites.append("council")
    if args.private_suite:
        suites.append("private-local")
    if any(arm.get("model_version") for arm in arms.values()):
        if not args.models_root or not args.model_python:
            raise ValueError("Registered model arms require local --models-root and --model-python paths.")
    if args.models_root:
        args.models_root = safe_input_path(args.models_root)
    if args.model_python:
        # Invoking a resolved venv symlink would bypass its pyvenv.cfg and dependencies.
        safe_input_path(args.model_python)
        args.model_python = args.model_python.absolute()
    return arms, controls, modes, suites, profile_sha256


def command_for(argv):
    # The private suite and evaluator paths do not form part of an exported command.
    private_flags = {"--private-suite", "--private-evaluator"}
    command = [sys.executable, "-B", "-m", "scripts.scorecard"]
    skip = False
    for arg in argv:
        if skip:
            skip = False
        elif arg in private_flags:
            command.extend([arg, "<local>"])
            skip = True
        elif arg.split("=")[0] in private_flags:
            command.append(arg.split("=")[0] + "=<local>")
        else:
            command.append(arg)
    return command


def evidence_view(item):
    return {**item, "raw_output_sha256": item["sha256"]}


def summarize_metrics(receipt):
    def measured(value, key, samples=None):
        measured = {"value": value}
        if value is None:
            measured["reason"] = receipt.get("unmeasured", {}).get(key) or "No measurement was recorded for this arm."
        if samples is not None:
            measured["samples"] = samples
            measured["total"] = receipt.get("turn_count") or sum(receipt.get("turns_by_language", {}).values()) or None
            measured["samples_by_language"] = receipt.get("samples_by_language", {}).get(key, {})
        return measured

    metrics = receipt["metrics"]
    output = {}
    for key in SPEED:
        data = sorted(metrics.get(key) or [])
        latency = {name: data[ceil(fraction * len(data)) - 1]
                   for name, fraction in (("p50", .50), ("p95", .95))} if data else None
        output[key] = measured(latency, key, len(data))
    data = metrics.get("cpu_ms_per_turn") or []
    output["cpu_ms_per_turn"] = measured(fmean(data) if data else None, "cpu_ms_per_turn", len(data))
    for key in METRIC_LABELS.keys() - output.keys():
        output[key] = measured(metrics.get(key), key)
    return output


def apply_supplements(paths, arms):
    runtime = {}
    ablation = []
    for path in paths:
        item = read_supplement(path)
        arm = arms.get(item["arm"])
        if arm is None or arm["commit"] != item["commit"]:
            raise ValueError("Supplement arm and commit must match this scorecard.")
        if item["format"] == "scorecard-model-runtime-v1":
            if arm.get("model_version") != item["model_version"] or item["arm"] in runtime:
                raise ValueError("Model runtime supplement must uniquely match the selected model version.")
            runtime[item["arm"]] = item
        else:
            control = arms.get(item["baseline_arm"])
            key = item["switch"]
            if (control is None or control["commit"] != item["baseline_commit"]
                    or key not in arm["switches"] or arm["switches"][key] == control["switches"].get(key)):
                raise ValueError("Ablation supplement must match the control commit and candidate switch.")
            for group in item["groups"]:
                group["interval95"] = wilson(group["correct"], group["total"])
                group["mcnemar_p"] = mcnemar_exact(group["improved"], group["regressed"])
            ablation.append(item)
    return runtime, ablation


def publish_receipts(receipts, location, arms, expected, command):
    paths = {}
    for record in receipts:
        record = dict(record)
        arm = record.get("arm")
        if arm not in arms or arm in paths or record.get("commit") != arms[arm]["commit"]:
            raise ValueError("Observed arms differ from the scorecard plan.")
        if record.get("model_version") != arms[arm].get("model_version"):
            raise ValueError("Observed model versions differ from the scorecard plan.")
        sources = []
        for source in record.get("sources", []):
            argv = source["command"]
            sources.append({**source, "command": command if "scripts.scorecard" in argv else argv})
        if "evidence" not in record and sources:
            record["evidence"] = sources.pop(0)
        elif "scripts.scorecard" in record["evidence"]["command"]:
            record["evidence"] = {**record["evidence"], "command": command}
        record["sources"] = sources
        if set(case["suite_id"] for case in record["cases"]) != set(expected):
            raise ValueError("Observed suites differ from the scorecard plan.")
        validate_arm_receipt(record)
        path = location / f"{arm}.json"
        write_once(path, record)
        paths[arm] = read_arm_receipt(path)
    if paths.keys() != arms.keys():
        raise ValueError("Every arm must produce receipts for the selected suites.")
    return paths


def measure_private(path, evaluator_path, root, arms, controls, measurements, output, command):
    from .receipts import private_evaluator, run_private_suite

    rows = [row for phase in measurements.values() for row in phase[BASELINE]["cases"]]
    try:
        evaluator = private_evaluator(evaluator_path, root, list(arms.values()))
        comparisons = run_private_suite(path, root, list(arms), BASELINE, evaluator,
                                        families={row["family"] for row in rows},
                                        languages={row["language"] for row in rows},
                                        additional_references=controls)
    except (OSError, ValueError, RuntimeError):
        raise ValueError("Local private suite did not complete. Check its paths, schema and network isolation.") from None
    recorded_at = now()
    destination = output / "private-aggregates.json"
    write_once(destination, {"recorded_at": recorded_at, "command": command, "comparisons": comparisons})
    return comparisons, {
        "raw_output": str(destination), "raw_output_sha256": sha256_file(destination),
        "recorded_at": recorded_at, "command": command,
    }


def summarize(arms, controls, suites, measurements, registration, decisive, runtime, training, private):
    from .stats import CaseResult, PrivateComparison, compare_quality, decide

    cases = defaultdict(list)
    for phase in measurements.values():
        for arm, receipt in phase.items():
            cases[arm].extend(CaseResult(**row) for row in receipt["cases"])
    # The phase uses the same observer and boundary throughout. Keep additional
    # phase metrics visible without mixing in-process and HTTP samples.
    measurement_phase = next(iter(measurements))

    def quality(arm, comparator, suite=None):
        def selected(source):
            return [row for row in cases[source] if suite is None or row.suite_id == suite]

        rows = private.get(arm if comparator == BASELINE else f"{arm}/{comparator}", [])
        aggregates = [PrivateComparison(**row) for row in rows] if suite in (None, "private-local") else []
        return compare_quality(selected(comparator), selected(arm), private=aggregates)

    results = {}
    for arm, spec in arms.items():
        phase_records = {name: phase[arm] for name, phase in measurements.items()}
        primary = phase_records[measurement_phase]
        speed_and_cost = {name: summarize_metrics(data) for name, data in phase_records.items()}
        metrics = dict(speed_and_cost[measurement_phase])
        evidence = [evidence_view(source) for data in phase_records.values()
                    for source in [data["evidence"], *data["sources"]]]
        receipt_hashes = {name: data["receipt_sha256"] for name, data in phase_records.items()}
        training_dates = None
        if item := training.get(arm):
            metrics["training_gpu_hours"] = {"value": item["gpu_hours"]}
            training_dates = {key: item[key] for key in ("started_at", "completed_at", "started_receipt", "started_receipt_sha256")}
            evidence.append(evidence_view(item["evidence"]))
        else:
            reason = ("Training-run receipts are unavailable for this model." if spec.get("model_version")
                      else "This arm does not select an individual model version for training attribution.")
            metrics["training_gpu_hours"] = {"value": None, "reason": reason}
        if item := runtime.get(arm):
            evidence.append(evidence_view(item["evidence"]))
            receipt_hashes["model-runtime"] = item["receipt_sha256"]
        results[arm] = {
            "commit": spec["commit"], "model_version": spec.get("model_version"), "settings": spec["switches"],
            "quality": {"combined": quality(arm, BASELINE), **{suite: quality(arm, BASELINE, suite) for suite in suites}},
            "metrics": metrics, "phase_metrics": speed_and_cost,
            "machine": primary.get("machine", {}),
            "phase_machines": {name: data.get("machine", {}) for name, data in phase_records.items()},
            "turns_by_language": {name: data.get("turns_by_language", {}) for name, data in phase_records.items()},
            "evidence": evidence, "receipt_hashes": receipt_hashes, "training_dates": training_dates,
        }

    def speed(data):
        return {key: (data["metrics"][key]["value"] or {}).get("p95") for key in SPEED}

    for arm, data in results.items():
        costs = {key: metric["value"] for key, metric in data["metrics"].items() if key not in SPEED}
        model = bool(data["model_version"])
        data["decision"] = decide(preregistration=registration, quality=data["quality"]["combined"],
                                  baseline_speed=speed(results[BASELINE]), candidate_speed=speed(data), costs=costs,
                                  model=model, baseline=arm == BASELINE, decisive=decisive)
        data["own_model_justified"] = None
        if control := controls.get(arm):
            data["model_control"] = control
            comparison = quality(arm, control)
            data["model_comparison"] = comparison
            own = decide(preregistration=registration, quality=comparison,
                         baseline_speed=speed(results[control]), candidate_speed=speed(data), costs=costs,
                         model=True, baseline=False, decisive=decisive)
            data["own_model_justified"] = own["own_model_justified"]
            data["model_decision"] = own
    return results, measurement_phase


def execute(args, argv, root=ROOT):
    from .stats import load_preregistration

    registration = load_preregistration(safe_input_path(args.preregister) if args.preregister else None,
                                        decisive=args.decisive)
    arms, controls, modes, suites, profile_sha256 = plan(args, root)
    output = safe_input_path(args.output)
    history = safe_input_path(args.history or output.parent / "scorecard-history.jsonl")
    if output.is_relative_to(root) or history.is_relative_to(root) or history.is_relative_to(output):
        raise ValueError("Keep results and history outside the checkout and history outside each run directory.")
    command = command_for(argv)
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    runtime, ablation = apply_supplements(args.supplement, arms)
    training_paths = mapping(args.training, "--training")
    training_commands = mapping(args.training_command, "--training-command")
    if training_paths.keys() != training_commands.keys() or any(not arms.get(arm, {}).get("model_version") for arm in training_paths):
        raise ValueError("Training receipts and original argv must be supplied together for a selected model arm.")
    training = {}
    for arm, path in training_paths.items():
        try:
            training[arm] = read_training_run(Path(path), parse_json(training_commands[arm], "--training-command"))
        except FileNotFoundError:
            continue

    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    start = {
        "schema_version": 1, "started_at": now(), "commit": commit, "command": command, "suites": suites,
        "arms": arms, "model_controls": controls, "decisive": args.decisive,
        "production_profile_sha256": profile_sha256,
        "suite_manifest_sha256": sha256_file(root / "scripts/scorecard/suites.json"),
        "tool_hashes": {path.name: sha256_file(path) for path in sorted((root / "scripts/scorecard").iterdir())
                        if path.suffix in {".py", ".ts"} and not path.name.startswith("test_") and not path.name.endswith(".test.ts")},
        "preregistration": registration.stamp if registration else None,
        "supplement_hashes": [item["receipt_sha256"] for item in [*runtime.values(), *ablation]],
        "training_hashes": {arm: [item["started_receipt_sha256"], item["raw_output_sha256"]]
                            for arm, item in training.items()},
    }
    start_path = output / "start.json"
    write_once(start_path, start)
    start_sha256 = sha256_file(start_path)
    measurements = {}
    history_row = {"schema_version": 1, "commit": commit, "suites": suites, "arms": arms,
                   "started_at": start["started_at"], "start_sha256": start_sha256,
                   "preregistration": start["preregistration"], "run_path": str(output)}
    try:
        if "development" in modes:
            observed = live.run_development(root, output / "development", list(arms.values()),
                                            workers=args.workers, offline=args.offline, command=command,
                                            models_root=args.models_root, python=args.model_python)
            destination = output / "development"
            measurements["development"] = publish_receipts(observed, destination, arms, live.SUITES["default_suites"], command)
        if "council" in modes:
            from .council import run_council
            destination = output / "council"
            observed = run_council(root, destination, list(arms.values()), offline=args.offline,
                                   models_root=args.models_root, python=args.model_python)
            measurements["council"] = publish_receipts(observed, destination, arms, ["council"], command)
        private, private_evidence = {}, None
        if args.private_suite:
            private, private_evidence = measure_private(args.private_suite, args.private_evaluator, root, arms,
                                                        controls, measurements, output, command)
        results, phase = summarize(arms, controls, suites, measurements, registration, args.decisive, runtime, training, private)
        result = {"schema_version": 1, "start": start, "start_sha256": start_sha256, "finished_at": now(),
                  "measurement_phase": phase, "arms": results, "ablation": ablation,
                  "private_evidence": private_evidence, "model_runtime": runtime}
        write_once(output / "results.json", result)
        write_report(output / "report.md", render(result))
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError, KeyboardInterrupt) as error:
        finished_at = now()
        write_once(output / "failure.json", {"finished_at": finished_at, "reason": str(error) or type(error).__name__,
                                               "command": command, "start_sha256": start_sha256})
        append_history(history, history_row | {"status": "failed", "finished_at": finished_at,
                                                "failure_sha256": sha256_file(output / "failure.json")})
        raise
    append_history(history, history_row | {
        "status": "completed", "finished_at": result["finished_at"],
        "report_sha256": sha256_file(output / "report.md"), "results_sha256": sha256_file(output / "results.json"),
        "results": {arm: {"receipt_hashes": data["receipt_hashes"], "quality": data["quality"],
                           "metrics": data["metrics"], "decision": data["decision"]} for arm, data in results.items()},
    })
    return output / "report.md"


def main():
    argv = sys.argv[1:]
    try:
        print(execute(arguments(argv), argv))
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"scorecard: {error}") from None


if __name__ == "__main__":
    main()
