"""Create blind judge packets and validate independent verdict submissions."""
from __future__ import annotations

import random
import re
from datetime import datetime, timezone

from .common import GateError


_TIMESTAMP = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}"
    r"(?:\.[0-9]{1,6})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])"
)
_VERDICT_FIELDS = {"schema_version", "judge_id", "judged_at", "packet_sha256", "verdicts"}


def _mix_languages(cases: list[dict], rng: random.Random) -> list[dict]:
    groups: dict[str, list[dict]] = {}
    for case in cases:
        groups.setdefault(case["language"], []).append(case)
    active = list(groups)
    rng.shuffle(active)
    for language in active:
        rng.shuffle(groups[language])

    ordered = []
    previous = None
    while active:
        available = [language for language in active if language != previous] or active
        language = max(available, key=lambda key: len(groups[key]))
        ordered.append(groups[language].pop())
        if not groups[language]:
            active.remove(language)
        previous = language
    return ordered


def _redact(value, identities: re.Pattern | None):
    if identities is None:
        return value
    if isinstance(value, str):
        return identities.sub("[redacted]", value)
    if isinstance(value, list):
        return [_redact(item, identities) for item in value]
    if isinstance(value, dict):
        sanitized = {}
        for key, item in value.items():
            label = _redact(key, identities)
            if label in sanitized:
                raise GateError("Identity redaction produces duplicate blind evidence keys.")
            sanitized[label] = _redact(item, identities)
        return sanitized
    return value


def make_packet(
    cases: list[dict], items: dict[str, dict], seed: int, identity_terms: list[str],
    *, baseline_items: dict[str, dict] | None = None,
) -> tuple[dict, dict[str, str], dict[str, str]]:
    """Return the judge packet, private case IDs and private candidate sides."""
    terms = sorted(set(identity_terms) - {""}, key=lambda term: (-len(term), term))
    identities = re.compile("|".join(re.escape(term) for term in terms), re.IGNORECASE) if terms else None
    rng = random.Random(seed)
    ordered = _mix_languages(cases, rng)
    packet = {"schema_version": 1, "items": []}
    id_map = {}
    candidate_sides = {}
    for index, case in enumerate(ordered, 1):
        item_id = f"item-{index:03d}"
        case_id = case["id"]
        id_map[item_id] = case_id
        candidate = _redact(items[case_id], identities)
        if {"id", "criterion", "a", "b"} & candidate.keys():
            raise GateError("Blind evidence uses reserved packet fields.")
        item = {"id": item_id}
        if "criterion" in case:
            item["criterion"] = _redact(case["criterion"], identities)
        if baseline_items is None:
            item.update(candidate)
        else:
            baseline = _redact(baseline_items[case_id], identities)
            if rng.randrange(2) == 0:
                item.update(a=candidate, b=baseline)
                candidate_sides[item_id] = "a"
            else:
                item.update(a=baseline, b=candidate)
                candidate_sides[item_id] = "b"
        packet["items"].append(item)
    return packet, id_map, candidate_sides


def _normalize_time(value) -> str:
    if isinstance(value, str) and _TIMESTAMP.fullmatch(value) and not value.endswith("-00:00"):
        try:
            instant = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return instant.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        except (ValueError, OverflowError):
            pass
    raise GateError("Verdict judged_at must be an RFC 3339 timestamp with a known time zone.")


def _normalize_choice(choice) -> dict:
    if not isinstance(choice, dict) or set(choice) != {"passed", "reason"}:
        raise GateError("Every judgment needs exactly passed and reason.")
    reason = choice["reason"]
    if type(choice["passed"]) is not bool or not isinstance(reason, str) or not reason.strip():
        raise GateError("Every judgment needs a boolean and a concrete reason.")
    return {"passed": choice["passed"], "reason": reason.strip()}


def validate_verdict(sheet, packet: dict, packet_sha256: str) -> dict:
    if not isinstance(sheet, dict) or set(sheet) != _VERDICT_FIELDS:
        raise GateError("Invalid verdict sheet fields.")
    if type(sheet["schema_version"]) is not int or sheet["schema_version"] != 1:
        raise GateError("Unsupported verdict schema version.")
    if sheet["packet_sha256"] != packet_sha256:
        raise GateError("Verdict sheet belongs to a different packet.")
    judge_id = sheet["judge_id"]
    if not isinstance(judge_id, str) or not judge_id.strip():
        raise GateError("Verdict judge_id must identify a judge.")
    judged_at = _normalize_time(sheet["judged_at"])
    if not isinstance(sheet["verdicts"], list):
        raise GateError("Verdicts must be a list.")

    expected = {item["id"]: item for item in packet["items"]}
    by_id = {}
    for row in sheet["verdicts"]:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or row["id"] not in expected:
            raise GateError("Verdict refers to an unknown packet item.")
        item_id = row["id"]
        if item_id in by_id:
            raise GateError("Duplicate verdict for a packet item.")
        if "a" in expected[item_id]:
            if set(row) != {"id", "a", "b"}:
                raise GateError("A paired verdict must judge both sides of the item.")
            verdict = {side: _normalize_choice(row[side]) for side in ("a", "b")}
        else:
            verdict = _normalize_choice({key: value for key, value in row.items() if key != "id"})
        by_id[item_id] = {"id": item_id, **verdict}
    if set(by_id) != set(expected):
        raise GateError("Verdict sheet must cover every packet item.")
    return {
        "schema_version": 1,
        "judge_id": judge_id.strip(),
        "judged_at": judged_at,
        "packet_sha256": packet_sha256,
        "verdicts": [by_id[item_id] for item_id in expected],
    }
