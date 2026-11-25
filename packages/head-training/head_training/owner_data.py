"""Read explicitly approved local human labels alongside public supervision."""

from __future__ import annotations

import json
from dataclasses import asdict
from datetime import date
from hashlib import sha256

from .config import OwnerSource, checked_keys, integer, nonempty, obj, strings
from .datasets import Example
from .v2_exclusion import MANIFEST_SHA256, ExclusionReceipt, load_registry


def read_owner_source(source: OwnerSource, task: str) -> tuple[list[Example], dict[str, object]]:
    registry = load_registry()
    card_bytes = source.card.path.read_bytes()
    if sha256(card_bytes).hexdigest() != source.card.sha256:
        raise ValueError(f"SHA-256 mismatch for {source.card.path}.")
    card = obj(json.loads(card_bytes.decode("utf-8")), "owner source card")
    for field in ("source", "license", "consent", "reviewer", "download_date"):
        nonempty(card.get(field), field)
    date.fromisoformat(card["download_date"])
    if card.get("origin") != "human" or card.get("decision") != "approved" or card.get("sha256") != source.path.sha256:
        raise ValueError("Owner labels require a human-source approval card pinned to the exact rows.")
    source_id = f"owner:{source.path.sha256}"
    rows = []
    input_rows = dropped_rows = 0
    content_pin = sha256()
    with source.path.path.open("rb") as file:
        for raw_line in file:
            content_pin.update(raw_line)
            line = raw_line.decode("utf-8")
            if not line.strip():
                continue
            row = obj(json.loads(line), "owner example")
            checked_keys(row, {"id", "group", "language", "text", "split", "label", "history", "candidates", "gold",
                               "source_id", "source_ids"}, "owner example")
            label = nonempty(row["label"], "label") if "label" in row else None
            candidates = strings(row.get("candidates", []), "candidates")
            raw_gold = row.get("gold", [])
            if not isinstance(raw_gold, list):
                raise ValueError("gold must be an array of candidate indices.")
            gold = tuple(sorted({integer(index, "candidate index", 0) for index in raw_gold}))
            if any(index >= len(candidates) for index in gold):
                raise ValueError("A gold index falls outside the candidate list.")
            if bool(label) == bool(gold) or bool(candidates) != bool(gold):
                raise ValueError("An owner example needs a class label or candidates with gold indices.")
            example = Example(
                id=nonempty(row.get("id"), "id"), source=source_id,
                group=f"owner:{nonempty(row.get('group'), 'group')}",
                upstream_split=nonempty(row.get("split", "unsplit"), "split"),
                language=nonempty(row.get("language"), "language"), text=nonempty(row.get("text"), "text"),
                task=task, label=label, history=strings(row.get("history", []), "history"), candidates=candidates, gold=gold,
            )
            # The approval pins this row file, including explicit source identifiers the owner reviewed.
            native_id = nonempty(row.get("source_id", f"{source_id}:{example.id}"), "source_id")
            aliases = strings(row.get("source_ids", []), "source_ids")
            input_rows += 1
            if registry.matches((example.text, *example.history, *example.candidates),
                                source_id=native_id, source_ids=aliases):
                dropped_rows += 1
            else:
                rows.append(example)
    if content_pin.hexdigest() != source.path.sha256:
        raise ValueError(f"SHA-256 mismatch for {source.path.path}.")
    if not input_rows:
        raise ValueError(f"Owner source {source.path.path} contains no labelled rows.")
    receipt = ExclusionReceipt(MANIFEST_SHA256, input_rows, dropped_rows)
    return rows, {"path": str(source.path.path), "card_sha256": source.card.sha256,
                  "card": {**card, "exclusion": asdict(receipt)}, "rows": len(rows)}
