"""Resolve the existing v5 foundation publication without touching the trainer."""

from __future__ import annotations

import json
from hashlib import file_digest
from pathlib import Path
from typing import Any

from .config import Pin, TrunkPins, digest, integer, obj
from .scheduler import V5_FOUNDATION_STATUS

RUN = Path("artifacts/execution-model-runs/text-b5-2026-11-23")
CAMPAIGN = Path("artifacts/chat-training/v5/foundation-20261123")


def sha256_file(path: Path) -> str:
    with path.open("rb") as file:
        return file_digest(file, "sha256").hexdigest()


def verify_pin(pin: Pin) -> None:
    if sha256_file(pin.path) != pin.sha256:
        raise ValueError(f"SHA-256 mismatch for {pin.path}.")


def read_json(path: Path) -> dict[str, Any]:
    return obj(json.loads(path.read_text(encoding="utf-8")), str(path))


def foundation_pins(root: Path) -> TrunkPins:
    run = root / RUN
    campaign = root / CAMPAIGN
    status = read_json(root / V5_FOUNDATION_STATUS)
    assessment = read_json(campaign / "assessment.json")
    selection = read_json(run / "selected/manifest.json")
    if (
        status.get("status") not in ("completed", "early_stopped")
        or assessment.get("run_status") != status["status"]
        or assessment.get("stage") != "v5-2-foundation"
    ):
        raise ValueError("The v5 foundation assessment does not match its completed run.")
    positions = integer(status.get("best_checkpoint_tokens"), "best_checkpoint_tokens", 1)
    if positions != assessment.get("best_checkpoint_positions") or positions != selection.get("positions"):
        raise ValueError("The v5 foundation records disagree about the selected milestone.")
    checkpoint_sha = digest(assessment.get("candidate_checkpoint_sha256"))
    if checkpoint_sha != obj(selection.get("files"), "selected files").get("best.pt"):
        raise ValueError("The v5 foundation records disagree about the checkpoint digest.")
    if "best_checkpoint_sha256" in status and checkpoint_sha != status["best_checkpoint_sha256"]:
        raise ValueError("The v5 trainer status and selected checkpoint digest disagree.")
    config_path = campaign / "config.json"
    config_sha = digest(assessment.get("config_sha256"))
    if config_sha != selection.get("config_sha256"):
        raise ValueError("The v5 foundation records disagree about the trainer configuration.")
    verify_pin(Pin(config_path, config_sha))
    tokenizer_sha = obj(read_json(config_path).get("tokenizer_sha256"), "v5 tokenizer pins")
    return TrunkPins(
        Pin(run / "selected/best.pt", checkpoint_sha),
        Pin(run / "tokenizer.json", digest(tokenizer_sha.get("tokenizer.json"))),
        Pin(run / "tokenizer-report.json", digest(tokenizer_sha.get("tokenizer-report.json"))),
    )


def foundation_blocker(root: Path) -> str | None:
    try:
        pins = foundation_pins(root)
        if not pins.checkpoint.path.is_file():
            return "Waiting for the v5 foundation selected/best.pt publication."
    except FileNotFoundError:
        return "Waiting for the v5 foundation publication and assessment."
    except (OSError, ValueError) as error:
        return f"Cannot verify the v5 foundation publication: {error}"
    return None
