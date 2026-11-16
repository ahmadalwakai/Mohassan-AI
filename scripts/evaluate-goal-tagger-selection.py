"""Compare two completed training runs under transparently frozen current inference code.

Training source snapshots remain separately identified and verified; a new inference
freeze never claims that an older checkpoint was trained with the current sources.
Both acceptance policies use development validation only. Final labels never select
models, thresholds, or answers. The holdout is consumed before any final prediction.
"""
from __future__ import annotations

import argparse
from collections import Counter
import importlib.util
import json
import math
from pathlib import Path
import shutil
import sys

_spec = importlib.util.spec_from_file_location(
    "goal_experiment_helpers", Path(__file__).with_name("run-goal-tagger-experiment.py"))
_runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_runner)
ROOT, CLI, SCORER = _runner.ROOT, _runner.CLI, _runner.SCORER
sha, read, write, rows = _runner.sha, _runner.read, _runner.write, _runner.rows
now, message_hashes, execute = _runner.now, _runner.message_hashes, _runner.execute
SOURCES = list(dict.fromkeys([*_runner.SOURCES, "scripts/evaluate-goal-tagger-selection.py"]))
CALIBRATOR = ROOT / "scripts/ads-training/calibrate-goal-tagger.ts"
CRITERIA = {"minimumIndependentCasesPerLanguage": 100, "minimumRawExactAccuracy": 0.95,
            "minimumAcceptedPrecision": 0.99, "minimumAcceptedCoverage": 0.8,
            "minimumAcceptedCasesPerLanguage": 100}
CALIBRATION = {"targetPrecision": 0.995, "minimumCoverage": 0.8, "minimumAcceptedCases": 100}


def absolute(path):
    path = Path(path)
    return (path if path.is_absolute() else ROOT / path).resolve()


def track(path, watched, expected=None):
    path = absolute(path)
    actual = sha(path)
    if expected is not None and actual != expected:
        raise ValueError(f"Recorded hash mismatch: {path}")
    if path in watched and watched[path] != actual:
        raise ValueError(f"Input changed during evaluation: {path}")
    watched[path] = actual
    return actual


def assert_unchanged(watched):
    for path, expected in watched.items():
        if sha(path) != expected:
            raise ValueError(f"Input changed after freeze: {path}")


def inspect_run(directory, watched, ancestors=None):
    """Verify actual training history, including archived code and warm-start lineage."""
    directory = absolute(directory)
    ancestors = set() if ancestors is None else ancestors
    if directory in ancestors:
        raise ValueError("Cyclic checkpoint initialization lineage")
    report_path, policy_path = directory / "report.json", directory / "policy.json"
    report, policy = read(report_path), read(policy_path)
    if report.get("status") not in {"completed", "early_stopped"}:
        raise ValueError(f"Cannot evaluate incomplete training: {directory}")
    training_path = directory / "training.json"
    if read(training_path).get("exitCode") != 0:
        raise ValueError(f"Cannot evaluate unsuccessful training: {directory}")
    checkpoint = track(directory / "best.pt", watched, report["checkpointSha256"])
    manifest_path = directory / "source-manifest.json"
    manifest = read(manifest_path)
    if not isinstance(manifest, list) or not manifest:
        raise ValueError(f"Missing actual training source manifest: {directory}")
    archived = []
    seen_sources = set()
    for source in manifest:
        relative = Path(source["path"])
        if relative.is_absolute() or ".." in relative.parts or str(relative) in seen_sources:
            raise ValueError(f"Invalid training source path: {directory}")
        seen_sources.add(str(relative))
        snapshot = directory / "source" / relative
        archived.append({"path": source["path"], "snapshot": str(snapshot),
                         "sha256": track(snapshot, watched, source["sha256"])})
    data_directory = absolute(report["dataDirectory"])
    data_files = []
    for split in ("train", "validation"):
        expected = report["data"][split]["sha256"]
        if policy["data"][split]["sha256"] != expected:
            raise ValueError(f"Training report/policy data mismatch: {directory}/{split}")
        path = data_directory / f"{split}.jsonl"
        data_files.append({"split": split, "path": str(path), "sha256": track(path, watched, expected)})
    record = {"trainingRun": str(directory), "checkpointSha256": checkpoint,
              "trainingStatus": report["status"], "trainingSeconds": report.get("seconds"),
              "bestEpoch": report.get("bestEpoch"),
              "trainingValidationExactMinimum": report.get("bestValidationExactMinimum"),
              "trainingReportSha256": track(report_path, watched),
              "trainingPolicySha256": track(policy_path, watched),
              "trainingProcessRecordSha256": track(training_path, watched),
              "actualTrainingSourceManifestSha256": track(manifest_path, watched),
              "actualTrainingSources": archived, "trainingData": data_files}
    initialization = report.get("initializationSource")
    if initialization:
        parent = inspect_run(initialization["directory"], watched, ancestors | {directory})
        if parent["checkpointSha256"] != initialization["checkpointSha256"]:
            raise ValueError(f"Warm-start checkpoint changed: {directory}")
        record["initializationLineage"] = parent
    return record


