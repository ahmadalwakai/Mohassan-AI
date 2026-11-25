"""Bind offline results to a run and prepare the frozen evidence for judging."""
from __future__ import annotations

import os
from pathlib import Path
from tempfile import TemporaryDirectory

from .adapters import prepare, validate_cases
from .blind import make_packet
from .common import (GateError, GateVoid, checked_pin, fields, file_pin, json_bytes, nonempty, now,
                     parse_json, pinned_bytes, sha256, timestamp, write_once)
from .registration import load_run


RESULTS = {"candidate": "predictions.jsonl", "baseline": "baseline.jsonl"}
IDENTITY_KEYS = ("model", "model_id", "checkpoint", "checkpoint_sha256", "system_identity", "system_name", "system")


def jsonl(data: bytes, source: str) -> list[dict]:
    rows = []
    for number, line in enumerate(data.split(b"\n"), 1):
        if line.strip():
            rows.append(parse_json(line, f"{source}:{number}"))
    return rows


def optional_pin(path: Path) -> dict | None:
    return file_pin(path) if path.exists() or path.is_symlink() else None


def native_provenance(pin: dict, artifact: dict, cases: dict, results: dict, settings: dict) -> dict:
    manifest = parse_json(pinned_bytes(pin, "native prediction manifest"), pin["path"])
    if not isinstance(manifest, dict):
        raise GateError("Native generation manifest must be a JSON object.")
    expected = {
        "input_sha256": cases["sha256"], "predictions_sha256": results["sha256"],
        "checkpoint_sha256": artifact["sha256"], "max_tokens": settings["max_tokens"],
    }
    if (type(manifest.get("max_tokens")) is not int
            or any(manifest.get(key) != value for key, value in expected.items())):
        raise GateError("Native generation manifest differs from the registered inputs or recorded results.")
    if "holdout_sha256" in manifest and manifest["holdout_sha256"] != cases["sha256"]:
        raise GateError("Native generation manifest has a different holdout SHA-256.")
    if any(key in manifest and manifest[key] != settings[key] for key in ("seed", "temperature", "eos_rule")):
        raise GateError("Native generation manifest settings differ from the registration.")
    if manifest.get("decoding") == "greedy" and settings["temperature"] != 0:
        raise GateError("Native greedy decoding requires registered temperature 0.")
    return manifest


def recorded_results(run: Path, document: dict, pins: dict) -> dict:
    records = {}
    for role in RESULTS:
        path = run / f"{role}.evidence.json"
        receipt = optional_pin(path)
        if receipt is None:
            continue
        record = parse_json(pinned_bytes(receipt, f"{role} evidence receipt"), path)
        if (role not in document or record["role"] != role or record["start_sha256"] != pins["start"]["sha256"]
                or record["artifact"] != pins[role] or record["cases"] != pins["cases"]
                or record["settings"] != document["generation"]
                or record["predictions"]["path"] != str(run / RESULTS[role])):
            raise GateVoid(f"Gate void: {role} evidence receipt differs from the authorized run.")
        checked_pin(record["predictions"], f"{role} predictions")
        checked_pin(record["provenance"], f"{role} provenance")
        if record["native_manifest"] is not None:
            checked_pin(record["native_manifest"], f"{role} native prediction manifest")
        records[role] = (receipt, record)
    return records


def record_results(run: Path, role: str, provenance_path: Path, native_path: Path | None,
                   command: list[str]) -> Path:
    run = run.resolve()
    document, start, pins = load_run(run)
    previous = recorded_results(run, document, pins)
    if (run / "packet").exists():
        raise GateError("Results have already been packed.")
    if role not in document:
        raise GateError(f"No {role} artifact was registered.")
    if role in previous:
        raise GateError(f"{role.capitalize()} results already recorded.")
    source = file_pin(provenance_path)
    provenance = parse_json(pinned_bytes(source, "producer provenance"), source["path"])
    fields(provenance, {"command", "settings"}, "producer provenance")
    argv = provenance["command"]
    if not isinstance(argv, list) or not argv or not all(isinstance(arg, str) for arg in argv) or not nonempty(argv[0]):
        raise GateError("Producer provenance command must be a nonempty argv array.")
    if json_bytes(provenance["settings"]) != json_bytes(document["generation"]):
        raise GateError("Observed producer settings differ from the registration.")

    path = run / RESULTS[role]
    if timestamp(start["started_at"]).timestamp() > path.stat().st_mtime:
        raise GateError("Prediction file modification time precedes the authorized run.")
    predictions = file_pin(path)
    if predictions["path"] != str(path):
        raise GateError("Prediction files must be regular files at their assigned run paths.")
    native = file_pin(native_path) if native_path is not None else None
    if native is not None:
        if document["adapter"] != "generation":
            raise GateError("A native prediction manifest is only supported for generation.")
        native_provenance(native, pins[role], pins["cases"], predictions, document["generation"])

    output = run / f"{role}.evidence.json"
    write_once(output, {
        "schema_version": 1, "role": role, "start_sha256": pins["start"]["sha256"],
        "artifact": pins[role], "cases": pins["cases"], "predictions": predictions,
        "provenance": source, "native_manifest": native, "settings": document["generation"],
        "producer_command": argv, "command": command, "recorded_at": now(),
    })
    return output


