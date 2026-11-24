"""CPU tests for the frozen v5 chat probes: the frozen file, the inference framing and the context budget."""
import json
from pathlib import Path
import shutil
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline import REPOSITORY_ROOT
from execution_pipeline import chat_probes as probes
from execution_pipeline.chat import conversation_prompt
from execution_pipeline.pretrain import TextEncoder

TOKENIZER_RUN = REPOSITORY_ROOT / "artifacts/execution-model-runs/text-b3-ar-2026-11-15"


def test_frozen_probes_are_the_40_pinned_rows_in_order():
    rows = probes.frozen_probes()
    assert [row["id"] for row in rows] == probes.EXPECTED_IDS
    assert all(row["messages"][-1]["role"] == "user" for row in rows)


def test_every_prompt_plus_the_reply_budget_fits_the_context():
    lengths = probes.prompt_lengths(TextEncoder(TOKENIZER_RUN))
    assert len(lengths) == 40
    assert max(lengths.values()) + probes.MAX_NEW_TOKENS <= 512


def test_the_reply_is_generated_after_the_exact_inference_framing(monkeypatch):
    rendered = []
    monkeypatch.setattr(probes, "raw_continuation", lambda worker, prompt: rendered.append(prompt) or {"text": ""})
    for row in probes.frozen_probes():
        probes.reply_to(None, row)
        assert rendered[-1] == conversation_prompt(row["messages"])
    assert all(prompt.startswith("Mohassan chat v1\n") and prompt.endswith("\nAssistant:\n") for prompt in rendered)


def test_a_changed_probe_file_is_refused(tmp_path):
    copy = tmp_path / probes.PROBES
    copy.parent.mkdir(parents=True)
    shutil.copyfile(REPOSITORY_ROOT / probes.PROBES, copy)
    rows = copy.read_text(encoding="utf-8").splitlines()
    first = json.loads(rows[0])
    first["criterion"] += " "
    copy.write_text("\n".join([json.dumps(first, ensure_ascii=False), *rows[1:]]) + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match="changed"):
        probes.frozen_probes(tmp_path)


def test_prepare_refuses_a_checkpoint_with_another_hash(tmp_path):
    run = tmp_path / "run"
    (run / "snapshot").mkdir(parents=True)
    (run / "snapshot" / "best.pt").write_bytes(b"weights")
    with pytest.raises(ValueError, match="does not match"):
        probes.prepare(run, "snapshot", "0" * 64, tmp_path / "out")
    assert not (tmp_path / "out").exists()
