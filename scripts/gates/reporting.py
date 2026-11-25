"""Capture independent judgments, write linked decisions and record owner overrides."""
from __future__ import annotations

from itertools import combinations
from pathlib import Path

from .blind import validate_verdict
from .common import (GateError, GateVoid, checked_pin, file_pin, nonempty, now, parse_json, pinned_bytes, sha256,
                     timestamp, write_once)
from .decision import cohen_kappa, decide
from .evidence import load_packet, recorded_results
from .registration import load_run


def load_context(run: Path):
    document, start, pins = load_run(run)
    evidence = recorded_results(run, document, pins)
    packet, receipt, cases = load_packet(run, document, pins, evidence)
    return document, start, pins, evidence, packet, receipt, cases


def numbered(directory: Path, label: str, width: int):
    expected = sorted(directory.glob(f"{label}*.json"))
    for index, path in enumerate(expected, 1):
        if path.name != f"{label}{index:0{width}d}.json":
            raise GateError(f"Missing or unexpected record in {directory}: {path.name}")
    return expected


def judgments(run: Path, packet: dict, pins: dict, packed_at: str, limit: int) -> list:
    captured = []
    judges = set()
    for path in numbered(run / "verdicts", "verdict-", 6):
        pin = file_pin(path)
        entry = parse_json(pinned_bytes(pin, "captured verdict"), path)
        source = entry["source_json"].encode("utf-8")
        if sha256(source) != entry["source_sha256"] or entry["start_sha256"] != pins["start"]["sha256"]:
            raise GateVoid("Gate void: a captured verdict changed or belongs to a different run.")
        sheet = validate_verdict(parse_json(source, path), packet, pins["packet"]["sha256"])
        identity = sheet["judge_id"].casefold()
        if identity in judges or len(captured) == limit:
            raise GateError("Duplicate judge or too many verdict sheets.")
        check_judging_time(sheet, packed_at, entry["submitted_at"])
        judges.add(identity)
        captured.append((pin, entry, sheet))
    return captured


def check_judging_time(sheet: dict, packed_at: str, submitted_at: str) -> None:
    if not timestamp(packed_at) <= timestamp(sheet["judged_at"]) <= timestamp(submitted_at):
        raise GateError("Verdict judgment time must fall between packet creation and submission.")


def submit(run: Path, source: Path, command: list[str]) -> Path:
    run = run.resolve()
    document, _, pins, _, packet, receipt, _ = load_context(run)
    limit = document["judging"]["judges"]
    if limit == 0:
        raise GateError("Automatic gates do not accept human verdict sheets.")
    source_pin = file_pin(source)
    raw = pinned_bytes(source_pin, "judge submission")
    sheet = validate_verdict(parse_json(raw, source), packet, pins["packet"]["sha256"])
    submitted_at = now()
    check_judging_time(sheet, receipt["packed_at"], submitted_at)
    directory = run / "verdicts"
    directory.mkdir(mode=0o700, exist_ok=True)
    while True:
        captured = judgments(run, packet, pins, receipt["packed_at"], limit)
        history(run, pins)
        if any(prior["judge_id"].casefold() == sheet["judge_id"].casefold() for _, _, prior in captured):
            raise GateError(f"Duplicate judge identity: {sheet['judge_id']}")
        if len(captured) == limit:
            raise GateError("The registered number of independent verdicts is already complete.")
        output = directory / f"verdict-{len(captured) + 1:06d}.json"
        try:
            write_once(output, {
                "schema_version": 1, "source_json": raw.decode("utf-8"),
                "source_sha256": source_pin["sha256"], "source_path": source_pin["path"],
                "start_sha256": pins["start"]["sha256"], "submitted_at": submitted_at, "command": command,
            })
        except FileExistsError:
            continue
        return output


