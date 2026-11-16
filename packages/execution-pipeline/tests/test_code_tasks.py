"""Dataset/oracle checks. Generated TypeScript execution uses the sandbox CLI."""
import json
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline import code_tasks as tasks  # noqa: E402


def test_disjoint_splits_and_bilingual_family_coverage():
    names = []
    for split in tasks.SPLIT_OFFSET:
        rows = tasks.generate_records(split, 64)
        assert len({row["id"] for row in rows}) == 64
        assert {row["language"] for row in rows} == {"ar", "en"}
        assert {row["family"] for row in rows} == set(tasks.FAMILIES)
        assert {row["input"]["mode"] for row in rows} == {"implement", "repair"}
        names.append({row["input"]["functionName"] for row in rows})
        for row in rows:
            assert row["prompt"] == tasks.render_prompt(row["input"])
            assert row["target"] == row["output"]
            assert row["target"].startswith("export function ")
            assert len(row["prompt"].encode("utf-8")) < 1400
            if row["input"]["mode"] == "repair":
                witness = row["input"]["failure_evidence"]
                assert witness["observed"] != witness["expected"]
    for i, left in enumerate(names):
        for right in names[i + 1:]:
            assert not left & right


@pytest.mark.parametrize("family,args,parameters,result", [
    ("add", [2, -3], {}, -1), ("multiply", [-2, -3], {}, 6),
    ("clamp", [11], {"minimum": -3, "maximum": 10}, 10),
    ("clamp", [-9], {"minimum": -3, "maximum": 10}, -3),
    ("normalize", ["  AbC مرحبا\t"], {}, "abc مرحبا"),
    ("array_sum", [[]], {}, 0), ("array_sum", [[-2, 5, 1]], {}, 4),
    ("count_above", [[3, 4, 5]], {"threshold": 4}, 1),
    ("fallback", [0], {"default": 7}, 0), ("fallback", [], {"default": 7}, 7),
    ("offset", [None], {"amount": 4}, 0), ("offset", [-2], {"amount": 4}, 2),
])
def test_independent_oracle_boundaries(family, args, parameters, result):
    assert tasks.expected(family, args, parameters) == result


def test_job_preserves_model_answer_and_independent_probes():
    rows = tasks.generate_records("code_test", 8)
    answers = {row["id"]: "malformed candidate" for row in rows}
    job = tasks.candidate_job(rows, answers=answers)
    assert all(candidate["content"] == "malformed candidate" for candidate in job["candidates"])
    assert all(candidate["probes"] for candidate in job["candidates"])
    assert all(candidate["signature"] == row["input"]["signature"] for candidate, row in zip(job["candidates"], rows))


def test_dataset_manifest_and_reproducibility(tmp_path):
    report = tasks.write_dataset(tmp_path, train=64, validation=32, test=32, unseen=32)
    assert report["files"]["train"]["ar"] == report["files"]["train"]["en"] == 32
    first = (tmp_path / "train.jsonl").read_text(encoding="utf-8")
    tasks.write_dataset(tmp_path, train=64, validation=32, test=32, unseen=32)
    assert first == (tmp_path / "train.jsonl").read_text(encoding="utf-8")
    assert len([json.loads(line) for line in first.splitlines()]) == 64


def test_rejects_invalid_family_name_and_nonfailing_repair():
    with pytest.raises(ValueError):
        tasks.make_record("add", "evil();", {})
    with pytest.raises(ValueError):
        tasks.make_record("unknown", "compute", {})
    with pytest.raises(ValueError):
        tasks.make_record("offset", "compute", {"amount": 0}, mode="repair")


def test_diverse_identifiers_are_disjoint_reproducible_and_cover_matching_styles():
    train = tasks.generate_records("train", 600, identifier_style="diverse-v2")
    validation = tasks.generate_records("validation", 240, identifier_style="diverse-v2")
    train_names = {row["input"]["functionName"] for row in train}
    val_names = {row["input"]["functionName"] for row in validation}
    assert len(train_names) == 600 and len(val_names) == 240
    assert not train_names & val_names
    for split, rows in (("train", train), ("validation", validation)):
        assert {row["identifier_category"] for row in rows} == {"camel_case", "underscore", "alphanumeric", "short"}
        assert all(tasks.identifier_partition(row["input"]["functionName"]) == split for row in rows)
        suffix_lengths = set()
        length_bands = set()
        for row in rows:
            name = row["input"]["functionName"]
            assert tasks.IDENTIFIER.fullmatch(name)
            match = re.search(r"(\d+)$", name)
            suffix_lengths.add(len(match[1]) if match else 0)
            length_bands.add("short" if len(name) < 10 else "medium" if len(name) < 20 else "long")
        assert suffix_lengths == {0, 1, 2, 3, 4, 5}
        assert length_bands == {"short", "medium", "long"}
        for family in tasks.FAMILIES:
            assert {row["identifier_category"] for row in rows if row["family"] == family} == {"camel_case", "underscore", "alphanumeric", "short"}
    assert train == tasks.generate_records("train", 600, identifier_style="diverse-v2")
    for family in tasks.FAMILIES:
        variants = {tuple(row["parameter_names"].values()) for row in train if row["family"] == family}
        assert len(variants) == 4
    assert any(row["input"]["message"].startswith("I need a TypeScript function")
               and row["family"] == "add" and row["parameter_names"]["a"] != "a" for row in train)
    for rows in (train, validation):
        for index, row in enumerate(rows):
            given = row["input"]
            assert row["target"].startswith("export function " + given["signature"])
            assert row["prompt"] == tasks.render_prompt(given)
            assert row["output"] == row["target"]
            assert given["probes"] == tasks.probes(given["family"], given["parameters"], seed=1729 + index)
            if given["mode"] == "repair":
                assert given["failed_candidate"].startswith("export function " + given["signature"])


def test_diverse_opt_in_keeps_original_defaults_and_can_write_only_development_train_validation(tmp_path):
    assert tasks.generate_records("train", 32) == tasks.generate_records("train", 32, identifier_style="sequential-v1")
    manifest = tasks.write_dataset(tmp_path, train=64, validation=32, test=0, unseen=0, identifier_style="diverse-v2")
    assert set(manifest["files"]) == {"train", "validation"}
    assert manifest["evaluation_scope"].startswith("development_only")
    assert not (tmp_path / "code_test.jsonl").exists()
    assert not (tmp_path / "code_unseen.jsonl").exists()
    assert all(row["evaluation_scope"] == "development_only"
               for row in tasks.generate_records("code_test", 16, identifier_style="diverse-v2"))
