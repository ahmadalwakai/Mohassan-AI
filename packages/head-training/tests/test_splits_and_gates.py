import json
import subprocess
from hashlib import sha256
from pathlib import Path

import pytest

from head_training.datasets import Example
from head_training.gates import write_gate_packet
from head_training.lineage import verify_corpus_lineage
from head_training.splits import (
    public_group_sha256,
    read_sealed_reference,
    split_examples,
)


def example(identifier, *, group=None, split="unsplit", source="fixture", text=None):
    return Example(
        id=identifier, source=source, group=group or identifier, upstream_split=split,
        language="en", task="intent", text=text or f"Example {identifier}", label="test-intent",
    )


def receipt(tmp_path, **overrides):
    path = tmp_path / "owner-receipt.json"
    record = {
        "schema_version": 1,
        "path": "private/sealed.jsonl",
        "sha256": "a" * 64,
        "reviewer": "Fixture owner",
        "review_kind": "owner_authored",
        "reviewed_at": "2026-11-25T00:00:00+00:00",
        **overrides,
    }
    path.write_text(json.dumps(record), encoding="utf-8")
    return path


def test_partition_is_seeded_order_independent_and_preserves_group_boundaries():
    rows = [example(f"row-{i}", group=f"group-{i // 2}") for i in range(70)]
    left = split_examples(rows, seed=19)
    right = split_examples(reversed(rows), seed=19)
    assert left == right
    assert left.fingerprints != split_examples(rows, seed=20).fingerprints
    phases = [left.train, left.development, left.calibration]
    group_sets = [{row.group for row in phase} for phase in phases]
    assert all(group_sets)
    assert sum(map(len, group_sets)) == len(set.union(*group_sets))
    assert sum(map(len, phases)) == len(rows)
    assert left.fingerprints["sealed"] is None


def test_upstream_and_owner_exclusions_reserve_groups_and_matching_inputs(tmp_path):
    source_receipt = receipt(tmp_path, excluded_group_sha256=[public_group_sha256("public-owner-group")])
    sealed = read_sealed_reference(source_receipt)
    rows = [example(f"train-{i}", split="train") for i in range(8)] + [
        example("development-1", split="dev"),
        example("development-2", split="dev"),
        example("upstream-test", group="test-article", split="test", text="   KEEP together "),
        example("duplicate", source="cross-source", group="different-article", text="keep together"),
        example("related", source="cross-source", group="different-article"),
        example("owner-selection", group="public-owner-group"),
    ]
    data = split_examples(rows, sealed=sealed)
    assert data.sealed is sealed
    assert data.fingerprints["sealed"] == "a" * 64
    assert data.reserved_count == 3
    assert {row.id for row in data.train} == {f"train-{i}" for i in range(8)}
    assert {row.id for row in (*data.development, *data.calibration)} == {"development-1", "development-2", "related"}
    assert not sealed.path.exists()


def test_frequent_utterances_do_not_merge_unrelated_dialogues():
    rows = [
        row
        for i in range(50)
        for row in (example(f"yes-{i}", group=f"dialogue-{i}", text="Yes"),
                    example(f"question-{i}", group=f"dialogue-{i}"))
    ]
    splits = split_examples(rows)
    phases = [splits.train, splits.development, splits.calibration]
    assert all(phases)
    assert sum(any(row.text == "Yes" for row in phase) for phase in phases) == 1
    assert splits.duplicate_count > 0
    assert sum(map(len, phases)) + splits.duplicate_count == len(rows)


@pytest.mark.parametrize("overrides", [
    {"review_kind": "public_benchmark"},
    {"reviewed_at": "2026-11-25T00:00:00"},
    {"sha256": "A" * 64},
    {"excluded_group_sha256": ["malformed"]},
    {"path": "owner-receipt.json"},
])
def test_sealed_reference_requires_owner_review_and_distinct_pinned_cases(tmp_path, overrides):
    with pytest.raises(ValueError, match="sealed reference|sealed cases"):
        read_sealed_reference(receipt(tmp_path, **overrides))