def judge_votes(captured: list, evaluation: dict) -> dict:
    sides = evaluation["candidate_sides"]
    roles = ("candidate", "baseline") if sides else ("candidate",)
    votes = {}
    for _, _, sheet in captured:
        scores = {role: {} for role in roles}
        for verdict in sheet["verdicts"]:
            blind_id = verdict["id"]
            case_id = evaluation["case_ids"][blind_id]
            if blind_id in sides:
                side = sides[blind_id]
                scores["candidate"][case_id] = verdict[side]["passed"]
                scores["baseline"][case_id] = verdict["b" if side == "a" else "a"]["passed"]
            else:
                scores["candidate"][case_id] = verdict["passed"]
        votes[sheet["judge_id"]] = scores
    return votes


def agreement(votes: dict) -> list[dict]:
    rows = []
    for (first, left), (second, right) in combinations(votes.items(), 2):
        row = {"judges": [first, second], "items": len(left["candidate"])}
        for role, scores in left.items():
            row[f"{role}_kappa"] = cohen_kappa(list(scores.values()), [right[role][key] for key in scores])
        rows.append(row)
    return rows


def score(role: str, result: dict, votes: dict, aggregation: str) -> dict:
    eligible = result["eligible"]
    if aggregation == "automatic":
        return eligible
    threshold = len(votes) if aggregation == "unanimous" else len(votes) // 2 + 1
    return {key: valid and sum(by_role[role][key] for by_role in votes.values()) >= threshold
            for key, valid in eligible.items()}


def summary(result: dict, count: int) -> str:
    decision = {"pass": "اجتياز", "stop": "توقف", "inconclusive": "غير حاسم"}[result["decision"]]
    parts = [f"قرار البوابة: {decision}. عدد الحالات المجمّدة: {count}."]
    if result["counts"] is None:
        check = result["reasons"][0]
        parts.append(f"الأحكام الكاملة المستلمة: {check['actual']} من {check['minimum']}.")
    else:
        counts = result["counts"]
        overall = counts["overall"]
        parts.append(f"الحالات المجتازة: {overall['passed']} من {overall['total']}.")
        for language, values in counts["languages"].items():
            parts.append(f"اللغة {language}: {values['passed']} من {values['total']}.")
        if result["decision"] != "pass":
            rules = "، ".join(reason["rule"] for reason in result["reasons"])
            parts.append(f"البنود التي حددت القرار: {rules}.")
    return " ".join(parts)


def history(run: Path, pins: dict) -> list:
    result = []
    previous = None
    for index, path in enumerate(numbered(run / "reports", "report-", 4), 1):
        pin = file_pin(path)
        report = parse_json(pinned_bytes(pin, "decision report"), path)
        if (report["version"] != index or report["previous_report"] != previous
                or any(report["hashes"].get(key) != value for key, value in pins.items())):
            raise GateVoid("Gate void: invalid report history for this run.")
        for verdict_pin in report["hashes"]["verdicts"]:
            checked_pin(verdict_pin, "verdict captured by a prior report")
        result.append((pin, report))
        previous = pin
    return result


