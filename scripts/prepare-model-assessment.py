"""Freeze local final assessment inputs without adding them to any training split."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "artifacts/model-readiness-20261115/evaluation-inputs-v3"
SOURCES = {
    "goal_independent": ROOT / "artifacts/ads-training/independent-v1/goal_independent.jsonl",
    "site_independent": ROOT / "artifacts/ads-training/independent-v1/site_independent.jsonl",
    "site_test": ROOT / "artifacts/ads-training/pointer-v3/site_test.jsonl",
    "code_test": ROOT / "artifacts/code-training/bilingual-v1/code_test.jsonl",
    "code_unseen": ROOT / "artifacts/code-training/bilingual-v1/code_unseen.jsonl",
    "code_independent": ROOT / "artifacts/code-training/independent-v1/code_independent.jsonl",
}


def main() -> None:
    if DEST.exists():
        raise FileExistsError(f"Assessment inputs are immutable: {DEST}")
    prepared, files, seen = {}, {}, set()
    for name, source in SOURCES.items():
        raw = source.read_bytes()
        rows = [json.loads(line) for line in raw.decode("utf-8").splitlines() if line.strip()]
        for row in rows:
            if not isinstance(row.get("id"), str) or row["id"] in seen:
                raise ValueError("Duplicate or invalid assessment identity")
            seen.add(row["id"])
            if name == "site_test":
                row["language"] = "en"
            if row.get("language") not in {"ar", "en"}:
                raise ValueError(f"Missing assessment language in {name}")
        # Preserve independent authoring digests exactly. Only the legacy English
        # site file needs missing language metadata supplied by its documented source.
        encoded = raw if name != "site_test" else ("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n").encode("utf-8")
        prepared[name] = encoded
        files[name] = {"rows": len(rows), "sha256": hashlib.sha256(encoded).hexdigest(),
                       "source": str(source.relative_to(ROOT)), "source_sha256": hashlib.sha256(raw).hexdigest()}
    english_sites = [json.loads(line) for line in prepared["site_test"].decode().splitlines()]
    selected = sorted(english_sites, key=lambda row: hashlib.sha256(row["id"].encode()).hexdigest())[:20]
    manifest = {"purpose": "final_local_model_assessment", "trainingAllowed": False, "tuningAllowed": False,
                "files": files, "english_site_semantic_review_ids": [row["id"] for row in selected],
                "selection": "First 20 English site IDs by SHA256(id), fixed before predictions; all 20 Arabic sites."}
    DEST.mkdir(parents=True)
    for name, encoded in prepared.items():
        (DEST / f"{name}.jsonl").write_bytes(encoded)
    (DEST / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"directory": str(DEST), "counts": {name: data["rows"] for name, data in files.items()},
                      "english_review_count": len(selected)}, indent=2))


if __name__ == "__main__":
    main()