def training_data_files(model):
    yield from model["trainingData"]
    if model.get("initializationLineage"):
        yield from training_data_files(model["initializationLineage"])


def preflight(args):
    """Check identities and hash separation without examining any holdout labels."""
    if args.out.exists():
        raise ValueError(f"Refusing to reuse evaluation directory: {args.out}")
    if (args.holdout.parent / "consumed.json").exists():
        raise ValueError("Holdout already consumed; a fresh independent test is required")
    if args.candidate == args.baseline:
        raise ValueError("Candidate and baseline must identify different training runs")
    watched = {}
    models = {name: inspect_run(path, watched) for name, path in
              (("candidate", args.candidate), ("baseline", args.baseline))}
    data = {split: {"path": str(args.data / f"{split}.jsonl"),
                    "sha256": track(args.data / f"{split}.jsonl", watched)}
            for split in ("train", "validation")}
    dev_keys = {split: message_hashes(Path(info["path"])) for split, info in data.items()}
    separation = {"development_train_validation": len(dev_keys["train"] & dev_keys["validation"])}
    for split, info in data.items():
        languages = Counter()
        count = 0
        for row in rows(Path(info["path"])):
            if row.get("split") != split or row.get("trainingAllowed") is False or "independent" in str(row.get("source", "")).lower():
                raise ValueError(f"Independent or incorrectly split data cannot be development data: {split}")
            languages[row.get("language")] += 1
            count += 1
        if set(languages) != {"ar", "en"} or count != len(dev_keys[split]):
            raise ValueError(f"Invalid languages or duplicate normalized development messages: {split}")
        if split == "validation" and min(languages.values()) < 100:
            raise ValueError("At least 100 validation examples per language are required for calibration")
        info["languages"] = dict(languages)
    holdout_sha = track(args.holdout, watched)
    heldout = message_hashes(args.holdout)
    holdout_languages = Counter()
    holdout_ids = set()
    count = 0
    for row in rows(args.holdout):
        # Only metadata is checked here. Expected labels are not accessed.
        if (row.get("split") != "test_independent" or row.get("trainingAllowed") is not False
                or row.get("capability") != "ads.goal.v2" or row.get("language") not in {"ar", "en"}
                or not isinstance(row.get("id"), str) or not row["id"] or row["id"] in holdout_ids):
            raise ValueError("Invalid independent holdout metadata or duplicate IDs")
        holdout_ids.add(row["id"])
        holdout_languages[row["language"]] += 1
        count += 1
    if count != len(heldout) or set(holdout_languages) != {"ar", "en"} or min(holdout_languages.values()) < 100:
        raise ValueError("Holdout needs distinct normalized messages and at least 100 cases per language")
    checked = {}
    for model in models.values():
        for file in training_data_files(model):
            if file["path"] not in checked:
                checked[file["path"]] = message_hashes(Path(file["path"]))
            if file["split"] == "train":
                separation[f"calibration_validation_vs_training:{file['path']}"] = len(
                    dev_keys["validation"] & checked[file["path"]])
    for split, info in data.items():
        checked[info["path"]] = dev_keys[split]
    for path, keys in checked.items():
        separation[f"holdout_vs:{path}"] = len(heldout & keys)
    for previous in sorted((ROOT / "artifacts/ads-training").glob("independent-*/goal_independent.jsonl")):
        if previous.resolve() == args.holdout:
            continue
        track(previous, watched)
        previous_keys = message_hashes(previous)
        separation[f"holdout_vs_previous:{previous}"] = len(heldout & previous_keys)
        # Calibration/training must not contain a prior independent example either.
        for split in dev_keys:
            separation[f"development_{split}_vs_previous:{previous}"] = len(dev_keys[split] & previous_keys)
    if any(separation.values()):
        raise ValueError(f"Dataset separation failed: {dict((key, value) for key, value in separation.items() if value)}")
    return watched, models, data, {"sha256": holdout_sha, "rows": count,
                                  "languages": dict(holdout_languages)}, separation


def checked_execute(argv, destination, name, watched, echo=True):
    assert_unchanged(watched)
    execute(argv, destination, name, echo=echo)
    assert_unchanged(watched)