def decide_run(run: Path, previous_path: Path | None, command: list[str]) -> Path:
    run = run.resolve()
    document, start, pins, evidence, packet, receipt, cases = load_context(run)
    reports = history(run, pins)
    previous = reports[-1][0] if reports else None
    if previous is not None and previous_path is None:
        raise GateError("A report already exists. Use --previous with the latest report to create a new version.")
    if previous_path is not None and (previous is None or str(previous_path.resolve()) != previous["path"]):
        raise GateError("--previous must name the latest report from this run.")
    config = document["judging"]
    captured = judgments(run, packet, pins, receipt["packed_at"], config["judges"])
    evaluation = receipt["evaluation"]
    votes = judge_votes(captured, evaluation)
    case_results = evaluation["case_results"]
    candidate = case_results["candidate"]
    baseline = case_results.get("baseline")
    if len(captured) < config["judges"]:
        check = {
            "rule": "judging.judges", "status": "inconclusive", "actual": len(captured),
            "minimum": config["judges"], "message": "The registered number of full judge sheets is missing.",
        }
        result = {"decision": "inconclusive", "checks": [check], "reasons": [check],
                  "counts": None, "mcnemar": None, "metrics": None}
    else:
        passed = score("candidate", candidate, votes, config["aggregation"])
        reference = score("baseline", baseline, votes, config["aggregation"]) if baseline is not None else None
        result = decide(document["rule"], cases, passed, reference, candidate["observations"])
        result["case_passes"] = {"candidate": passed}
        if reference is not None:
            result["case_passes"]["baseline"] = reference
    seal = parse_json(pinned_bytes(pins["seal"], "registration seal"), pins["seal"]["path"])
    view = parse_json(pinned_bytes(pins["view"], "frozen case view"), pins["view"]["path"])
    decided_at = now()
    version = len(reports) + 1
    report = {
        "schema_version": 1, "version": version, "previous_report": previous,
        "gate_id": document["gate_id"], "adapter": document["adapter"], "question": document["question"],
        "rule": document["rule"], "generation": document["generation"],
        "judging": {"judges": config["judges"], "aggregation": config["aggregation"],
                    "shuffle_seed": receipt["shuffle_seed"]},
        "case_count": len(cases), "agreement": agreement(votes),
        "mechanical_failures": {role: [key for key, eligible in data["eligible"].items() if not eligible]
                                for role, data in case_results.items()},
        "task_outcomes": {role: data["outcomes"] for role, data in case_results.items()
                          if data["outcomes"] is not None},
        "hashes": {
            **pins,
            "evidence": {role: {"receipt": pin, "predictions": data["predictions"],
                                "provenance": data["provenance"], "native_manifest": data["native_manifest"],
                                "task_files": case_results[role]["evidence"]}
                         for role, (pin, data) in evidence.items()},
            "verdicts": [dict(pin, original_sha256=entry["source_sha256"]) for pin, entry, _ in captured],
        },
        "commands": {"seal": seal["command"], "start": start["command"], "pack": receipt["command"],
                     "decide": command,
                     "evidence": {role: {"produce": data["producer_command"], "record": data["command"]}
                                  for role, (_, data) in evidence.items()},
                     "verdicts": [entry["command"] for _, entry, _ in captured]},
        "times": {"sealed_at": seal["sealed_at"], "viewed_at": view["viewed_at"],
                  "started_at": start["started_at"],
                  "packed_at": receipt["packed_at"], "decided_at": decided_at,
                  "recorded_at": {role: data["recorded_at"] for role, (_, data) in evidence.items()}},
        "judges": [{"judge_id": sheet["judge_id"], "judged_at": sheet["judged_at"],
                    "submitted_at": entry["submitted_at"]} for _, entry, sheet in captured],
        **result,
        "arabic_summary": summary(result, len(cases)),
    }
    directory = run / "reports"
    directory.mkdir(mode=0o700, exist_ok=True)
    output = directory / f"report-{version:04d}.json"
    write_once(output, report)
    return output


def override(run: Path, report_path: Path, decision: str, owner: str, rule: str,
             words_path: Path, output: Path, command: list[str]) -> Path:
    run = run.resolve()
    document, _, pins, _, packet, receipt, _ = load_context(run)
    judgments(run, packet, pins, receipt["packed_at"], document["judging"]["judges"])
    matching = [(pin, report) for pin, report in history(run, pins) if pin["path"] == str(report_path.resolve())]
    if not matching:
        raise GateError("Override requires a decision report from this run.")
    pin, report = matching[0]
    if rule not in {check["rule"] for check in report["checks"]}:
        raise GateError("Override rule does not name a check in the original report.")
    words_pin = file_pin(words_path)
    words = pinned_bytes(words_pin, "owner's words").decode("utf-8")
    if not nonempty(owner) or not nonempty(words):
        raise GateError("Override requires the owner's identity and verbatim words.")
    output = output.resolve()
    if output.parent == run / "reports" or output.parent == run / "verdicts":
        raise GateError("Write the override outside the decision and verdict directories.")
    write_once(output, {
        "schema_version": 1, "gate_id": document["gate_id"], "report": pin,
        "original_decision": report["decision"], "decision": decision,
        "owner": owner, "rule": rule, "words": words, "words_source": words_pin,
        "overridden_at": now(), "command": command,
    })
    return output
