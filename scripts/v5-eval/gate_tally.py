"""Tally reader verdicts and objective measurements for frozen v5 evaluations."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
from typing import Any

if __name__ == "__main__":
    sys.dont_write_bytecode = True

from loop_measure import counts_as_eos, load_predictions, measure_loop  # noqa: E402
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages/execution-pipeline"))
from execution_pipeline.chat_probes import EXPECTED_IDS as CHAT_IDS  # noqa: E402


LANGUAGES = ("ar", "en")
CHAT_LANGUAGES = {probe_id: probe_id.split("-")[1] for probe_id in CHAT_IDS}
# Gate 3's _validate_rows generates these IDs (retrieved 2026-11-25).
# https://github.com/ahmadalwakai/Mohassan-AI/blob/c2a0ff765071657cf200b5ee7d12fabaad738c0b/packages/execution-pipeline/execution_pipeline/gate3_probes.py#L73
GATE3_TOTAL_PER_LANGUAGE = 20
GATE3_LANGUAGES = {
    f"gate3-{language}-{number:02d}": language
    for language in LANGUAGES for number in range(1, GATE3_TOTAL_PER_LANGUAGE + 1)
}
# Training plan sections 8.4 (retrieved 2026-11-25) and 8.8 (owner's 2026-11-25 pre-registration).
# https://github.com/ahmadalwakai/Mohassan-AI/blob/c2a0ff765071657cf200b5ee7d12fabaad738c0b/docs/CHAT-MODEL-TRAINING-PLAN.md#84-stages-and-gates
GATE3_STRICT_MINIMUM = 16
# Owner's delegate recorded the v5-3 condition on 2026-11-25 at 21:24 UTC.
V5_3_OPTION_B_MINIMUM = 16


def _unique_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key: {key!r}.")
        result[key] = value
    return result


def _require_ids(actual: set[str], expected: set[str], source: str) -> None:
    missing, extra = sorted(expected - actual), sorted(actual - expected)
    if missing or extra:
        raise ValueError(f"{source} has missing IDs {missing} and extra IDs {extra}.")


def _nonempty_text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _load_preregistration(path: Path) -> tuple[dict[str, list[str]], dict[str, str], str]:
    raw = path.read_bytes()
    record = json.loads(raw, object_pairs_hook=_unique_keys)
    if not isinstance(record, dict):
        raise ValueError("Pre-registration must be a JSON object.")
    core, known_hard = record.get("core_chat_probes"), record.get("known_hard")
    if not isinstance(core, dict) or set(core) != set(LANGUAGES):
        raise ValueError("core_chat_probes must have an ar list and an en list.")
    if not isinstance(known_hard, dict) or not all(_nonempty_text(reason) for reason in known_hard.values()):
        raise ValueError("known_hard must map probe IDs to nonempty reasons.")
    assigned = set(known_hard)
    for language, probe_ids in core.items():
        if not isinstance(probe_ids, list) or not all(_nonempty_text(probe_id) for probe_id in probe_ids):
            raise ValueError(f"core_chat_probes.{language} must be a list of probe IDs.")
        for probe_id in probe_ids:
            if probe_id in assigned:
                raise ValueError(f"Duplicate pre-registration ID: {probe_id!r}.")
            if CHAT_LANGUAGES.get(probe_id) != language:
                raise ValueError(f"Unexpected ID in core_chat_probes.{language}: {probe_id!r}.")
            assigned.add(probe_id)
    _require_ids(assigned, set(CHAT_LANGUAGES), "Pre-registration")
    return core, known_hard, hashlib.sha256(raw).hexdigest()


def _load_verdicts(path: Path) -> tuple[dict[str, dict[str, Any]], str]:
    raw = path.read_bytes()
    verdicts = {}
    for number, line in enumerate(raw.splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line, object_pairs_hook=_unique_keys)
        except ValueError as error:
            raise ValueError(f"Invalid verdict JSON at {path}:{number}: {error}") from error
        reason = row.get("reason") if isinstance(row, dict) else None
        if (not _nonempty_text(reason) or reason.splitlines() != [reason] or not _nonempty_text(row.get("id"))
                or row.get("verdict") not in ("pass", "fail") or row.get("content") not in ("pass", "fail")
                or row.get("loop") not in ("yes", "no")):
            raise ValueError(f"Invalid reader verdict at {path}:{number}.")
        probe_id = row["id"]
        if probe_id in verdicts:
            raise ValueError(f"Duplicate verdict ID: {probe_id!r}.")
        verdicts[probe_id] = row
    return verdicts, hashlib.sha256(raw).hexdigest()


def _counts(probe_ids: list[str], predictions: dict[str, dict[str, Any]],
            verdicts: dict[str, dict[str, Any]], objective_loops: dict[str, bool]) -> dict[str, int]:
    return {
        "total": len(probe_ids),
        "strict_passes": sum(verdicts[probe_id]["verdict"] == "pass" for probe_id in probe_ids),
        "content_passes": sum(verdicts[probe_id]["content"] == "pass" for probe_id in probe_ids),
        "reader_loops": sum(verdicts[probe_id]["loop"] == "yes" for probe_id in probe_ids),
        "objective_eos": sum(counts_as_eos(predictions[probe_id]) for probe_id in probe_ids),
        "objective_loops": sum(objective_loops[probe_id] for probe_id in probe_ids),
    }


def tally(predictions_path: Path, verdicts_path: Path, preregistration_path: Path) -> dict[str, Any]:
    predictions, predictions_sha256 = load_predictions(predictions_path)
    if any("seed" in row or "decoding" in row for row in predictions.values()):
        raise ValueError("Sampling diagnostic predictions cannot be tallied.")
    suites = {probe_id.split("-", 1)[0] for probe_id in predictions}
    if suites == {"chat"}:
        expected_languages = CHAT_LANGUAGES
        suite = "chat"
    elif suites == {"gate3"}:
        expected_languages = GATE3_LANGUAGES
        suite = "gate3"
    else:
        raise ValueError("Predictions must contain IDs from exactly one frozen suite (chat or Gate 3).")
    _require_ids(set(predictions), set(expected_languages), "Predictions")
    for probe_id, language in expected_languages.items():
        if predictions[probe_id]["language"] != language:
            raise ValueError(f"Prediction language for {probe_id!r} must be {language!r}.")

    verdicts, verdicts_sha256 = _load_verdicts(verdicts_path)
    _require_ids(set(verdicts), set(predictions), "Verdicts")
    core, known_hard, preregistration_sha256 = _load_preregistration(preregistration_path)

    objective_loops = {probe_id: measure_loop(predictions[probe_id]["text"])["looped"]
                       for probe_id in expected_languages}
    languages = {}
    for language in LANGUAGES:
        probe_ids = [probe_id for probe_id, expected in expected_languages.items() if expected == language]
        counts: dict[str, Any] = _counts(probe_ids, predictions, verdicts, objective_loops)
        if suite == "chat":
            counts["core"] = _counts(core[language], predictions, verdicts, objective_loops)
            hard_ids = [probe_id for probe_id in probe_ids if probe_id in known_hard]
            counts["known_hard"] = _counts(hard_ids, predictions, verdicts, objective_loops)
        else:
            counts["option_b_passes"] = sum(
                verdicts[probe_id]["content"] == "pass" and verdicts[probe_id]["loop"] == "no"
                for probe_id in probe_ids
            )
        languages[language] = counts

    result = {
        "probe_suite": suite,
        "predictions_sha256": predictions_sha256,
        "verdicts_sha256": verdicts_sha256,
        "preregistration_sha256": preregistration_sha256,
        "languages": languages,
    }
    if suite == "chat":
        result["known_hard"] = known_hard
    else:
        result["gate3_strict_rule"] = {
            "probes_per_language": GATE3_TOTAL_PER_LANGUAGE,
            "minimum_strict_passes_per_language": GATE3_STRICT_MINIMUM,
            "met_in_both_languages": all(languages[language]["strict_passes"] >= GATE3_STRICT_MINIMUM
                                        for language in LANGUAGES),
        }
        result["v5_3_condition_option_b"] = {
            "probes_per_language": GATE3_TOTAL_PER_LANGUAGE,
            "minimum_per_language": V5_3_OPTION_B_MINIMUM,
            "per_item": "content == pass and loop == no",
            "met_in_both_languages": all(languages[language]["option_b_passes"] >= V5_3_OPTION_B_MINIMUM
                                        for language in LANGUAGES),
        }
        disagreements = []
        for probe_id, objective_loop in objective_loops.items():
            reader_loop = verdicts[probe_id]["loop"]
            if (reader_loop == "yes") != objective_loop:
                disagreements.append({"id": probe_id, "reader_loop": reader_loop, "objective_loop": objective_loop})
        result["reader_objective_loop_disagreements"] = disagreements
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--verdicts", type=Path, required=True)
    parser.add_argument("--preregistration", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="Path to a new tally JSON file")
    args = parser.parse_args()
    if (args.output.stem.casefold() in {"assessment", "gate3_passed"}
            or args.output.name.casefold() in {"protocol.json", "predictions.jsonl", "verdicts.jsonl", "manifest.json",
                                               "started.json", "failure.json"}):
        parser.error("Choose a tally output path outside the reserved gate artifact names.")
    try:
        report = tally(args.predictions, args.verdicts, args.preregistration)
        data = (json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        with args.output.open("xb") as stream:
            stream.write(data)
    except (OSError, ValueError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