def verify_calibration(path, model, data, predictions, frozen_sources):
    calibration = read(path)
    if (calibration.get("method") != "minimum_decision_probability_v1" or calibration.get("usesFinalTest") is not False
            or calibration.get("checkpointSha256") != model["checkpointSha256"]
            or calibration.get("datasetSha256") != data["validation"]["sha256"]
            or calibration.get("answersSha256") != sha(predictions)
            or absolute(calibration.get("dataset", "")) != Path(data["validation"]["path"])
            or set(calibration.get("thresholds", {})) != {"ar", "en"}):
        raise ValueError("Calibration inputs do not match the frozen development experiment")
    sources = {absolute(item["path"]): item["sha256"] for item in frozen_sources}
    for item in calibration["sources"]:
        if sources.get(absolute(item["path"])) != item["sha256"]:
            raise ValueError("Calibration source is not part of the current inference freeze")
    for language in ("ar", "en"):
        metric = calibration["byLanguage"][language]
        threshold = calibration["thresholds"][language]
        if (any(metric.get(key) != expected for key, expected in CALIBRATION.items())
                or metric.get("rows") != data["validation"]["languages"][language]
                or not isinstance(threshold, (int, float)) or not math.isfinite(threshold)
                or not 0 <= threshold <= 1 or metric.get("threshold") != threshold):
            raise ValueError("Calibration target, coverage, or threshold differs from the fixed policy")
    return calibration


