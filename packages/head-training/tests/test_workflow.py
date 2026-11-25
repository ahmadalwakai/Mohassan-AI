from __future__ import annotations

import json
from pathlib import Path

import pytest
import torch

from head_training.__main__ import main
from head_training.config import load_config
from head_training.encoding import encode_input
from head_training.foundation import CAMPAIGN, RUN, foundation_blocker, foundation_pins, sha256_file
from head_training.scheduler import SHARED_GPU_LOCK, V5_FOUNDATION_STATUS

# isort: split
from execution_model.config import ModelConfig
from execution_model.model import ExecutionModel
from execution_model.tokenizer import ByteBPETokenizer


def _write(path: Path, document: object) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
    return path


def _pin(path: Path) -> dict[str, str]:
    return {"path": str(path), "sha256": sha256_file(path)}


def test_shared_encoding_preserves_request_and_worker_candidate_order():
    tokenizer = ByteBPETokenizer([])
    eos = tokenizer.eos_token_id
    classification = encode_input(tokenizer, "ask", eos_token_id=eos, max_tokens=12,
                                  history=["old turn", "recent turn"])
    assert classification.input_ids[-4:] == (*tokenizer.encode("ask"), eos)
    assert len(classification.input_ids) == 12
    selected = encode_input(tokenizer, "ask", eos_token_id=eos, max_tokens=12,
                            candidates=["long one", "", "short", "last"])
    assert selected.candidate_indices == (0, 2, 3)
    assert all(selected.input_ids[position] == eos for position in selected.candidate_positions)
    assert selected.worker_payload() == {"inputIds": list(selected.input_ids),
                                         "candidatePositions": list(selected.candidate_positions)}
    assert len(selected.input_ids) == 12


def test_auto_foundation_keeps_v5_pins_and_waits_for_publication(tmp_path: Path):
    run = tmp_path / RUN
    campaign = tmp_path / CAMPAIGN
    status = tmp_path / V5_FOUNDATION_STATUS
    checkpoint = run / "selected/best.pt"
    checkpoint.parent.mkdir(parents=True)
    checkpoint.write_bytes(b"fixture for metadata resolution")
    digest = sha256_file(checkpoint)
    _write(status, {"status": "completed", "best_checkpoint_tokens": 100, "best_checkpoint_sha256": digest})
    assert "Waiting" in (foundation_blocker(tmp_path) or "")
    config = _write(campaign / "config.json", {"tokenizer_sha256": {"tokenizer.json": "1" * 64,
                                                                  "tokenizer-report.json": "2" * 64}})
    config_pin = sha256_file(config)
    _write(campaign / "assessment.json", {"stage": "v5-2-foundation", "run_status": "completed",
                                         "best_checkpoint_positions": 100, "candidate_checkpoint_sha256": digest,
                                         "config_sha256": config_pin})
    selection = _write(run / "selected/manifest.json", {"positions": 100, "files": {"best.pt": digest},
                                                       "config_sha256": config_pin})
    assert foundation_blocker(tmp_path) is None
    pins = foundation_pins(tmp_path)
    assert pins.checkpoint.path == checkpoint and pins.checkpoint.sha256 == digest
    assert pins.tokenizer.sha256 == "1" * 64
    _write(selection, {"positions": 101})
    assert "milestone" in (foundation_blocker(tmp_path) or "")


