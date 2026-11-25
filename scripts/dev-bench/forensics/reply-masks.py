"""Extract exact case/turn literals for two known runtime fields in benchmark replies."""

import argparse
from collections import Counter
import json
import os
from pathlib import Path
import re


PATTERNS = {
    "fixtureTime": re.compile(
        r"(?:(?<= · read )|(?<= · قُرئت ))[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} UTC"
    ),
    "documentUuid": re.compile(
        r"(?<=https://benchmark\.invalid/api/documents/)"
        r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=/content)"
    ),
}


def span(pattern, reply):
    matches = list(pattern.finditer(reply))
    if len(matches) != 1:
        return None
    match = matches[0]
    return match[0], (reply[:match.start()], reply[match.end():])


def difference(expected, actual):
    for kind, pattern in PATTERNS.items():
        before, after = span(pattern, expected), span(pattern, actual)
        if before and after and before[1] == after[1] and before[0] != after[0]:
            return kind, before, after
    return None


def write_json(path, content):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as file:
        json.dump(content, file, indent=2)
        file.write("\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--flags-off", type=Path, required=True)
    parser.add_argument("--baseline-repeat", type=Path)
    parser.add_argument("--masks-output", type=Path)
    parser.add_argument("--residual-output", type=Path, required=True)
    args = parser.parse_args()
    if bool(args.baseline_repeat) != bool(args.masks_output):
        parser.error("--baseline-repeat and --masks-output must be specified together")
    baseline, flags_off = (json.loads(path.read_bytes()) for path in (args.baseline, args.flags_off))
    repeated = json.loads(args.baseline_repeat.read_bytes()) if args.baseline_repeat else None

    residual = {version: [] for version in ("v1", "v2")}
    masks = []
    for version in residual:
        originals = baseline["versions"][version]["scores"]
        off_cases = flags_off["versions"][version]["scores"]
        repeat_cases = repeated["versions"][version]["scores"] if repeated else originals
        counts = Counter()
        unproven = []
        for a, b, d in zip(originals, off_cases, repeat_cases, strict=True):
            if not a["id"] == b["id"] == d["id"]:
                raise ValueError(f"{version} receipt case order differs")
            if a["passed"] != b["passed"]:
                counts["verdictDifferences"] += 1
            wording = len(a["replies"]) != len(b["replies"])
            for turn, (original, off) in enumerate(zip(a["replies"], b["replies"]), 1):
                if original == off:
                    continue
                candidate = difference(original, off)
                if not candidate:
                    wording = True
                    continue
                kind, before, after = candidate
                counts[kind] += 1
                if not repeated:
                    continue
                proof = span(PATTERNS[kind], d["replies"][turn - 1]) if len(d["replies"]) >= turn else None
                if not proof or proof[1] != before[1] or proof[0] == before[0] or a["passed"] != d["passed"]:
                    unproven.append((a["id"], turn, kind))
                    continue
                masks.append({
                    "version": version, "caseId": a["id"], "turn": turn,
                    "values": {"baseline": before[0], "baselineRepeat": proof[0], "flagsOff": after[0]},
                })
            if wording:
                residual[version].append(a["id"])
        print(json.dumps({
            "version": version, "cases": len(originals), "counts": dict(counts),
            "residualWordingCases": len(residual[version]), "unprovenLiteralSpans": unproven,
        }))
    write_json(args.residual_output, residual)
    if args.masks_output:
        write_json(args.masks_output, masks)


if __name__ == "__main__":
    main()