def evaluate(args):
    watched, models, data, holdout, separation = preflight(args)
    sources = [{"path": source, "sha256": track(ROOT / source, watched)} for source in SOURCES]
    current_by_path = {item["path"]: item["sha256"] for item in sources}
    for model in models.values():
        model["trainingToInferenceSourceDifferences"] = [source["path"] for source in model["actualTrainingSources"]
                                                         if current_by_path.get(source["path"]) != source["sha256"]]
    policy = {"schemaVersion": 1, "recordedAt": now(), "scope": "ads.goal.v2",
              "modelSelection": "Caller-designated candidate selected using development results only; no final-test selection",
              "trainingAndInferenceSourcesAreDistinct": True, "models": models,
              "currentInferenceSources": sources, "developmentData": data,
              "holdout": {"path": str(args.holdout), **holdout}, "criteria": CRITERIA,
              "acceptanceCalibration": {"data": str(args.data / "validation.jsonl"), **CALIBRATION,
                                        "usesFinalTest": False},
              "modelMadeDefault": False, "externalModels": False, "externalPretrainedWeights": False}
    write(args.out / "policy.json", policy)
    write(args.out / "separation.json", separation)
    write(args.out / "inference-source-manifest.json", sources)
    track(args.out / "policy.json", watched)
    for source in sources:
        destination = args.out / "inference-source" / source["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / source["path"], destination)
        track(destination, watched, source["sha256"])
    for name, model in models.items():
        directory = Path(model["trainingRun"])
        for filename in ("report.json", "policy.json", "training.json", "source-manifest.json"):
            destination = args.out / "training-records" / name / filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(directory / filename, destination)
            track(destination, watched, watched[(directory / filename).resolve()])
        for source in model["actualTrainingSources"]:
            destination = args.out / "training-records" / name / "source" / source["path"]
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source["snapshot"], destination)
            track(destination, watched, source["sha256"])
    calibrations = {}
    for name, model in models.items():
        directory = Path(model["trainingRun"])
        destination = args.out / "calibration" / name
        predictions = destination / "answers.jsonl"
        checked_execute([sys.executable, "-I", CLI, "answers", "--model", directory,
                         "--input", args.data / "validation.jsonl", "--output", predictions,
                         "--device", args.device], destination, "generation", watched)
        checked_execute(["node", ROOT / "node_modules/tsx/dist/cli.mjs", CALIBRATOR,
                         "--dataset", args.data / "validation.jsonl", "--answers", predictions,
                         "--checkpoint", directory / "best.pt", "--output", destination / "policy.json"],
                        destination, "calibration", watched)
        calibration_path = destination / "policy.json"
        calibrations[name] = verify_calibration(calibration_path, model, data, predictions, sources)
        track(calibration_path, watched)
        track(predictions, watched)
    # BOTH calibration policies and BOTH criteria are frozen before either model
    # is allowed to produce a prediction on the independent holdout.
    for name, model in models.items():
        calibration_path = args.out / "calibration" / name / "policy.json"
        calibration = calibrations[name]
        criteria = {"schemaVersion": 1, "id": f"{args.out.name}-{name}-{args.holdout.parent.name}",
                    "frozenAt": now(), "frozenBeforePredictions": True, "languages": ["ar", "en"],
                    "scope": "ads.goal.v2", "datasetSha256": holdout["sha256"],
                    "checkpointSha256": model["checkpointSha256"], **CRITERIA,
                    "acceptance": {"method": calibration["method"], "thresholds": calibration["thresholds"],
                                   "calibrationSha256": sha(calibration_path)},
                    "sourceFiles": sources + [{"path": str(calibration_path), "sha256": sha(calibration_path)},
                                               {"path": str(args.out / "policy.json"), "sha256": sha(args.out / "policy.json")}]}
        path = args.out / name / "criteria.json"
        write(path, criteria)
        with path.with_suffix(".sha256").open("x", encoding="ascii") as stream:
            stream.write(sha(path) + "\n")
        track(path, watched)
        track(path.with_suffix(".sha256"), watched)
    assert_unchanged(watched)
    write(args.holdout.parent / "consumed.json", {"consumedAt": now(), "status": "comparison_started",
          "datasetSha256": holdout["sha256"], "experiment": str(args.out), "trainingAllowed": False,
          "tuningAllowed": False, "selectionPolicySha256": sha(args.out / "policy.json"),
          "checkpoints": {name: model["checkpointSha256"] for name, model in models.items()}})
    assessments = {}
    for name, model in models.items():
        directory = Path(model["trainingRun"])
        destination = args.out / name
        predictions = destination / "answers.jsonl"
        started = now()
        checked_execute([sys.executable, "-I", CLI, "answers", "--model", directory,
                         "--input", args.holdout, "--output", predictions, "--device", args.device],
                        destination, "generation", watched)
        write(destination / "provenance.json", {"schemaVersion": 1,
              "checkpointSha256Before": model["checkpointSha256"], "checkpointSha256After": sha(directory / "best.pt"),
              "datasetSha256": holdout["sha256"], "answersSha256": sha(predictions),
              "criteriaSha256": sha(destination / "criteria.json"), "predictionsStartedAt": started,
              "predictionsFinishedAt": now(), "inferencePolicySha256": sha(args.out / "policy.json"),
              "actualTrainingSourceManifestSha256": model["actualTrainingSourceManifestSha256"]})
        checked_execute(["node", ROOT / "node_modules/tsx/dist/cli.mjs", SCORER,
                         "--criteria", destination / "criteria.json", "--dataset", args.holdout,
                         "--answers", predictions, "--provenance", destination / "provenance.json",
                         "--checkpoint", directory / "best.pt", "--output", destination / "assessment.json"],
                        destination, "scoring", watched, echo=False)
        assessment = read(destination / "assessment.json")
        if assessment["inputIntegrity"]["status"] != "passed":
            raise ValueError(f"{name} final assessment integrity failed")
        assessments[name] = {"status": assessment["status"], "byLanguage": assessment["metrics"]["byLanguage"],
                             "failures": assessment["failures"], "assessment": str(destination / "assessment.json"),
                             "checkpointSha256": model["checkpointSha256"], "trainingRun": str(directory),
                             "calibration": str(args.out / "calibration" / name / "policy.json"),
                             "trainingSourceManifestSha256": model["actualTrainingSourceManifestSha256"],
                             "trainingToInferenceSourceDifferences": model["trainingToInferenceSourceDifferences"]}
    assert_unchanged(watched)
    comparison = {"completedAt": now(), "scope": "Arabic/English ads goal extraction only",
                  "freshIndependentCases": holdout["rows"], "comparison": assessments,
                  "selectionPolicy": str(args.out / "policy.json"),
                  "currentInferenceSourceManifest": str(args.out / "inference-source-manifest.json"),
                  "trainingAndInferenceSourcesAreDistinct": True, "modelMadeDefault": False,
                  "productionReady": False, "humanReviewedHoldout": False,
                  "finalLabelsUsedToSelectCheckpoint": False, "finalLabelsUsedToCalibrateAcceptance": False}
    write(args.out / "comparison.json", comparison)
    write(args.holdout.parent / "comparison-complete.json", {"completedAt": now(),
          "comparison": str(args.out / "comparison.json"), "datasetSha256": holdout["sha256"]})
    print(json.dumps({"comparison": {name: {language: metric["rawExactAccuracy"] for language, metric
          in result["byLanguage"].items()} for name, result in assessments.items()}, "output": str(args.out / "comparison.json")}), flush=True)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("candidate", "baseline", "data", "holdout", "out"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--device", choices=("cuda", "cpu"), default="cuda")
    args = parser.parse_args()
    for name in ("candidate", "baseline", "data", "holdout", "out"):
        setattr(args, name, absolute(getattr(args, name)))
    evaluate(args)


if __name__ == "__main__":
    main()
