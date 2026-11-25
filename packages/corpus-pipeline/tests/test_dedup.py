from hashlib import sha256

import pytest

from corpus_pipeline.dedup import Deduplicator, Duplicate, dialogue_text
from corpus_pipeline.inputs import json_bytes
from corpus_pipeline.normalization import match_key


def test_exact_duplicate_uses_match_key_across_sources():
    index = Deduplicator()
    reference = {"id": "a", "source": "first"}
    assert index.check_and_add(match_key("إِنَّ سَلْمَى قَرَأَتْ ١٢ قِصَّةً"), reference) is None
    assert index.check_and_add(match_key("ان سلمي قرات 12 قصه"), {"id": "b", "source": "second"}) == (
        Duplicate("exact_duplicate", reference, 1.0)
    )


@pytest.mark.parametrize("prefix", ["word", "كلمة"])
def test_near_duplicate_threshold_is_confirmed_with_jaccard(prefix):
    base = " ".join(f"{prefix}{i}" for i in range(40))
    variant = base + " " + " ".join(f"{prefix}{i}" for i in range(40, 44))
    reference = {"id": "a", "source": "first"}
    for threshold in (0.9, 0.91):
        index = Deduplicator(threshold)
        assert index.check_and_add(match_key(base), reference) is None
        hit = index.check_and_add(match_key(variant), {"id": "b", "source": "second"})
        assert hit == (Duplicate("near_duplicate", reference, 36 / 40) if threshold == 0.9 else None)


def test_short_keys_only_match_exactly():
    index = Deduplicator()
    first = {"id": "first", "source": "source"}
    second = {"id": "second", "source": "source"}
    assert index.check_and_add("a b c d", first) is None
    assert index.check_and_add("a b c e", second) is None
    assert index.check_and_add("a b c e", first) == Duplicate("exact_duplicate", second, 1.0)


def _write_manifest(tmp_path, records, *, shard_name="output.jsonl", split="train", version=1):
    path = tmp_path / "manifest.json"
    shard = tmp_path / "output.jsonl"
    data = b"".join(json_bytes(record) for record in records)
    shard.write_bytes(data)
    shards = [{
        "path": shard_name, "sha256": sha256(data).hexdigest(), "split": split,
        "records": len(records), "bytes": len(data),
    }]
    path.write_bytes(json_bytes({
        "schema_version": version, "parameters": {"assistant_end_marker": "[STOP]"}, "shards": shards,
    }))
    return path, shard, shards


def test_prior_manifest_checks_exact_and_near_duplicates(tmp_path):
    base = " ".join(f"word{i}" for i in range(40))
    turns = [
        {"role": "user", "content": "أين تقع المدينة؟ [STOP]"},
        {"role": "assistant", "content": "بجانب النهر. [STOP]"},
    ]
    reference = {"id": "old-dialogue", "source": "first", "split": "train"}
    path, _, shards = _write_manifest(tmp_path, [
        {**reference, "language": "ar", "turns": turns},
        {"id": "old-text", "source": "first", "split": "train", "language": "en", "text": base},
    ])
    index = Deduplicator()
    evidence = index.add_manifest(path)
    assert evidence == {"path": path.as_posix(), "sha256": sha256(path.read_bytes()).hexdigest(), "shards": shards}
    assert dialogue_text(turns, "[STOP]") == "أين تقع المدينة؟ [STOP]\nبجانب النهر. "
    assert index.check_and_add(match_key("اين تقع المدينه؟ [STOP] بجانب النهر."), {"id": "next"}) == Duplicate(
        "exact_duplicate", {**reference, "manifest": path.as_posix()}, 1.0,
    )
    hit = index.check_and_add(f"{base} new ending", {"id": "next"})
    assert hit == Duplicate("near_duplicate", {
        "id": "old-text", "source": "first", "split": "train", "manifest": path.as_posix(),
    }, 36 / 38)


def test_prior_manifest_rejects_changed_shard(tmp_path):
    record = {"id": "old", "source": "first", "split": "train", "language": "en", "text": "old"}
    path, shard, _ = _write_manifest(tmp_path, [record])
    shard.write_bytes(json_bytes({**record, "text": "new"}))
    with pytest.raises(ValueError, match="fingerprint or counts"):
        Deduplicator().add_manifest(path)


@pytest.mark.parametrize("options, error", [
    ({"shard_name": "../output.jsonl"}, "within the manifest directory"),
    ({"shard_name": "C:/output.jsonl"}, "within the manifest directory"),
    ({"split": "sealed"}, "Invalid prior shard split"),
    ({"version": 2}, "Unsupported prior corpus manifest"),
])
def test_prior_manifest_rejects_unsupported_metadata(tmp_path, options, error):
    path, _, _ = _write_manifest(tmp_path, [], **options)
    with pytest.raises(ValueError, match=error):
        Deduplicator().add_manifest(path)
