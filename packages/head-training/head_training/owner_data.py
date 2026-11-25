"""Read explicitly approved local human labels alongside public supervision."""

from __future__ import annotations

import json
from datetime import date

from .config import OwnerSource, checked_keys, integer, nonempty, obj, strings
from .datasets import Example
from .foundation import read_json, verify_pin


def read_owner_source(source: OwnerSource, task: str) -> tuple[list[Example], dict[str, object]]:
    verify_pin(source.card)
    card = read_json(source.card.path)
    for field in ("source", "license", "consent", "reviewer", "download_date"):
        nonempty(card.get(field), field)
    date.fromisoformat(card["download_date"])
    if card.get("origin") != "human" or card.get("decision") != "approved" or card.get("sha256") != source.path.sha256:
        raise ValueError("Owner labels require a human-source approval card pinned to the exact rows.")
    verify_pin(source.path)
    source_id = f"owner:{source.path.sha256}"
    rows = []
    with source.path.path.open(encoding="utf-8") as file:
        for line in file:
            if not line.strip():
                continue
            row = obj(json.loads(line), "owner example")
            checked_keys(row, {"id", "group", "language", "text", "split", "label", "history", "candidates", "gold"},
                         "owner example")
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
            rows.append(Example(
                id=nonempty(row.get("id"), "id"), source=source_id,
                group=f"owner:{nonempty(row.get('group'), 'group')}",
                upstream_split=nonempty(row.get("split", "unsplit"), "split"),
                language=nonempty(row.get("language"), "language"), text=nonempty(row.get("text"), "text"),
                task=task, label=label, history=strings(row.get("history", []), "history"), candidates=candidates, gold=gold,
            ))
    if not rows:
        raise ValueError(f"Owner source {source.path.path} contains no labelled rows.")
    return rows, {"path": str(source.path.path), "card_sha256": source.card.sha256, "card": card, "rows": len(rows)}