def load_cases(document: dict, pins: dict) -> list[dict]:
    source = pins["cases"]
    cases = jsonl(pinned_bytes(source, "frozen cases"), source["path"])
    ids = set()
    for case in cases:
        if not isinstance(case, dict) or not all(nonempty(case.get(key)) for key in ("id", "language", "category")):
            raise GateError("Every frozen case needs a nonempty id, language and category.")
        if case["id"] in ids:
            raise GateError(f"Duplicate frozen case ID: {case['id']}")
        if document["adapter"] != "classifier" and not nonempty(case.get("criterion")):
            raise GateError(f"Frozen case {case['id']} needs a nonempty judge criterion.")
        ids.add(case["id"])
    validate_cases(document["adapter"], cases, document["rule"])
    return cases


def identities_from(row: dict) -> list[str]:
    return [row[key] for key in IDENTITY_KEYS if nonempty(row.get(key))]


def make_evaluation(run: Path, document: dict, pins: dict, records: dict) -> tuple[dict, dict, list[dict]]:
    required = {role for role in RESULTS if role in document}
    if records.keys() != required:
        raise GateError("Record results for every registered arm before packing.")
    cases = load_cases(document, pins)
    judging = document["judging"]
    terms = [term.strip() for term in judging["identity_terms"]]
    prepared = {}
    for role, (_, record) in records.items():
        artifact = pins[role]
        name = Path(artifact["path"]).name
        terms.extend((artifact["path"], document[role]["path"], name, artifact["sha256"]))
        data = pinned_bytes(record["predictions"], f"{role} predictions")
        predictions = jsonl(data, record["predictions"]["path"])
        prepared[role] = prepare(document["adapter"], cases, predictions, run, document["rule"],
                                 artifact["sha256"], document["generation"], baseline=role == "baseline")
        for row in predictions:
            terms.extend(identities_from(row))
        if record["native_manifest"] is not None:
            manifest = native_provenance(record["native_manifest"], artifact, pins["cases"],
                                         record["predictions"], document["generation"])
            if "cases" in manifest and (type(manifest["cases"]) is not int or manifest["cases"] != len(cases)):
                raise GateError("Native generation manifest case count differs from the frozen set.")
            terms.extend(identities_from(manifest))

    candidate = prepared["candidate"]
    baseline = prepared.get("baseline")
    if document["adapter"] == "classifier":
        # Truth and predictions stay private in an automatic gate.
        case_index = [{key: case[key] for key in ("id", "language", "category")} for case in cases]
        packet, id_map, sides = make_packet(case_index, {case["id"]: {} for case in cases},
                                            judging["shuffle_seed"], [])
    else:
        packet, id_map, sides = make_packet(cases, candidate["items"], judging["shuffle_seed"], terms,
                                            baseline_items=baseline["items"] if baseline else None)
    case_results = {role: {key: data[key] for key in ("eligible", "observations", "outcomes", "evidence")}
                    for role, data in prepared.items()}
    return packet, {"case_ids": id_map, "candidate_sides": sides, "case_results": case_results}, cases


def pack(run: Path, command: list[str]) -> Path:
    run = run.resolve()
    document, _, pins = load_run(run)
    records = recorded_results(run, document, pins)
    destination = run / "packet"
    if destination.exists():
        raise GateError("Blind packet already exists.")
    packet, evaluation, _ = make_evaluation(run, document, pins, records)
    with TemporaryDirectory(dir=run) as temporary:
        stage = Path(temporary) / "packet"
        stage.mkdir(mode=0o700)
        write_once(stage / "judge-sheet.json", packet)
        write_once(stage / "receipt.json", {
            "schema_version": 1, "command": command, "packed_at": now(),
            "shuffle_seed": document["judging"]["shuffle_seed"],
            "packet_sha256": sha256(json_bytes(packet)), "start_sha256": pins["start"]["sha256"],
            "result_receipts": {role: pin for role, (pin, _) in records.items()},
            "evaluation": evaluation,
        })
        # The destination is always nonempty once published. A concurrent pack cannot replace it.
        os.rename(stage, destination)
    return destination / "judge-sheet.json"


def load_packet(run: Path, document: dict, pins: dict, records: dict) -> tuple[dict, dict, list[dict]]:
    directory = run / "packet"
    receipt_pin = file_pin(directory / "receipt.json")
    receipt = parse_json(pinned_bytes(receipt_pin, "packet receipt"), receipt_pin["path"])
    if (receipt["start_sha256"] != pins["start"]["sha256"]
            or receipt["shuffle_seed"] != document["judging"]["shuffle_seed"]
            or receipt["result_receipts"] != {role: pin for role, (pin, _) in records.items()}):
        raise GateVoid("Gate void: packet receipt differs from the authorized run.")
    packet_pin = {"path": str(directory / "judge-sheet.json"), "sha256": receipt["packet_sha256"]}
    raw = pinned_bytes(packet_pin, "blind packet")
    for data in receipt["evaluation"]["case_results"].values():
        for evidence in data["evidence"]:
            checked_pin(evidence, "agent state or output")
    packet, evaluation, cases = make_evaluation(run, document, pins, records)
    if raw != json_bytes(packet) or receipt["evaluation"] != evaluation:
        raise GateVoid("Gate void: blind packet or task evidence differs from the packed evaluation.")
    pins["packet"] = packet_pin
    pins["packet_receipt"] = receipt_pin
    return packet, receipt, cases
