"""CPU fixtures for the frozen English next-token scorer."""
from collections import Counter
from hashlib import sha256
import json
import math
from pathlib import Path
import sys
from types import SimpleNamespace

import numpy as np
import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline.comparison_eval import FrozenEnglishDevelopment


CONTEXT = 512
VOCAB = 12
EOS = 1


def digest(path):
    return sha256(path.read_bytes()).hexdigest()


@pytest.fixture
def frozen_fixture(tmp_path):
    root = tmp_path / "frozen"
    root.mkdir()
    lengths = {
        "standard-wikipedia": [("wikipedia-20231101-en", 513), ("wikipedia-20231101-en", 2)],
        "simplewiki": [("simplewiki-20261101", 1023)],
        "human-dialogue": [("aya-original", 6), ("oasst2-human", 17)],
    }
    strata, sources, files, sequences = {}, {}, {}, {}
    for stratum, specs in lengths.items():
        packed, rows, stats = [], [], Counter()
        for i, (source, length) in enumerate(specs):
            id_ = f"{stratum}-{i}"
            tokens = list(2 + (j + i) % (VOCAB - 2) for j in range(length - 1)) + [EOS]
            sequences[id_] = tokens
            windows = math.ceil((length - 1) / (CONTEXT - 1))
            counts = {"documents": 1, "packed_tokens": length, "windows": windows,
                      "input_positions": length + windows - 1, "scored_targets": length - 1}
            rows.append({"id": id_, "stratum": stratum, "source": source, "source_group_key": [source, id_],
                         "article_family_key": id_ if stratum != "human-dialogue" else None,
                         "token_offset": len(packed), "tokens": length, **counts})
            packed.extend(tokens)
            stats.update(counts)
            sources.setdefault(source, Counter()).update(counts)
        strata[stratum] = stats
        binary, index = root / f"{stratum}.bin", root / f"{stratum}.documents.jsonl"
        np.asarray(packed, dtype="<u2").tofile(binary)
        index.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        files.update({path.name: digest(path) for path in (binary, index)})
    manifest = root / "manifest.json"
    manifest.write_text(json.dumps({"status": "frozen_cpu_preparation", "sha256": files,
                                    "validation_documents_by_stratum": strata,
                                    "validation_documents_by_source": sources}), encoding="utf-8")
    return root, digest(manifest), sequences


class TransitionFixture(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.config = SimpleNamespace(ignore_index=-100, vocab_size=VOCAB, max_context_length=CONTEXT)
        self.saw_padding = False

    def forward(self, ids, *, attention_mask):
        assert not self.training and not torch.is_grad_enabled() and ids.device.type == "cpu"
        if bool((~attention_mask).any()):
            self.saw_padding = True
            assert bool((ids[~attention_mask] == 0).all())
        position = torch.arange(ids.shape[1])
        predicted = (ids + 1 + position % 2) % VOCAB
        logits = torch.zeros((*ids.shape, VOCAB))
        logits.scatter_(2, predicted.unsqueeze(-1), 2.0)
        return SimpleNamespace(logits=logits)


def test_comparison_document_losses_score_each_target_once_and_ignore_pad(frozen_fixture, tmp_path):
    root, expected, sequences = frozen_fixture
    scorer = FrozenEnglishDevelopment(root, expected, pad_token_id=0, eos_token_id=EOS)
    model = TransitionFixture()
    output = tmp_path / "scored"
    result = scorer.evaluate(model, device="cpu", output=output)
    assert model.training and model.saw_padding
    records = [json.loads(line) for line in (output / "per-document.jsonl").read_text(encoding="utf-8").splitlines()]
    assert [row["id"] for row in records] == list(sequences)
    for row in records:
        tokens = sequences[row["id"]]
        assert row["source_group_key"] == [row["source"], row["id"]]
        assert row["scored_targets"] == len(tokens) - 1
        normalizer = math.log(math.exp(2) + VOCAB - 1)
        expected_loss = math.fsum(
            normalizer - (2 if (previous + 1 + ((position % (CONTEXT - 1)) % 2)) % VOCAB == target else 0)
            for position, (previous, target) in enumerate(zip(tokens[:-1], tokens[1:]))
        )
        assert row["loss_sum"] == pytest.approx(expected_loss, rel=1e-6)
    for stratum, stats in result["strata"].items():
        matching = [row for row in records if row["stratum"] == stratum]
        assert stats["documents"] == len(matching)
        assert stats["scored_targets"] == sum(row["scored_targets"] for row in matching)
        assert stats["loss_sum"] == math.fsum(row["loss_sum"] for row in matching)
    assert result["equal_weight_prose_loss"] == (result["strata"]["standard-wikipedia"]["mean_loss"]
                                                + result["strata"]["simplewiki"]["mean_loss"]) / 2
    assert digest(output / "per-document.jsonl") == result["files"]["per-document.jsonl"]
    assert json.loads((output / "manifest.json").read_text(encoding="utf-8")) == result
    with pytest.raises(FileExistsError):
        scorer.evaluate(model, device="cpu", output=output)


@pytest.mark.parametrize("artifact", ["manifest.json", "simplewiki.bin", "human-dialogue.documents.jsonl"])
def test_comparison_refuses_changed_frozen_inputs(frozen_fixture, artifact):
    root, expected, _ = frozen_fixture
    path = root / artifact
    path.write_bytes(path.read_bytes() + b" ")
    with pytest.raises(ValueError, match=artifact):
        FrozenEnglishDevelopment(root, expected, eos_token_id=EOS)


def test_comparison_refuses_invalid_span_even_with_matching_hash(frozen_fixture):
    root, _, _ = frozen_fixture
    index = root / "simplewiki.documents.jsonl"
    row = json.loads(index.read_text(encoding="utf-8"))
    row["token_offset"] += 1
    index.write_text(json.dumps(row) + "\n", encoding="utf-8")
    manifest = root / "manifest.json"
    receipt = json.loads(manifest.read_text(encoding="utf-8"))
    receipt["sha256"][index.name] = digest(index)
    manifest.write_text(json.dumps(receipt), encoding="utf-8")
    with pytest.raises(ValueError, match="Invalid development token span"):
        FrozenEnglishDevelopment(root, digest(manifest), eos_token_id=EOS)


def test_comparison_propagates_guard_stop_without_publishing(frozen_fixture, tmp_path):
    root, expected, _ = frozen_fixture
    scorer = FrozenEnglishDevelopment(root, expected, eos_token_id=EOS)
    model = TransitionFixture()
    calls = 0

    def progress_check():
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("Guard stopped fixture.")

    output = tmp_path / "interrupted"
    with pytest.raises(RuntimeError, match="Guard stopped"):
        scorer.evaluate(model, device="cpu", output=output, progress_check=progress_check)
    assert calls == 2 and model.training
    assert not output.exists()