def test_router_packet_is_write_once_and_does_not_open_sealed_cases(tmp_path, monkeypatch):
    sealed = read_sealed_reference(receipt(tmp_path))
    candidate, baseline = tmp_path / "worker.json", tmp_path / "rules.ts"
    candidate.write_bytes(b"candidate artifact")
    baseline.write_bytes(b"rules artifact")
    artifact_pins = {
        "candidate": candidate, "candidate_sha256": sha256(candidate.read_bytes()).hexdigest(),
        "baseline": baseline, "baseline_sha256": sha256(baseline.read_bytes()).hexdigest(),
    }
    open_path = Path.open

    def tracked_open(path, *args, **kwargs):
        assert path != sealed.path
        return open_path(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", tracked_open)
    output = tmp_path / "gate"
    registration = write_gate_packet(
        output, head="H1", sealed=sealed, **artifact_pins,
        extra_rule={"minimum_counts": {"languages": {"ar": 25}}},
        command=["fixture-command"], max_ece=0.25, evaluation={"head_manifest_sha256": "b" * 64},
    )
    parsed = json.loads(registration.read_text(encoding="utf-8"))
    assert parsed["cases"] == {
        "path": str(sealed.path), "sha256": "a" * 64, "sealed": True, "allow_reuse": False,
    }
    assert parsed["candidate"]["sha256"] == artifact_pins["candidate_sha256"]
    assert parsed["rule"] == {
        "test": {"name": "mcnemar_exact", "alpha": 0.05},
        "minimum_counts": {"overall": 150, "languages": {"ar": 25}},
        "classifier": {"ece_bins": 15, "max_ece": 0.25, "router": True, "max_wrong_confidence": 0.8},
    }
    handoff = json.loads((output / "handoff.json").read_text(encoding="utf-8"))
    assert handoff["command"] == ["fixture-command"]
    assert handoff["evaluation"] == {"head_manifest_sha256": "b" * 64}
    assert handoff["sealed_review"]["receipt_sha256"] == sealed.receipt_sha256
    with pytest.raises(FileExistsError):
        write_gate_packet(output, head="H1", sealed=sealed, **artifact_pins)
    with pytest.raises(ValueError, match="cannot weaken.*minimum_counts"):
        write_gate_packet(
            tmp_path / "weak", head="H1", sealed=sealed, **artifact_pins,
            extra_rule={"minimum_counts": {"overall": 149}},
        )
    with pytest.raises(ValueError, match="artifact SHA-256 mismatch"):
        write_gate_packet(
            tmp_path / "tampered", head="H4", sealed=sealed,
            **(artifact_pins | {"candidate_sha256": "f" * 64}),
        )
    assert not (tmp_path / "weak").exists()
    assert not (tmp_path / "tampered").exists()


def test_corpus_lineage_uses_verified_shard_pin(tmp_path, monkeypatch):
    manifest = tmp_path / "manifest.json"
    review = tmp_path / "review.json"
    train = tmp_path / "train.jsonl"
    train.write_bytes(b"handwritten corpus fixture")
    digest = sha256(train.read_bytes()).hexdigest()
    manifest.write_text(json.dumps({"shards": [{"path": "train.jsonl", "sha256": digest}]}), encoding="utf-8")
    review.write_bytes(b"fixture review")

    def verifier(command, *, cwd, check, capture_output, encoding):
        assert command[1:] == [
            "-X", "utf8", "-m", "corpus_pipeline", "verify", "--manifest", str(manifest), "--review", str(review),
        ]
        assert cwd == tmp_path / "packages" / "corpus-pipeline"
        assert (check, capture_output, encoding) == (True, True, "utf-8")
        return subprocess.CompletedProcess(command, 0, stdout=f"{train}\n")

    monkeypatch.setattr(subprocess, "run", verifier)
    evidence = verify_corpus_lineage(tmp_path, manifest, review)
    assert evidence["train_shard"] == {"path": str(train), "sha256": digest}
    train.write_bytes(b"different corpus")
    with pytest.raises(ValueError, match="train shard changed"):
        verify_corpus_lineage(tmp_path, manifest, review)
