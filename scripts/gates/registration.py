"""Seal gate rules and reserve one evaluation use of a frozen case set."""
from __future__ import annotations

import math
from pathlib import Path

from .common import (GateError, GateVoid, checked_pin, fields, file_pin, mark_void, nonempty, now, parse_json,
                     pinned_bytes, read_json, require_active, require_file, sha256, valid_sha, write_once)
from .decision import validate_rule


def validate_registration(document: dict) -> None:
    fields(document, {"schema_version", "gate_id", "question", "adapter", "cases", "candidate",
                      "generation", "judging", "rule"}, "registration", {"baseline"})
    if type(document["schema_version"]) is not int or document["schema_version"] != 1:
        raise GateError("Registration schema_version must be 1.")
    if not all(nonempty(document[key]) for key in ("gate_id", "question")):
        raise GateError("Registration needs a gate_id and question.")
    adapter = document["adapter"]
    if adapter not in ("generation", "agent", "classifier"):
        raise GateError("Registration adapter must be generation, agent or classifier.")

    for key in ("cases", "candidate", "baseline"):
        if key not in document:
            continue
        source = document[key]
        required = {"path", "sha256"}
        if key == "cases":
            required |= {"sealed", "allow_reuse"}
        fields(source, required, key)
        if not nonempty(source["path"]) or not valid_sha(source["sha256"]):
            raise GateError(f"{key} requires a path and a lowercase SHA-256.")
    cases = document["cases"]
    if type(cases["sealed"]) is not bool or type(cases["allow_reuse"]) is not bool:
        raise GateError("cases.sealed and cases.allow_reuse must be booleans.")
    if cases["allow_reuse"] and not cases["sealed"]:
        raise GateError("cases.allow_reuse applies only to sealed sets.")
    if "baseline" in document and document["candidate"]["sha256"] == document["baseline"]["sha256"]:
        raise GateError("Candidate and baseline must be distinct artifacts.")

    generation = document["generation"]
    if adapter == "generation":
        fields(generation, {"seed", "temperature", "max_tokens", "eos_rule"}, "generation settings")
        temperature = generation["temperature"]
        if (type(generation["seed"]) is not int or type(generation["max_tokens"]) is not int
                or generation["max_tokens"] <= 0 or type(temperature) not in (int, float)
                or temperature < 0 or (type(temperature) is float and not math.isfinite(temperature))
                or generation["eos_rule"] not in ("require_eos", "allow_token_limit")):
            raise GateError("Invalid seed, temperature, max_tokens or eos_rule.")
    elif generation is not None:
        raise GateError("generation must be null for non-generation adapters.")

    judging = document["judging"]
    fields(judging, {"judges", "aggregation", "shuffle_seed", "identity_terms"}, "judging")
    judges = judging["judges"]
    aggregation = judging["aggregation"]
    if type(judges) is not int or type(judging["shuffle_seed"]) is not int:
        raise GateError("Judging requires integer judges and shuffle_seed values.")
    if adapter == "classifier":
        if judges != 0 or aggregation != "automatic":
            raise GateError("Classifier gates require automatic judging and zero judges.")
    elif judges < 1 or aggregation not in ("unanimous", "majority"):
        raise GateError("Human gates require at least one judge and unanimous or majority aggregation.")
    if not isinstance(judging["identity_terms"], list) or not all(map(nonempty, judging["identity_terms"])):
        raise GateError("judging.identity_terms must be an array of nonempty strings.")
    validate_rule(document["rule"], adapter, "baseline" in document)


def registration_pins(path: Path, document: dict) -> dict:
    pins = {}
    for key in ("cases", "candidate", "baseline"):
        if key in document:
            source = document[key]
            pin = {"path": str((path.parent / source["path"]).resolve()), "sha256": source["sha256"]}
            checked_pin(pin, key)
            pins[key] = pin
    return pins


def seal_path(path: Path) -> Path:
    return path.with_name(path.name + ".seal.json")


def seal(path: Path, command: list[str]) -> Path:
    path = path.resolve()
    require_file(path)
    raw = path.read_bytes()
    document = parse_json(raw, path)
    validate_registration(document)
    registration_pins(path, document)
    output = seal_path(path)
    write_once(output, {
        "schema_version": 1, "gate_id": document["gate_id"],
        "registration_sha256": sha256(raw), "sealed_at": now(), "command": command,
    })
    return output


