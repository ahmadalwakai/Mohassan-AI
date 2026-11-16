"""Train and compare only on explicitly supplied, previously consumed development sets.

Never discovers or opens fresh holdouts. Results from this runner are development
diagnostics, not an independent accuracy claim or permission to promote a model.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "packages/execution-pipeline/scripts/goal_tagger.py"
SCORER = ROOT / "scripts/ads-training/score-goal-answers.ts"
SOURCES = [
    "scripts/run-goal-tagger-development.py", "scripts/ads-training/goal.ts",
    "scripts/ads-training/pointer.ts", "scripts/ads-training/lib.ts",
    "scripts/ads-training/score-goal-answers.ts", "docs/ADS-GOAL-LABELING-GUIDE.md",
    "scripts/ads-training/generate-goal-tagger.ts",
    "packages/execution-pipeline/execution_pipeline/goal_tagger.py",
    "packages/execution-pipeline/execution_pipeline/lexicon.py",
    "packages/execution-pipeline/scripts/goal_tagger.py",
]
SETTINGS = ("epochs", "batch", "lr", "width", "layers", "seed", "dropout", "weight_decay",
            "entity_word_dropout", "context_word_dropout", "invented_name_probability",
            "word_variant_normalization", "patience", "field_presence", "presence_warmup_epochs", "device")


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


def message_key(row):
    return hashlib.sha256(" ".join(row["input"]["message"].casefold().split()).encode()).hexdigest()


def inspect_dataset(path, split=None):
    keys, ids, languages = set(), set(), Counter()
    for row in rows(path):
        if split is not None and (row.get("split") != split or row.get("trainingAllowed") is not True
                                  or "independent" in str(row.get("source", "")).lower()):
            raise ValueError(f"Training data must contain only allowed {split} examples: {path}")
        if row.get("language") not in {"ar", "en"}:
            raise ValueError(f"Invalid language in {path}")
        key = message_key(row)
        identifier = row.get("id")
        if key in keys or not identifier or identifier in ids:
            raise ValueError(f"Duplicate message or missing/duplicate ID in {path}")
        keys.add(key)
        ids.add(identifier)
        languages[row["language"]] += 1
    if set(languages) != {"ar", "en"}:
        raise ValueError(f"Both languages are required in {path}")
    return {"path": str(path), "sha256": sha(path), "rows": len(keys), "languages": dict(languages)}, keys


def inspect_consumed(path):
    # Check the marker BEFORE opening or hashing the dataset. A fresh test must stay unread.
    marker = path.parent / "consumed.json"
    if not marker.is_file():
        raise ValueError(f"Development dataset has no prior consumption record; refusing to read: {path}")
    consumption = read(marker)
    if not consumption.get("consumedAt") or not consumption.get("datasetSha256"):
        raise ValueError(f"Invalid consumption record: {marker}")
    if sha(path) != consumption["datasetSha256"]:
        raise ValueError(f"Consumed dataset differs from its recorded hash: {path}")
    info, keys = inspect_dataset(path)
    info.update({"consumptionRecord": str(marker), "consumptionRecordSha256": sha(marker),
                 "use": "previously_consumed_development_only"})
    return info, keys


def execute(argv, directory, name, echo=True):
    directory.mkdir(parents=True, exist_ok=True)
    started = now()
    code = None
    failure = None
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
        except BaseException as exc:
            failure = type(exc).__name__
            process.terminate()
            code = process.wait()
            raise
        finally:
            write(directory / f"{name}.json", {"argv": [str(arg) for arg in argv], "startedAt": started,
                  "finishedAt": now(), "exitCode": code, "interruption": failure,
                  "log": str(directory / f"{name}.log")})
    if code:
        raise RuntimeError(f"Command failed ({code}); see {directory / f'{name}.log'}")


def train(args):
    if args.run.exists():
        raise ValueError(f"Refusing to reuse run directory: {args.run}")
    files, keys = {}, {}
    for split in ("train", "validation"):
        files[split], keys[split] = inspect_dataset(args.data / f"{split}.jsonl", split)
    overlaps = {"train_validation": len(keys["train"] & keys["validation"])}
    development = []
    for index, path in enumerate(args.development):
        info, dev_keys = inspect_consumed(path)
        development.append(info)
        for split in keys:
            overlaps[f"development_{index}_{split}"] = len(keys[split] & dev_keys)
    if any(overlaps.values()):
        raise ValueError(f"Dataset overlap detected: {overlaps}")
    policy = {"schemaVersion": 1, "recordedAt": now(), "scope": "ads.goal.v2-development-only",
              "data": files, "separation": overlaps, "development": development,
              "trainingSettings": {key: getattr(args, key) for key in SETTINGS},
              "baseline": str(args.baseline), "baselineCheckpointSha256": sha(args.baseline / "best.pt"),
              "checkpointSelection": "maximum_minimum_per_language_synthetic_validation_pointer_exact",
              "developmentGate": {"noRegressionPerSetAndLanguage": True, "positiveAggregateGain": True,
                                  "minimumAggregateRawExactPerLanguage": 0.95,
                                  "acceptedPrecisionNotEstablished": True},
              "freshHoldoutsRead": False, "independentAccuracyClaim": False, "modelMadeDefault": False,
              "externalModels": False, "externalPretrainedWeights": False}
    for name, path, filename in (("initializationSource", args.initialize_from, "best.pt"),
                                 ("lexiconSource", args.lexicon, "lexicon.pt")):
        if path is not None:
            policy[name] = {"directory": str(path), "sha256": sha(path / filename)}
    manifests = [("dataManifest", args.data / "manifest.json")]
    if args.service_phrases:
        manifests += [("servicePhrases", args.service_phrases),
                      ("servicePhrasesManifest", args.service_phrases.parent / "manifest.json")]
    for name, path in manifests:
        if path.is_file():
            policy[name] = {"path": str(path), "sha256": sha(path)}
    sources = list(SOURCES)
    sources += [str(path.relative_to(ROOT)).replace("\\", "/")
                for path in sorted((ROOT / "scripts/ads-training").glob("goal-grammar*.ts"))]
    extractor = "scripts/ads-training/extract_service_phrases.py"
    if (ROOT / extractor).is_file():
        sources.append(extractor)
    source_hashes = [{"path": path, "sha256": sha(ROOT / path)} for path in sources]
    write(args.run / "policy.json", policy)
    for source in source_hashes:
        destination = args.run / "source" / source["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / source["path"], destination)
        if sha(destination) != source["sha256"]:
            raise ValueError("Source changed while snapshotting")
    write(args.run / "source-manifest.json", source_hashes)
    command = [sys.executable, "-I", CLI, "train", "--data", args.data, "--out", args.run]
    for key in SETTINGS:
        value = getattr(args, key)
        if key == "field_presence":
            if value:
                command.append("--field-presence")
        elif value is not None:
            command += ["--" + key.replace("_", "-"), value]
    for key in ("initialize_from", "lexicon"):
        if getattr(args, key) is not None:
            command += ["--" + key.replace("_", "-"), getattr(args, key)]
    execute(command, args.run, "training")
    assert_frozen(args.run)


def assert_frozen(run):
    policy, report = read(run / "policy.json"), read(run / "report.json")
    if report.get("status") not in {"completed", "early_stopped"}:
        raise ValueError("Training is incomplete")
    if read(run / "training.json").get("exitCode") != 0:
        raise ValueError("Training process was unsuccessful")
    if sha(run / "best.pt") != report["checkpointSha256"]:
        raise ValueError("Candidate checkpoint differs from training report")
    watched = [(Path(policy["baseline"]) / "best.pt", policy["baselineCheckpointSha256"])]
    for split, info in policy["data"].items():
        if report["data"][split]["sha256"] != info["sha256"]:
            raise ValueError("Training data differs from predeclared policy")
        watched.append((Path(info["path"]), info["sha256"]))
    for info in policy["development"]:
        current, _ = inspect_consumed(Path(info["path"]))
        if current != info:
            raise ValueError("Development input changed since freeze")
    for source in read(run / "source-manifest.json"):
        watched += [(ROOT / source["path"], source["sha256"]),
                    (run / "source" / source["path"], source["sha256"])]
    for name, filename in (("initializationSource", "best.pt"), ("lexiconSource", "lexicon.pt")):
        if name in policy:
            info = policy[name]
            watched.append((Path(info["directory"]) / filename, info["sha256"]))
    for name in ("dataManifest", "servicePhrases", "servicePhrasesManifest"):
        if name in policy:
            watched.append((Path(policy[name]["path"]), policy[name]["sha256"]))
    for path, expected in watched:
        if sha(path) != expected:
            raise ValueError(f"Frozen input changed: {path}")
    return policy, report


def gate(comparisons, minimum=0.95):
    aggregate = {name: {language: {"rows": 0, "rawExact": 0} for language in ("ar", "en")}
                 for name in ("candidate", "baseline")}
    no_regression = True
    for comparison in comparisons:
        for language in ("ar", "en"):
            candidate, baseline = [comparison[name][language] for name in ("candidate", "baseline")]
            if candidate["rows"] != baseline["rows"] or candidate["rows"] <= 0:
                raise ValueError("Candidate/baseline case counts differ or are empty")
            no_regression &= candidate["rawExact"] >= baseline["rawExact"]
            for name in aggregate:
                for key in ("rows", "rawExact"):
                    aggregate[name][language][key] += comparison[name][language][key]
    for language_metrics in aggregate.values():
        for metrics in language_metrics.values():
            metrics["rawExactAccuracy"] = metrics["rawExact"] / metrics["rows"] if metrics["rows"] else 0
    gain = sum(aggregate["candidate"][lang]["rawExact"] - aggregate["baseline"][lang]["rawExact"]
               for lang in ("ar", "en"))
    improved = bool(no_regression and gain > 0)
    return {"aggregate": aggregate, "noRegressionPerSetAndLanguage": bool(no_regression),
            "aggregateExactGain": gain, "improved": improved,
            "finalGateReached": improved and all(aggregate["candidate"][lang]["rawExactAccuracy"] >= minimum
                                                  for lang in ("ar", "en")),
            "acceptedPrecisionEstablished": False, "independentAccuracyClaim": False}


def evaluate(args):
    policy, report = assert_frozen(args.run)
    destination = args.run / "development"
    if destination.exists():
        raise ValueError(f"Refusing to reuse development output directory: {destination}")
    comparisons = []
    for index, info in enumerate(policy["development"]):
        comparison = {"dataset": info["path"], "datasetSha256": info["sha256"]}
        for name, model in (("candidate", args.run), ("baseline", Path(policy["baseline"]))):
            out = destination / f"{index + 1}-{Path(info['path']).parent.name}" / name
            predictions = out / "answers.jsonl"
            before = sha(model / "best.pt")
            execute([sys.executable, "-I", CLI, "answers", "--model", model, "--input", info["path"],
                     "--output", predictions, "--device", policy["trainingSettings"]["device"]], out, "generation")
            execute(["node", ROOT / "node_modules/tsx/dist/cli.mjs", SCORER,
                     "--answers", predictions, "--output", out / "assessment.json"], out, "scoring", echo=False)
            after = sha(model / "best.pt")
            if before != after:
                raise ValueError("Checkpoint changed during development evaluation")
            write(out / "provenance.json", {"checkpointSha256Before": before, "checkpointSha256After": after,
                  "datasetSha256": info["sha256"], "answersSha256": sha(predictions),
                  "assessmentSha256": sha(out / "assessment.json"), "developmentOnly": True})
            comparison[name] = read(out / "assessment.json")["byLanguage"]
        comparisons.append(comparison)
    assert_frozen(args.run)
    result = {"completedAt": now(), "checkpointSha256": report["checkpointSha256"],
              "comparisons": comparisons, "gate": gate(comparisons, policy["developmentGate"]["minimumAggregateRawExactPerLanguage"]),
              "freshHoldoutsRead": False, "modelMadeDefault": False, "productionReady": False}
    write(destination / "comparison.json", result)
    print(json.dumps(result, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=("all", "train", "evaluate"), default="all")
    parser.add_argument("--run", required=True, type=Path)
    for name in ("data", "baseline", "initialize-from", "lexicon", "service-phrases"):
        parser.add_argument("--" + name, type=Path)
    parser.add_argument("--development", type=Path, action="append", default=[])
    for name, default in (("epochs", 6), ("batch", 256), ("width", 256), ("layers", 4),
                          ("seed", 71), ("patience", 3), ("presence-warmup-epochs", 0)):
        parser.add_argument("--" + name, type=int, default=default)
    for name, default in (("lr", 0.0001), ("dropout", 0.15), ("weight-decay", 0.01),
                          ("entity-word-dropout", 0.35), ("context-word-dropout", 0.35),
                          ("invented-name-probability", None)):
        parser.add_argument("--" + name, type=float, default=default)
    parser.add_argument("--word-variant-normalization", choices=("none", "sqrt"), default="sqrt")
    parser.add_argument("--field-presence", action="store_true")
    parser.add_argument("--device", choices=("cuda", "cpu"), default="cuda")
    args = parser.parse_args()
    for name in ("run", "data", "baseline", "initialize_from", "lexicon", "service_phrases"):
        value = getattr(args, name)
        if value is not None:
            setattr(args, name, value.resolve())
    args.development = [path.resolve() for path in args.development]
    if len(set(args.development)) != len(args.development):
        parser.error("Development paths must be distinct")
    if args.phase != "evaluate":
        if args.data is None or args.baseline is None or not args.development:
            parser.error("Training requires --data, --baseline and at least one --development")
        if args.service_phrases and not args.service_phrases.is_file():
            parser.error("--service-phrases must identify an existing file")
        if min(args.epochs, args.batch, args.width, args.layers) <= 0 or args.width % 4:
            parser.error("Invalid training sizes")
        if not math.isfinite(args.lr) or args.lr <= 0 or not math.isfinite(args.weight_decay) or args.weight_decay < 0:
            parser.error("Invalid learning rate or weight decay")
        if args.patience < 0 or args.presence_warmup_epochs < 0 or not 0 <= args.dropout < 1:
            parser.error("Invalid patience, presence warmup or dropout")
        for value in (args.entity_word_dropout, args.context_word_dropout, args.invented_name_probability):
            if value is not None and not 0 <= value <= 1:
                parser.error("Augmentation probabilities must be in [0, 1]")
        train(args)
    if args.phase != "train":
        evaluate(args)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
