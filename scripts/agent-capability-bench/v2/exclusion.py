"""Capability v2 exclusion list and custodian-only manifest generation."""

from __future__ import annotations

import argparse
from collections.abc import Iterable
from dataclasses import dataclass
from hashlib import sha256
import json
from pathlib import Path
import re
import unicodedata


REPO_ROOT = Path(__file__).resolve().parents[3]
BUNDLE = Path("tests/fixtures/agent-capability-bench/v2")
DEFAULT_MANIFEST = REPO_ROOT / BUNDLE / "exclusion/manifest.json"
PARTITIONS = ("sealed", "dev")
NORMALIZATION = "nfkc-arabic-casefold-whitespace-v1"

_LOCALE = r"[a-zA-Z]{2,3}(?:-[A-Za-z0-9]{2,8})*"
_MASSIVE = re.compile(rf"massive:(?:{_LOCALE}:)?([0-9]+)")
_MINTAKA = re.compile(rf"mintaka:([^:]+)(?::{_LOCALE})?")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_ARABIC_MARKS = re.compile(r"[\u0610-\u061a\u0640\u064b-\u065f\u0670\u06d6-\u06ed]")
_ARABIC_FOLD = str.maketrans(
    "أإآٱىیة٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹",
    "ااااييه01234567890123456789",
)


def normalize_text(text: str) -> str:
    """Fold NFKC, Arabic letters/marks/digits, Unicode case and whitespace."""
    text = unicodedata.normalize("NFKC", text).translate(_ARABIC_FOLD)
    text = _ARABIC_MARKS.sub("", text)
    return " ".join(text.casefold().split())


def text_sha256(text: str) -> str:
    return sha256(normalize_text(text).encode("utf-8")).hexdigest()


def source_id_key(source_id: str) -> str:
    """Use MASSIVE and Mintaka native IDs to catch their parallel translations."""
    massive = _MASSIVE.fullmatch(source_id)
    if massive:
        return f"massive:{massive[1]}"
    mintaka = _MINTAKA.fullmatch(source_id)
    if mintaka:
        return f"mintaka:{mintaka[1]}"
    return source_id


@dataclass(frozen=True)
class Exclusions:
    source_ids: frozenset[str]
    text_hashes: frozenset[str]

    @classmethod
    def load(cls, path: Path = DEFAULT_MANIFEST) -> Exclusions:
        """Read and verify both exclusion partitions without opening benchmark payloads."""
        manifest = json.loads(path.read_bytes())
        if (manifest.get("schema_version") != 1 or manifest.get("normalization") != NORMALIZATION
                or set(manifest.get("partitions", {})) != set(PARTITIONS)):
            raise ValueError("Invalid capability v2 exclusion manifest.")
        source_ids = set()
        text_hashes = set()
        for name in PARTITIONS:
            partition = manifest["partitions"][name]
            data = path.with_name(f"{name}.jsonl").read_bytes()
            if sha256(data).hexdigest() != partition["entries_sha256"]:
                raise ValueError(f"Capability v2 {name} exclusion checksum mismatch.")
            lines = data.splitlines()
            if not lines or len(lines) != partition["case_count"]:
                raise ValueError(f"Capability v2 {name} exclusion count mismatch.")
            for line in lines:
                item = json.loads(line)
                source_id = item["source_id"]
                hashes = item["text_sha256"]
                if (not isinstance(source_id, str) or not source_id.partition(":")[2]
                        or source_id in source_ids or not isinstance(hashes, list) or not hashes
                        or not all(isinstance(digest, str) and _SHA256.fullmatch(digest) for digest in hashes)):
                    raise ValueError(f"Invalid capability v2 {name} exclusion entry.")
                source_ids.add(source_id)
                text_hashes.update(hashes)
        return cls(frozenset(map(source_id_key, source_ids)), frozenset(text_hashes))

    def matches(
        self,
        texts: str | Iterable[str],
        *,
        source_id: str | None = None,
        source_ids: Iterable[str] = (),
    ) -> bool:
        """Drop the whole training row when any text or its source item matches."""
        if source_id is not None and source_id_key(source_id) in self.source_ids:
            return True
        if any(source_id_key(alias) in self.source_ids for alias in source_ids):
            return True
        if isinstance(texts, str):
            return text_sha256(texts) in self.text_hashes
        return any(text_sha256(text) in self.text_hashes for text in texts)


