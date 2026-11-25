import argparse
from collections import Counter
from hashlib import file_digest
import json
from pathlib import Path


def read_json(path):
    return json.loads(path.read_bytes())


def sha256(path):
    with path.open("rb") as stream:
        return file_digest(stream, "sha256").hexdigest()


def case_signature(case):
    return {
        "passed": case["passed"],
        "failures": [
            {"turn": failure["turn"], "stage": failure["stage"], "check": failure["check"]}
            for failure in case["failures"]
        ],
        "turns": [
            {key: turn.get(key) for key in (
                "source", "operation", "route", "routeReason", "handler", "status",
                "boundaryTools", "fixtureMisses", "verification",
            )}
            for turn in case["turns"]
        ],
    }


def compare(before, after):
    assert [case["id"] for case in before] == [case["id"] for case in after]
    result = []
    for old, new in zip(before, after, strict=True):
        assert (old["area"], old["language"]) == (new["area"], new["language"])
        if old["passed"] != new["passed"]:
            result.append({
                "id": old["id"],
                "area": old["area"],
                "language": old["language"],
                "legacy": case_signature(old),
                "canonical": case_signature(new),
            })
    return result


def legacy_scores(directory, version, count):
    aggregate_path = directory / f"off-{version}.json"
    aggregate = read_json(aggregate_path)
    assert aggregate["sourceClean"] and aggregate["sourceCommit"] == "7f9c417f2e06b77c26eb6ff677d06e3457da650b"
    lane_paths = [directory / f"off-{version}-{lane}.json" for lane in range(4)]
    scores = {}
    for lane, path in enumerate(lane_paths):
        receipt = read_json(path)
        assert receipt["payloadSha256"] == aggregate["payloadSha256"]
        assert [row["index"] for row in receipt["rows"]] == list(range(lane, count, 4))
        scores.update((row["index"], row["score"]) for row in receipt["rows"])
    assert sorted(scores) == list(range(count))
    ordered = [scores[index] for index in range(count)]
    assert aggregate["caseIds"] == [case["id"] for case in ordered]
    assert len({case["id"] for case in ordered}) == count
    assert sum(case["passed"] for case in ordered) == aggregate["summary"]["overall"]["passed"]
    return ordered, {path.name: sha256(path) for path in [aggregate_path, *lane_paths]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("historical", type=Path)
    parser.add_argument("canonical", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("v2_ids", type=Path)
    args = parser.parse_args()
    canonical = read_json(args.canonical)
    assert canonical["commit"] == "7f9c417f2e06b77c26eb6ff677d06e3457da650b"
    result = {
        "canonicalReceiptSha256": sha256(args.canonical),
        "versions": {},
    }
    for version, count in {"v1": 240, "v2": 2400}.items():
        legacy, input_hashes = legacy_scores(args.historical, version, count)
        current = canonical["versions"][version]["scores"]
        differences = compare(legacy, current)
        groups = Counter(
            (row["area"], row["language"], row["canonical"]["passed"])
            for row in differences
        )
        for (area, language, passed), cases in sorted(groups.items()):
            print(version, area, language, "gain" if passed else "loss", cases)
        result["versions"][version] = {"legacyReceiptSha256": input_hashes, "differences": differences}
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, indent=2, ensure_ascii=False)
        stream.write("\n")
    ids = [row["id"] for row in result["versions"]["v2"]["differences"]]
    with args.v2_ids.open("x", encoding="utf-8") as stream:
        json.dump(ids, stream)
        stream.write("\n")


if __name__ == "__main__":
    main()
