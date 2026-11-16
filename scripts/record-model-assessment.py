"""Bind completed local predictions to immutable input and scratch-lineage evidence."""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUN = ROOT / "artifacts/execution-model-runs/text-b2-2026-11-12"
ASSESSMENT = ROOT / "artifacts/model-readiness-20261115"
INPUTS = ASSESSMENT / "evaluation-inputs-v3"
MODEL = RUN / "bilingual-code-v2"
EXPECTED = "ece9513215d72fae080bd72c216e08c8b1e3229e307275b3938d1a713948800d"


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def main():
    summary = read(MODEL / "answers/summary.json")
    manifest = read(INPUTS / "manifest.json")
    actual = digest(MODEL / "best.pt")
    if actual != EXPECTED or summary["checkpoint_sha256"] != EXPECTED or summary["checkpoint_step"] != 300:
        raise ValueError("Evaluated checkpoint changed")
    answer_files, dataset_files = {}, {}
    for split, source in manifest["files"].items():
        name = split + ".jsonl"
        data_hash = digest(INPUTS / name)
        answers = (MODEL / "answers" / name).read_text(encoding="utf-8").splitlines()
        metadata = (INPUTS / name).read_text(encoding="utf-8").splitlines()
        if data_hash != source["sha256"] or data_hash != summary[split]["dataset_sha256"]:
            raise ValueError("Frozen input hash mismatch: " + split)
        if len(answers) != source["rows"] or len(metadata) != source["rows"] or summary[split]["examples"] != source["rows"]:
            raise ValueError("Incomplete predictions: " + split)
        for prediction, original in zip(answers, metadata, strict=True):
            prediction, original = json.loads(prediction), json.loads(original)
            if any(prediction[key] != original[key] for key in ("id", "input", "capability")) or prediction["expected"] != original["output"]:
                raise ValueError("Prediction input mismatch: " + split)
        answer_files[name] = digest(MODEL / "answers" / name)
        dataset_files[name] = data_hash
    evidence = [
        RUN / "pretrain/settings.json", RUN / "pretrain/status.json", RUN / "pretrain/best.pt",
        RUN / "pointer-v3/settings.json", RUN / "pointer-v3/best.pt",
        RUN / "bilingual-code-v1/settings.json", RUN / "bilingual-code-v1/best.pt",
        MODEL / "settings.json", MODEL / "status.json", MODEL / "answers/summary.json",
        RUN / "tokenizer.json", RUN / "tokenizer-report.json",
        ROOT / "packages/execution-pipeline/execution_pipeline/pretrain.py",
        ROOT / "packages/execution-pipeline/execution_pipeline/ads_finetune.py",
        INPUTS / "manifest.json", ASSESSMENT / "criteria.json", Path(__file__),
    ]
    settings = read(MODEL / "settings.json")
    previous_settings = read(RUN / "bilingual-code-v1/settings.json")
    if settings["base_checkpoint_sha256"] != digest(RUN / settings["base"]):
        raise ValueError("Stage 2 base checkpoint mismatch")
    if previous_settings["base_checkpoint_sha256"] != digest(RUN / previous_settings["base"]):
        raise ValueError("Stage 1 base checkpoint mismatch")
    value = {
        "recordedAt": datetime.now(timezone.utc).isoformat(),
        "checkpointSha256": actual,
        "checkpointHashBeforeGeneration": EXPECTED,
        "checkpointHashAfterGeneration": actual,
        "checkpointStep": 300,
        "externalModelFallback": False,
        "externalPretrainedWeights": False,
        "initialization": "random",
        "localGeneration": True,
        "answerFiles": answer_files,
        "datasetFiles": dataset_files,
        "lineageEvidence": [{"path": str(path.relative_to(ROOT)), "sha256": digest(path)} for path in evidence],
        "lineage": ["randomly initialized ExecutionModel", "local pretrain/best.pt", "pointer-v3/best.pt", "bilingual-code-v1/best.pt", "bilingual-code-v2/best.pt"],
        "limitations": [
            "Historical pretraining and pointer-v3 provenance is supported by local artifacts and source audit, not a signed attestation.",
            "Results measure the declared bilingual Ads and bounded TypeScript contracts; they do not establish general programming ability.",
            "Independent cases and semantic review are machine-authored; no human review is claimed.",
        ],
    }
    output = ASSESSMENT / "generation-provenance.json"
    with output.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps({"output": str(output), "checkpoint": actual, "answerFiles": len(answer_files)}))


if __name__ == "__main__":
    main()