def benchmark_texts(case: dict) -> tuple[str, ...]:
    """Compare product inputs and native text recoverable from the v2 mapping."""
    dataset = case["provenance"]["source"].partition(":")[0]
    texts = []
    for turn in case["turns"]:
        text = turn["text"]
        texts.append(text)
        texts.extend(turn.get("fields", {}).values())
        if dataset == "canard":
            _, marker, question = text.partition("\nFinal question: ")
            if not marker:
                raise ValueError("Invalid capability v2 CANARD input mapping.")
            texts.append(question)
            # The human rewrite is a candidate target in the head-training kit.
            texts.extend(turn["expect"]["requiredContent"][0]["anyOf"])
        elif dataset == "mbpp":
            prompt, marker, _ = text.partition("\n\nYour code should pass these tests:\n")
            if not marker:
                raise ValueError("Invalid capability v2 MBPP input mapping.")
            texts.append(prompt)
    return tuple(text for text in dict.fromkeys(texts) if normalize_text(text))


def _read_release(repo_root: Path, partition: str) -> tuple[str, list[dict]]:
    if partition == "sealed":
        manifest_rel = Path("scripts/agent-capability-bench/v2/manifest.json")
        manifest_key = "sealed"
    elif partition == "dev":
        manifest_rel = BUNDLE / "dev/manifest.json"
        manifest_key = "development"
    else:
        raise ValueError(f"Unknown capability v2 partition: {partition}.")

    manifest = json.loads((repo_root / manifest_rel).read_bytes())
    data = (repo_root / BUNDLE / partition / "payload.json").read_bytes()
    digest = sha256(data).hexdigest()
    if digest != manifest[manifest_key]["sha256"] or digest != manifest["files"]["payload.json"]:
        raise ValueError(f"Capability v2 {partition} payload checksum mismatch.")
    payload = json.loads(data)
    cases = payload["cases"]
    if (manifest["schemaVersion"] != 2 or payload["schemaVersion"] != 2
            or manifest["mappingVersion"] != 1 or payload["mappingVersion"] != 1
            or len(cases) != manifest[manifest_key]["caseCount"]):
        raise ValueError(f"Invalid capability v2 {partition} release.")
    return digest, cases


def read_benchmark(repo_root: Path = REPO_ROOT, *, partitions: Iterable[str] = PARTITIONS) -> dict[str, list[dict]]:
    """Load release-pinned v2 cases for an authorized custodian audit."""
    return {name: _read_release(repo_root, name)[1] for name in partitions}


def _json_line(value: dict) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")


def build_exclusion_files(repo_root: Path = REPO_ROOT) -> dict[str, bytes]:
    files = {}
    partitions = {}
    for name in PARTITIONS:
        payload_digest, cases = _read_release(repo_root, name)
        entries = []
        source_ids = set()
        for case in sorted(cases, key=lambda case: case["provenance"]["source"]):
            source_id = case["provenance"]["source"]
            hashes = sorted({text_sha256(text) for text in benchmark_texts(case)})
            if case["provenance"]["author"] != "human" or not hashes or source_id in source_ids:
                raise ValueError(f"Invalid capability v2 {name} case for exclusion generation.")
            source_ids.add(source_id)
            entries.append(_json_line({"source_id": source_id, "text_sha256": hashes}))
        data = b"".join(entries)
        files[f"{name}.jsonl"] = data
        partitions[name] = {
            "case_count": len(cases),
            "entries_sha256": sha256(data).hexdigest(),
            "payload_sha256": payload_digest,
        }
    files["manifest.json"] = _json_line({
        "schema_version": 1, "normalization": NORMALIZATION, "partitions": partitions,
    })
    return files


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate v2 training exclusions from verified release bytes.")
    parser.add_argument("--check", action="store_true", help="Verify the committed files without writing them.")
    args = parser.parse_args()
    files = build_exclusion_files()
    if not args.check:
        DEFAULT_MANIFEST.parent.mkdir(exist_ok=True)
    for filename, data in files.items():
        path = DEFAULT_MANIFEST.with_name(filename)
        if args.check:
            if path.read_bytes() != data:
                raise SystemExit(f"Unexpected capability v2 exclusion file: {filename}")
        else:
            path.write_bytes(data)
    exclusions = Exclusions.load()
    summary = {name: len(files[f"{name}.jsonl"].splitlines()) for name in PARTITIONS}
    summary.update(source_item_keys=len(exclusions.source_ids), distinct_text_hashes=len(exclusions.text_hashes))
    print(json.dumps(summary, sort_keys=True))


if __name__ == "__main__":
    main()