def read_sealed_registration(path: Path, seal_pin: dict | None = None) -> tuple[dict, dict]:
    path = path.resolve()
    if seal_pin is None:
        seal_pin = file_pin(seal_path(path))
    raw = pinned_bytes(seal_pin, "registration seal")
    receipt = parse_json(raw, seal_pin["path"])
    fields(receipt, {"schema_version", "gate_id", "registration_sha256", "sealed_at", "command"},
           "registration seal")
    if receipt["schema_version"] != 1 or not valid_sha(receipt["registration_sha256"]):
        raise GateError("Invalid registration seal.")
    registration_pin = {"path": str(path), "sha256": receipt["registration_sha256"]}
    document = parse_json(pinned_bytes(registration_pin, "registration"), path)
    validate_registration(document)
    if receipt["gate_id"] != document["gate_id"]:
        raise GateVoid("Gate void: registration seal gate ID changed.")
    return document, {"registration": registration_pin, "seal": seal_pin, **registration_pins(path, document)}


def load_registration(path: Path, seal_pin: dict | None = None) -> tuple[dict, dict]:
    path = path.resolve()
    marker = path.with_name(path.name + ".void.json")
    require_active(marker)
    try:
        return read_sealed_registration(path, seal_pin)
    except GateVoid as error:
        mark_void(marker, str(error), ["verify sealed registration", str(path)])
        raise


def view_path(cases_pin: dict) -> Path:
    return Path(cases_pin["path"]).parent / ".gate-views" / cases_pin["sha256"]


def reserve_view(document: dict, pins: dict, run: Path, who: str, why: str,
                 command: list[str]) -> dict:
    directory = view_path(pins["cases"])
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    sealed = document["cases"]["sealed"]
    allow_reuse = document["cases"]["allow_reuse"]
    slot = 1
    while True:
        path = directory / f"{slot:06d}.json"
        entry = {
            "schema_version": 1, "case_sha256": pins["cases"]["sha256"], "gate_id": document["gate_id"],
            "registration_sha256": pins["registration"]["sha256"], "run": str(run),
            "who": who, "why": why, "viewed_at": now(), "command": command,
            "sealed": sealed, "allow_reuse": allow_reuse,
        }
        try:
            write_once(path, entry)
        except FileExistsError:
            previous = read_json(path)
            if previous["sealed"] is not sealed:
                raise GateError("Frozen case set cannot change its sealed status after use.") from None
            if sealed and (not allow_reuse or previous.get("allow_reuse") is not True):
                raise GateError("Sealed case set already used. A second use is refused.") from None
            slot += 1
        else:
            return file_pin(path)


def start(path: Path, run: Path, who: str, why: str, command: list[str]) -> Path:
    if not nonempty(who) or not nonempty(why):
        raise GateError("The view needs an identified operator and a reason.")
    document, pins = load_registration(path)
    run = run.resolve()
    run.mkdir(mode=0o700)
    try:
        pins["view"] = reserve_view(document, pins, run, who, why, command)
        output = run / "start.json"
        write_once(output, {
            "schema_version": 1, "run": str(run), "gate_id": document["gate_id"], "pins": pins,
            "started_at": now(), "who": who, "why": why, "command": command,
        })
    except BaseException:
        if not any(run.iterdir()):
            run.rmdir()
        raise
    return output


def load_run(run: Path) -> tuple[dict, dict, dict]:
    run = run.resolve()
    require_active(run / "void.json")
    start_pin = file_pin(run / "start.json")
    run_record = parse_json(pinned_bytes(start_pin, "run start"), run / "start.json")
    if run_record["run"] != str(run):
        raise GateVoid("Gate void: run directory differs from the authorized location.")
    pins = run_record["pins"]
    document, registered_pins = load_registration(Path(pins["registration"]["path"]), pins["seal"])
    if any(pins[key] != pin for key, pin in registered_pins.items()):
        raise GateVoid("Gate void: authorized registration pins changed.")
    view = pins["view"]
    entry = parse_json(pinned_bytes(view, "frozen case view"), view["path"])
    if (Path(view["path"]).parent != view_path(pins["cases"]) or entry["run"] != str(run)
            or entry["registration_sha256"] != pins["registration"]["sha256"]):
        raise GateVoid("Gate void: frozen case view does not authorize this run.")
    return document, run_record, {"start": start_pin, **pins}
