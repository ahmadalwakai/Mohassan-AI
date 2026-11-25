"""Measure EOS, repeated phrases and length stops in frozen probe predictions."""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import unicodedata

# Owner's training plan, section 8.8, supplied in the task on 2026-11-25.
EOS_TOKEN_ID = 258
MAX_NEW_TOKENS = 192
PHRASE_WORDS = 4
LOOP_REPETITIONS = 3
SAMPLE_SEEDS = (1, 2, 3)


def measure_loop(text: str) -> dict:
    words = unicodedata.normalize("NFKC", text).lower().split()
    counts = Counter(tuple(words[index:index + PHRASE_WORDS])
                     for index in range(len(words) - PHRASE_WORDS + 1))
    # Counter breaks ties by first occurrence, including overlapping windows.
    phrase, highest_count = counts.most_common(1)[0] if counts else ((), 0)
    return {
        "looped": highest_count >= LOOP_REPETITIONS,
        "highest_count": highest_count,
        "repeated_phrase": " ".join(phrase) if highest_count > 1 else None,
    }


def counts_as_eos(record: dict) -> bool:
    return (record["stop_reason"] == "eos"
            and record.get("terminal_token_id") == EOS_TOKEN_ID
            and 1 <= record["output_tokens"] <= MAX_NEW_TOKENS)


def _unique_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    row = {}
    for key, value in pairs:
        if key in row:
            raise ValueError(f"duplicate JSON key {key!r}")
        row[key] = value
    return row


def load_predictions(path: Path) -> tuple[dict[str | tuple[str, int], dict], str]:
    """Load one greedy file or a complete set of draws per sampled probe."""
    data = path.read_bytes()
    records: dict[str | tuple[str, int], dict] = {}
    seeds_by_probe: dict[str, set[int]] = {}
    sampled = None
    for number, line in enumerate(data.decode("utf-8").split("\n"), 1):
        if not line.strip():
            continue
        location = f"{path}:{number}"
        try:
            row = json.loads(line, object_pairs_hook=_unique_keys)
        except ValueError as error:
            raise ValueError(f"{location}: {error}") from error
        if not isinstance(row, dict):
            raise ValueError(f"{location}: prediction must be an object")
        probe_id = row.get("id")
        if not isinstance(probe_id, str) or not probe_id.strip():
            raise ValueError(f"{location}: prediction requires an ID")
        if (row.get("language") not in ("ar", "en") or not isinstance(row.get("text"), str)
                or not isinstance(row.get("stop_reason"), str) or not row["stop_reason"].strip()
                or type(row.get("output_tokens")) is not int or row["output_tokens"] < 0
                or (row.get("terminal_token_id") is not None
                    and (type(row["terminal_token_id"]) is not int or row["terminal_token_id"] < 0))):
            raise ValueError(f"{location}: invalid prediction fields for {probe_id!r}")
        has_seed = "seed" in row
        if sampled is None:
            sampled = has_seed
        elif sampled != has_seed:
            raise ValueError(f"{location}: mixed predictions with and without a seed")
        if has_seed:
            seed = row["seed"]
            if type(seed) is not int or seed not in SAMPLE_SEEDS:
                raise ValueError(f"{location}: invalid seed {seed!r} for {probe_id!r}")
            key = (probe_id, seed)
            if key in records:
                raise ValueError(f"{location}: duplicate prediction (id, seed) {key!r}")
            seeds_by_probe.setdefault(probe_id, set()).add(seed)
            records[key] = row
        else:
            if probe_id in records:
                raise ValueError(f"{location}: duplicate prediction ID {probe_id!r}")
            records[probe_id] = row
    if not records:
        raise ValueError(f"{path}: no predictions")
    for probe_id, seeds in seeds_by_probe.items():
        missing = sorted(set(SAMPLE_SEEDS) - seeds)
        if missing:
            raise ValueError(f"{path}: missing seeds {missing} for prediction ID {probe_id!r}")
    return records, hashlib.sha256(data).hexdigest()


def _language_counts() -> dict[str, dict[str, int]]:
    return {language: dict(total=0, eos=0, loops=0, length_stops=0) for language in ("ar", "en")}


def score(predictions: Path, output: Path) -> dict:
    records, digest = load_predictions(predictions)
    by_language = _language_counts()
    by_seed = {str(seed): _language_counts() for seed in SAMPLE_SEEDS} if isinstance(next(iter(records)), tuple) else {}
    by_id = {}
    for key, row in records.items():
        metrics = measure_loop(row["text"])
        language = row["language"]
        totals = [by_language[language]]
        if isinstance(key, tuple):
            probe_id, seed = key
            probe_id = f"{probe_id}#seed{seed}"
            totals.append(by_seed[str(seed)][language])
        else:
            probe_id = key
        by_id[probe_id] = metrics
        eos = counts_as_eos(row)
        for counts in totals:
            counts["total"] += 1
            counts["eos"] += eos
            counts["loops"] += metrics["looped"]
            counts["length_stops"] += row["stop_reason"] == "length"
    summary = {
        "predictions_sha256": digest,
        "tool_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "by_language": by_language,
        "by_id": by_id,
    }
    if by_seed:
        summary["by_seed"] = by_seed
    with output.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    commands = parser.add_subparsers(dest="command", required=True)
    scoring = commands.add_parser("score", allow_abbrev=False)
    scoring.add_argument("--predictions", type=Path, required=True)
    scoring.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        score(args.predictions, args.output)
    except (OSError, ValueError) as error:
        parser.exit(1, f"{parser.prog}: {error}\n")


if __name__ == "__main__":
    main()