def test_cpu_cli_runs_two_heads_with_out_of_band_sealed_reference(tmp_path: Path, capsys):
    tokenizer = ByteBPETokenizer([])
    tokenizer_path = tmp_path / "tokenizer.json"
    tokenizer.save(tokenizer_path)
    trunk = ExecutionModel(ModelConfig(
        vocab_size=tokenizer.vocab_size, hidden_size=16, intermediate_size=24, num_layers=1,
        num_heads=2, max_context_length=32, seed=23,
    ))
    checkpoint = tmp_path / "tiny.pt"
    torch.save({"config": trunk.config.to_dict(), "model_state": trunk.state_dict()}, checkpoint)
    _write(tmp_path / V5_FOUNDATION_STATUS, {"status": "completed"})
    rows = tmp_path / "training.jsonl"
    rows.write_text("".join(json.dumps({
        "id": f"{split}-{index}", "language": "en", "group": f"{split}-{index}", "split": split,
        "text": f"{split} {index} {'alpha' if index % 2 else 'beta'}", "label": "a" if index % 2 else "b",
    }) + "\n" for split in ("train", "dev") for index in range(20)), encoding="utf-8")
    card = _write(tmp_path / "owner-card.json", {"source": "handwritten fixture", "license": "CC0-1.0",
                                                "consent": "test author", "origin": "human", "reviewer": "owner",
                                                "download_date": "2026-11-25", "decision": "approved",
                                                "sha256": sha256_file(rows)})
    reference = _write(tmp_path / "sealed-reference.json", {
        "schema_version": 1, "path": "unavailable-owner-cases.jsonl", "sha256": "1" * 64,
        "reviewer": "owner", "review_kind": "owner_authored", "reviewed_at": "2026-11-25T00:00:00Z",
    })
    baseline = _write(tmp_path / "rules.json", {"kind": "handwritten test rule"})
    job = {"name": "router", "task": "route", "max_tokens": 32, "min_calibration_accuracy": 0,
           "sources": [{"labelled": _pin(rows), "card": _pin(card)}],
           "training": {"batch_size": 4, "accumulation": 2, "epochs": 2, "learning_rate": 0.03},
           "gate": {"sealed_reference": str(reference), "baseline": _pin(baseline), "max_ece": 0.5}}
    config = _write(tmp_path / "jobs.json", {"device": "cpu", "trunk": {
        "checkpoint": _pin(checkpoint), "tokenizer": _pin(tokenizer_path),
    }, "jobs": [job, dict(job, name="intent", task="intent")]})
    output = tmp_path / "run"
    args = ["schedule", "--config", str(config), "--output", str(output)]
    assert main(args, root=tmp_path) == 0
    assert json.loads(capsys.readouterr().out)["dry_run"]
    assert not output.exists()
    assert main([*args, "--execute", "--no-wait"], root=tmp_path) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["status"] == "completed"
    manifest = json.loads((output / "router/manifest.json").read_text(encoding="utf-8"))
    assert manifest["sealed_reference"]["sha256"] == "1" * 64
    assert manifest["splits"]["calibration"]["used"] == {"en": 10}
    assert len(manifest["artifacts"]) == 5
    registration = json.loads((output / "router/gate/registration.json").read_text(encoding="utf-8"))
    assert registration["cases"]["allow_reuse"] is False
    assert registration["rule"]["minimum_counts"]["overall"] == 150
    assert registration["rule"]["classifier"]["max_ece"] == 0.5
    assert registration["candidate"] == _pin(output / "router/manifest.json")
    combined = json.loads((output / "model-worker.json").read_text(encoding="utf-8"))
    assert sorted(combined["model"]["heads"]) == ["intent", "router"]
    assert not (tmp_path / SHARED_GPU_LOCK).exists()
    assert not (tmp_path / "unavailable-owner-cases.jsonl").exists()
    manifest_path = output / "router/manifest.json"
    separate = tmp_path / "separate-packet"
    assert main(["register-gate", "--config", str(config), "--job", "router", "--manifest", str(manifest_path),
                 "--manifest-sha256", sha256_file(manifest_path), "--output", str(separate)], root=tmp_path) == 0
    assert json.loads((separate / "registration.json").read_text(encoding="utf-8")) == registration


def test_schedule_validates_source_tasks_and_windows_names(tmp_path: Path):
    job = {"name": "intent", "task": "intent", "sources": [{"dataset": "clinc150"}]}
    config = _write(tmp_path / "jobs.json", {"jobs": [job]})
    assert load_config(config, tmp_path).jobs[0].sources[0].task == "intent"
    _write(config, {"jobs": [dict(job, name="nul")]})
    with pytest.raises(ValueError, match="Windows-compatible"):
        load_config(config, tmp_path)
    _write(config, {"jobs": [dict(job, sources=[{"dataset": "xquad"}])]})
    with pytest.raises(ValueError, match="does not supply"):
        load_config(config, tmp_path)
