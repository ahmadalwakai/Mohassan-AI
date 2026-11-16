"""Run an isolated local experiment and a single frozen comparison on a fresh holdout.

No promotion, external model, or training on independent evaluation examples.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "packages/execution-pipeline/scripts/goal_tagger.py"
SCORER = ROOT / "scripts/ads-training/assess-goal-tagger.ts"
SOURCES = [
    "scripts/ads-training/goal.ts", "scripts/ads-training/pointer.ts",
    "scripts/ads-training/assess-goal-tagger.ts", "docs/ADS-GOAL-LABELING-GUIDE.md",
    "packages/execution-pipeline/execution_pipeline/goal_tagger.py",
    "packages/execution-pipeline/scripts/goal_tagger.py",
    "scripts/ads-training/generate-goal-tagger.ts",
    "scripts/ads-training/goal-grammar.ts", "scripts/ads-training/goal-grammar-ar.ts",
    "scripts/ads-training/goal-grammar-en.ts", "scripts/run-goal-tagger-experiment.py",
    "scripts/ads-training/goal-grammar-boundaries.ts",
    "scripts/filter-goal-tagger-data.py",
    "scripts/filter-goal-tagger-missing.py",
    "scripts/ads-training/calibrate-goal-tagger.ts",
    "scripts/prepare-goal-tagger-mixture.py",
]


def now():
    return datetime.now(timezone.utc).isoformat()


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def rows(path):
    with Path(path).open(encoding="utf-8-sig") as stream:
        for line in stream:
            if line.strip():
                yield json.loads(line)


def message_hashes(path):
    # Comparison only: the holdout text is never printed, used for training, or sent to a model here.
    return {hashlib.sha256(" ".join(row["input"]["message"].casefold().split()).encode()).hexdigest()
            for row in rows(path)}


def execute(argv, directory, name, echo=True):
    directory.mkdir(parents=True, exist_ok=True)
    started = now()
    with (directory / f"{name}.log").open("x", encoding="utf-8", newline="\n") as log:
        process = subprocess.Popen([str(arg) for arg in argv], cwd=ROOT, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
        try:
            for line in process.stdout:
                log.write(line)
                log.flush()
                if echo:
                    print(line, end="", flush=True)
            code = process.wait()
        except BaseException:
            process.terminate()
            process.wait()
            raise
    write(directory / f"{name}.json", {"argv": [str(arg) for arg in argv], "startedAt": started,
          "finishedAt": now(), "exitCode": code, "log": str(directory / f"{name}.log")})
    if code:
        raise RuntimeError(f"Command failed ({code}); see {directory / f'{name}.log'}")


def train(args):
    if args.run.exists():
        raise ValueError(f"Refusing to reuse experiment directory: {args.run}")
    train_hashes = message_hashes(args.data / "train.jsonl")
    validation_hashes = message_hashes(args.data / "validation.jsonl")
    overlaps = {"train_validation": len(train_hashes & validation_hashes)}
    for path in sorted((ROOT / "artifacts/ads-training").glob("independent-*/goal_independent.jsonl")):
        heldout = message_hashes(path)
        overlaps[f"{path.parent.name}_train"] = len(train_hashes & heldout)
        overlaps[f"{path.parent.name}_validation"] = len(validation_hashes & heldout)
    if any(overlaps.values()):
        raise ValueError(f"Dataset overlap detected: {overlaps}")
    files = {split: {"sha256": sha(args.data / f"{split}.jsonl"),
                    "languages": dict(Counter(row["language"] for row in rows(args.data / f"{split}.jsonl")))}
             for split in ("train", "validation")}
    policy = {"schemaVersion": 1, "recordedAt": now(), "scope": "ads.goal.v2",
              "minimumIndependentCasesPerLanguage": 100, "minimumRawExactAccuracy": 0.95,
              "minimumAcceptedPrecision": 0.99, "data": files, "separation": overlaps,
              "checkpointSelection": "Maximum minimum per-language validation accuracy; never final-test selection",
              "finalDataset": str(args.holdout), "finalUse": "One comparison after freezing both checkpoints",
              "externalModels": False, "externalPretrainedWeights": False, "modelMadeDefault": False,
              "trainingSettings": {key: getattr(args, key) for key in (
                  "epochs", "batch", "lr", "seed", "dropout", "entity_word_dropout",
                  "context_word_dropout", "word_variant_normalization", "patience",
                  "field_presence", "presence_warmup_epochs")},
              "baseline": str(args.baseline), "baselineCheckpointSha256": sha(args.baseline / "best.pt")}
    if args.calibrate_acceptance:
        policy.update({"calibratedAcceptance": True, "minimumAcceptedCoverage": 0.8,
                       "minimumAcceptedCasesPerLanguage": 100,
                       "acceptanceCalibration": "Development validation only, 99.5% target precision, >=80% coverage"})
    if args.initialize_from:
        policy["initializationSource"] = {"directory": str(args.initialize_from), "checkpointSha256": sha(args.initialize_from / "best.pt")}
    write(args.run / "policy.json", policy)
    for source in SOURCES:
        destination = args.run / "source" / source
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / source, destination)
    write(args.run / "source-manifest.json", [{"path": source, "sha256": sha(ROOT / source)} for source in SOURCES])
    command = [sys.executable, "-I", CLI, "train", "--data", args.data, "--out", args.run,
               "--epochs", args.epochs, "--batch", args.batch, "--lr", args.lr, "--seed", args.seed,
               "--dropout", args.dropout, "--entity-word-dropout", args.entity_word_dropout,
               "--context-word-dropout", args.context_word_dropout,
               "--word-variant-normalization", args.word_variant_normalization,
               "--patience", args.patience, "--device", "cuda"]
    if args.initialize_from:
        command += ["--initialize-from", args.initialize_from]
    if args.field_presence:
        command += ["--field-presence", "--presence-warmup-epochs", args.presence_warmup_epochs]
    execute(command, args.run, "training")
    report = read(args.run / "report.json")
    if report.get("status") not in {"completed", "early_stopped"}:
        raise ValueError("Training exited without a final report")
    if report["checkpointSha256"] != sha(args.run / "best.pt"):
        raise ValueError("Training report/checkpoint mismatch")
    print(json.dumps({"training": "completed", "epochs": len(report["log"]),
                      "seconds": report["seconds"], "best": report["bestValidationExactMinimum"]}), flush=True)


def calibrate(args):
    policy, report = read(args.run / "policy.json"), read(args.run / "report.json")
    if not policy.get("calibratedAcceptance") or report.get("status") not in {"completed", "early_stopped"}:
        raise ValueError("Calibration requires completed training and a predeclared policy")
    for source in read(args.run / "source-manifest.json"):
        if sha(ROOT / source["path"]) != source["sha256"]:
            raise ValueError(f"Source changed since training: {source['path']}")
    for name, model in (("candidate", args.run), ("baseline", args.baseline)):
        destination = args.run / "calibration" / name
        predictions = destination / "answers.jsonl"
        execute([sys.executable, "-I", CLI, "answers", "--model", model,
                 "--input", args.data / "validation.jsonl", "--output", predictions, "--device", "cuda"],
                destination, "generation")
        execute(["node", ROOT / "node_modules/tsx/dist/cli.mjs", ROOT / "scripts/ads-training/calibrate-goal-tagger.ts",
                 "--dataset", args.data / "validation.jsonl", "--answers", predictions,
                 "--checkpoint", model / "best.pt", "--output", destination / "policy.json"], destination, "calibration")


def evaluate(args):
    if (args.holdout.parent / "consumed.json").exists():
        raise ValueError("Holdout already consumed; author a fresh test for a new experiment")
    policy, report = read(args.run / "policy.json"), read(args.run / "report.json")
    if report.get("status") not in {"completed", "early_stopped"}:
        raise ValueError("Cannot evaluate an incomplete training run")
    if read(args.run / "training.json").get("exitCode") != 0:
        raise ValueError("Cannot evaluate an unsuccessful training run")
    if sha(args.run / "best.pt") != report["checkpointSha256"]:
        raise ValueError("Candidate checkpoint changed since training")
    if sha(args.baseline / "best.pt") != policy["baselineCheckpointSha256"]:
        raise ValueError("Baseline checkpoint changed since experiment start")
    for source in read(args.run / "source-manifest.json"):
        if sha(ROOT / source["path"]) != source["sha256"]:
            raise ValueError(f"Source changed since training: {source['path']}")
    heldout = message_hashes(args.holdout)
    separation = {}
    for dataset in (args.data, ROOT / "artifacts/ads-training/tagger-v1"):
        for split in ("train", "validation"):
            separation[f"{dataset.name}_{split}"] = len(heldout & message_hashes(dataset / f"{split}.jsonl"))
    for previous in sorted((ROOT / "artifacts/ads-training").glob("independent-*/goal_independent.jsonl")):
        if previous.resolve() != args.holdout.resolve():
            separation[previous.parent.name] = len(heldout & message_hashes(previous))
    if any(separation.values()):
        raise ValueError(f"Holdout overlaps previous data: {separation}")
    for split, expected in policy["data"].items():
        if sha(args.data / f"{split}.jsonl") != expected["sha256"]:
            raise ValueError("Training data changed during experiment")
    evaluation = args.run / "evaluation"
    write(evaluation / "separation.json", separation)
    source_files = [{"path": source, "sha256": sha(ROOT / source)} for source in SOURCES]
    pairs = [("candidate", args.run), ("baseline", args.baseline)]
    # Freeze BOTH models before producing either answer set. No candidate selection from this test.
    for name, model in pairs:
        criteria = {"schemaVersion": 1, "id": f"{args.run.name}-{name}-{args.holdout.parent.name}",
                    "frozenAt": now(), "frozenBeforePredictions": True, "languages": ["ar", "en"],
                    "scope": "ads.goal.v2", "datasetSha256": sha(args.holdout),
                    "checkpointSha256": sha(model / "best.pt"), "sourceFiles": source_files}
        for key in ("minimumIndependentCasesPerLanguage", "minimumRawExactAccuracy", "minimumAcceptedPrecision"):
            criteria[key] = policy[key]
        if policy.get("calibratedAcceptance"):
            calibration_path = args.run / "calibration" / name / "policy.json"
            calibration = read(calibration_path)
            if (calibration["checkpointSha256"] != sha(model / "best.pt")
                    or calibration["datasetSha256"] != policy["data"]["validation"]["sha256"]
                    or calibration["usesFinalTest"] is not False):
                raise ValueError("Calibration inputs do not match frozen experiment")
            for source in calibration["sources"]:
                if sha(ROOT / source["path"]) != source["sha256"]:
                    raise ValueError("Calibration source changed")
            criteria["acceptance"] = {"method": calibration["method"], "thresholds": calibration["thresholds"],
                                      "calibrationSha256": sha(calibration_path)}
            criteria["sourceFiles"] = source_files + [{"path": str(calibration_path), "sha256": sha(calibration_path)}]
            for key in ("minimumAcceptedCoverage", "minimumAcceptedCasesPerLanguage"):
                criteria[key] = policy[key]
        destination = evaluation / name
        write(destination / "criteria.json", criteria)
        with (destination / "criteria.sha256").open("x", encoding="ascii") as stream:
            stream.write(sha(destination / "criteria.json") + "\n")
    # Mark the test consumed BEFORE prediction, so an interruption cannot enable silent retuning/reuse.
    write(args.holdout.parent / "consumed.json", {"consumedAt": now(), "status": "comparison_started",
          "datasetSha256": sha(args.holdout), "experiment": str(args.run), "trainingAllowed": False,
          "tuningAllowed": False, "checkpoints": {name: sha(model / "best.pt") for name, model in pairs}})
    assessments = {}
    for name, model in pairs:
        destination = evaluation / name
        predictions = destination / "answers.jsonl"
        started, before = now(), sha(model / "best.pt")
        execute([sys.executable, "-I", CLI, "answers", "--model", model, "--input", args.holdout,
                 "--output", predictions, "--device", "cuda"], destination, "generation")
        write(destination / "provenance.json", {"schemaVersion": 1, "checkpointSha256Before": before,
              "checkpointSha256After": sha(model / "best.pt"), "datasetSha256": sha(args.holdout),
              "answersSha256": sha(predictions), "criteriaSha256": sha(destination / "criteria.json"),
              "predictionsStartedAt": started, "predictionsFinishedAt": now()})
        execute(["node", ROOT / "node_modules/tsx/dist/cli.mjs", SCORER,
                 "--criteria", destination / "criteria.json", "--dataset", args.holdout,
                 "--answers", predictions, "--provenance", destination / "provenance.json",
                 "--checkpoint", model / "best.pt", "--output", destination / "assessment.json"],
                destination, "scoring", echo=False)
        assessment = read(destination / "assessment.json")
        if assessment["inputIntegrity"]["status"] != "passed":
            raise ValueError(f"{name} assessment integrity failed")
        assessments[name] = {"status": assessment["status"], "byLanguage": assessment["metrics"]["byLanguage"],
                             "assessment": str(destination / "assessment.json"), "checkpointSha256": before}
    summary = {"completedAt": now(), "scope": "Arabic/English ads goal extraction only",
               "trainingSeconds": report["seconds"], "epochs": len(report["log"]),
               "freshIndependentCases": sum(1 for _ in rows(args.holdout)), "comparison": assessments,
               "modelMadeDefault": False, "productionReady": False,
               "humanReviewedHoldout": False, "finalLabelsUsedToSelectCheckpoint": False}
    write(evaluation / "comparison.json", summary)
    write(args.holdout.parent / "comparison-complete.json", {"completedAt": now(),
          "comparison": str(evaluation / "comparison.json"), "datasetSha256": sha(args.holdout)})
    print(json.dumps({"comparison": {name: {lang: values["rawExactAccuracy"]
          for lang, values in result["byLanguage"].items()} for name, result in assessments.items()},
          "output": str(evaluation / "comparison.json")}), flush=True)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["train", "calibrate", "evaluate"])
    parser.add_argument("--run", type=Path, default=ROOT / "artifacts/goal-tagger-runs/v2b")
    parser.add_argument("--data", type=Path, default=ROOT / "artifacts/ads-training/tagger-v2b-clean")
    parser.add_argument("--holdout", type=Path, default=ROOT / "artifacts/ads-training/independent-v3/goal_independent.jsonl")
    parser.add_argument("--baseline", type=Path, default=ROOT / "artifacts/goal-tagger-runs/v1")
    parser.add_argument("--epochs", type=int, default=10)
    parser.add_argument("--batch", type=int, default=256)
    parser.add_argument("--lr", type=float, default=0.0007)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--dropout", type=float, default=0.15)
    parser.add_argument("--entity-word-dropout", type=float, default=0.35)
    parser.add_argument("--context-word-dropout", type=float, default=0.35)
    parser.add_argument("--word-variant-normalization", choices=["none", "sqrt"], default="sqrt")
    parser.add_argument("--patience", type=int, default=4)
    parser.add_argument("--calibrate-acceptance", action="store_true")
    parser.add_argument("--initialize-from", type=Path, default=None)
    parser.add_argument("--field-presence", action="store_true")
    parser.add_argument("--presence-warmup-epochs", type=int, default=0)
    args = parser.parse_args()
    for name in ("run", "data", "holdout", "baseline"):
        setattr(args, name, getattr(args, name).resolve())
    if args.initialize_from:
        args.initialize_from = args.initialize_from.resolve()
    {"train": train, "calibrate": calibrate, "evaluate": evaluate}[args.command](args)


if __name__ == "__main__":
    main()
