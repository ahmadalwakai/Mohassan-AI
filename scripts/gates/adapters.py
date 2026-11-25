"""Translate gate observations into blind evidence and per-case pass eligibility."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import stat
from pathlib import Path

from .common import GateError, nonempty, parse_json


# Match the R3 rule in scripts/router/train.py. A registration can add routes
# through frozen case annotations, but cannot waive these routes.
NEVER_WEB = frozenset({"memory", "reminder", "pc", "ads"})
OUTPUT_FORMATS = ("text", "json", "csv")
TASK_STATUSES = ("completed", "refused", "partial", "blocked")
STOP_REASONS = ("eos", "length", "stop_token", "error")
MAX_PARSED_BYTES = 16 * 1024 * 1024
PREVIEW_CHARS = 4000
READ_SIZE = 64 * 1024


def _generation_prompt(case):
    # The chat holdout builder emits both messages and a fully rendered prompt.
    # Prefer the messages so system framing is never copied into the packet.
    if "messages" not in case:
        if not nonempty(case.get("prompt")):
            raise GateError(f"Generation case {case['id']} needs a nonempty prompt or messages.")
        return {"prompt": case["prompt"]}

    messages = case["messages"]
    if not isinstance(messages, list):
        raise GateError(f"Generation case {case['id']} needs a messages array.")
    visible = []
    for message in messages:
        if (not isinstance(message, dict) or message.get("role") not in ("user", "assistant", "system")
                or not nonempty(message.get("content"))):
            raise GateError(f"Generation case {case['id']} contains an invalid message.")
        if message["role"] != "system":
            visible.append({"role": message["role"], "content": message["content"]})
    if not any(message["role"] == "user" for message in visible):
        raise GateError(f"Generation case {case['id']} needs a user message.")
    return {"messages": visible}


def validate_cases(adapter, cases, rule):
    """Validate the adapter-specific fields before any predictions are consumed."""
    for case in cases:
        label = f"{adapter} case {case['id']}"
        if adapter == "generation":
            _generation_prompt(case)
        elif adapter == "agent":
            if not nonempty(case.get("request")) or case.get("expected_outcome") not in ("completed", "refused"):
                raise GateError(f"{label} needs a request and expected_outcome completed or refused.")
            if case["expected_outcome"] == "completed":
                expected_state = case.get("expected_final_state")
                if (not isinstance(expected_state, dict) or not expected_state
                        or case.get("output_format") not in OUTPUT_FORMATS):
                    raise GateError(f"{label} needs a nonempty expected_final_state object and an output_format.")
            elif "expected_final_state" in case or "output_format" in case:
                raise GateError(f"{label} lists completion requirements for a refusal.")
        elif adapter == "classifier":
            if not nonempty(case.get("label")):
                raise GateError(f"{label} needs a nonempty ground-truth label.")
            if "never_web" in case:
                if not rule.get("classifier", {}).get("router", False) or type(case["never_web"]) is not bool:
                    raise GateError(f"{label} may only set a boolean never_web for a router gate.")
        else:
            raise GateError(f"Unknown adapter: {adapter}")


def _prediction_index(cases, predictions):
    index = {}
    for row in predictions:
        if not isinstance(row, dict) or not nonempty(row.get("id")):
            raise GateError("Each prediction needs a nonempty case ID.")
        if row["id"] in index:
            raise GateError(f"Duplicate prediction for case {row['id']}.")
        index[row["id"]] = row
    if index.keys() != {case["id"] for case in cases}:
        raise GateError("Predictions must cover each frozen case exactly once.")
    return index


def _text(row):
    if not isinstance(row.get("text"), str):
        raise GateError(f"Prediction for case {row['id']} needs a text string.")
    return row["text"]


def _generation(case, row, settings, artifact_digest):
    text = _text(row)
    if type(row.get("finished")) is not bool:
        raise GateError(f"Generation prediction {row['id']} needs a boolean finished.")
    error = row.get("error")
    if error is not None and not isinstance(error, str):
        raise GateError(f"Generation prediction {row['id']} has an invalid error field.")
    checkpoint = row.get("checkpoint_sha256")
    if checkpoint is not None and checkpoint != artifact_digest:
        raise GateError(f"Generation prediction {row['id']} belongs to a different checkpoint.")
    stop = row.get("stop_reason")
    if "stop_reason" in row and (stop not in STOP_REASONS or row["finished"] != (stop == "eos")):
        raise GateError(f"Generation prediction {row['id']} has an invalid or inconsistent stop reason.")
    tokens = row.get("output_tokens")
    maximum = settings["max_tokens"]
    if "output_tokens" in row and (type(tokens) is not int or not 0 <= tokens <= maximum):
        raise GateError(f"Generation prediction {row['id']} exceeds or misstates the registered token budget.")
    replacement = row.get("utf8_decode_replacement", False)
    if type(replacement) is not bool:
        raise GateError(f"Generation prediction {row['id']} has an invalid UTF-8 replacement flag.")

    stopped_as_registered = row["finished"] or (
        settings["eos_rule"] == "allow_token_limit" and stop == "length" and tokens == maximum
    )
    eligible = bool(stopped_as_registered and text.strip() and "\ufffd" not in text and not replacement and not error)
    return {**_generation_prompt(case), "text": text, "finished": row["finished"]}, eligible


def _read_evidence(base_dir, reference):
    """Read a local regular file and hash the same bytes used for verification."""
    if not reference:
        return None, None
    relative = Path(reference)
    if relative.is_absolute() or ".." in relative.parts:
        return None, None
    path = base_dir / relative
    try:
        if path.resolve(strict=True) != path:
            return None, None
        flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0)
        flags |= getattr(os, "O_BINARY", 0)
        with os.fdopen(os.open(path, flags), "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                return None, None
            checksum = hashlib.sha256()
            data = bytearray()
            size = 0
            for chunk in iter(lambda: stream.read(READ_SIZE), b""):
                size += len(chunk)
                checksum.update(chunk)
                if size <= MAX_PARSED_BYTES:
                    data.extend(chunk)
    except (OSError, RuntimeError, ValueError):
        return None, None

    pin = {"path": str(path), "sha256": checksum.hexdigest()}
    if not size or size > MAX_PARSED_BYTES:
        return None, pin
    return bytes(data), pin


def _same_state(data, expected, path):
    if data is None:
        return False
    try:
        state = parse_json(data.decode("utf-8-sig"), path)
    except (GateError, UnicodeError):
        return False
    # Serializing distinguishes JSON booleans from numbers, which Python's
    # equality otherwise treats as equal.
    return json.dumps(state, sort_keys=True) == json.dumps(expected, sort_keys=True)


def _open_output(data, output_format, path):
    if data is None:
        return False, None
    try:
        preview = data.decode("utf-8-sig")
        if not preview.strip() or "\x00" in preview:
            return False, None
        if output_format == "json":
            parse_json(preview, path)
        elif output_format == "csv":
            rows = csv.reader(io.StringIO(preview, newline=""), strict=True)
            if not sum(any(cell.strip() for cell in row) for row in rows):
                return False, None
    except (GateError, UnicodeError, csv.Error):
        return False, None
    return True, preview[:PREVIEW_CHARS]


def _agent(case, row, base_dir):
    text = _text(row)
    status = row.get("status")
    if status not in TASK_STATUSES:
        raise GateError(f"Agent prediction {row['id']} has an invalid status.")
    state_path, output_path = row.get("final_state_path"), row.get("output_file")
    for reference in (state_path, output_path):
        if reference is not None and not nonempty(reference):
            raise GateError(f"Agent prediction {row['id']} has an invalid evidence path.")
    item = {"request": case["request"], "text": text, "status": status}
    if status == "refused":
        eligible = case["expected_outcome"] == "refused" and not output_path and bool(text.strip())
        return item, eligible, [], "refused" if eligible else "invalid_refusal"
    if status != "completed":
        return item, False, [], status
    if case["expected_outcome"] != "completed":
        return item, False, [], "unexpected_completion"

    output_format = case["output_format"]
    state, state_pin = _read_evidence(base_dir, state_path)
    output, output_pin = _read_evidence(base_dir, output_path)
    matches = _same_state(state, case["expected_final_state"], state_path)
    openable, preview = _open_output(output, output_format, output_path)
    item.update(final_state_matches=matches, output_openable=openable)
    if preview is not None:
        item["output_preview"] = preview
    pins = [pin for pin in (state_pin, output_pin) if pin is not None]
    if not matches:
        return item, False, pins, "missing_or_wrong_final_state"
    if not openable:
        return item, False, pins, "missing_or_unopenable_output"
    return item, True, pins, "completed"


def _classifier(case, row, rule, baseline):
    label, confidence = row.get("label"), row.get("confidence")
    if not nonempty(label):
        raise GateError(f"Classifier prediction {row['id']} needs a label.")
    if not (baseline and "confidence" not in row):
        if type(confidence) not in (int, float) or not 0 <= confidence <= 1:
            raise GateError(f"Classifier prediction {row['id']} needs confidence in [0, 1].")
        confidence = float(confidence)
    router = rule.get("classifier", {}).get("router", False)
    never_web = case["label"] in NEVER_WEB or case.get("never_web") is True
    return label == case["label"], {"confidence": confidence,
                                    "never_web_violation": router and never_web and label == "web_search"}


def prepare(adapter, cases, predictions, base_dir, rule, artifact_digest, settings, *, baseline=False):
    """Prepare allowlisted judge content and mechanical checks for one result set."""
    index = _prediction_index(cases, predictions)
    items, eligible, evidence = {}, {}, {}
    observations = {} if adapter == "classifier" else None
    outcomes = {} if adapter == "agent" else None
    if adapter == "agent":
        base_dir = base_dir.resolve()
    for case in cases:
        case_id = case["id"]
        row = index[case_id]
        if adapter == "generation":
            items[case_id], eligible[case_id] = _generation(case, row, settings, artifact_digest)
        elif adapter == "agent":
            items[case_id], eligible[case_id], pins, outcomes[case_id] = _agent(case, row, base_dir)
            for pin in pins:
                prior = evidence.setdefault(pin["path"], pin)
                if prior != pin:
                    raise GateError(f"Evidence changed while reading case {case_id}.")
        elif adapter == "classifier":
            eligible[case_id], observations[case_id] = _classifier(case, row, rule, baseline)
        else:
            raise GateError(f"Unknown adapter: {adapter}")
    return {"items": items, "eligible": eligible, "observations": observations,
            "evidence": list(evidence.values()), "outcomes": outcomes}
