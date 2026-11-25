from __future__ import annotations

import io
import json
import subprocess
import sys
import tarfile
from hashlib import file_digest
from pathlib import Path

import pytest
import torch
from execution_model.config import ModelConfig
from execution_model.model import ExecutionModel
from execution_model.sidecar import load_sidecar
from execution_model.tokenizer import ByteBPETokenizer

from head_training.export import export_head, write_worker_config
from head_training.model import HeadModel

REPOSITORY = Path(__file__).resolve().parents[3]
WORKER_ROOT = "packages/execution-integration"


def _digest(path: Path) -> str:
    with path.open("rb") as handle:
        return file_digest(handle, "sha256").hexdigest()


@pytest.fixture
def trunk_files(tmp_path):
    tokenizer = ByteBPETokenizer()
    tokenizer_path = tmp_path / "tokenizer.json"
    tokenizer_path.write_text(json.dumps(tokenizer.to_dict()), encoding="utf-8")
    model = ExecutionModel(ModelConfig(
        vocab_size=tokenizer.vocab_size, hidden_size=16, intermediate_size=24, num_layers=1,
        num_heads=2, max_context_length=32, seed=35,
    ))
    checkpoint = tmp_path / "best.pt"
    torch.save({"config": model.config.to_dict(), "model_state": model.state_dict()}, checkpoint)
    return model, checkpoint, _digest(checkpoint), tokenizer, tokenizer_path


def test_export_pins_raw_sidecar_and_refuses_overwrite_or_wrong_base(tmp_path, trunk_files):
    trunk, checkpoint, pin, tokenizer, _ = trunk_files
    model = HeadModel(trunk, kind="classification", num_classes=2)
    directory = tmp_path / "route"
    with pytest.raises(ValueError, match="pin mismatch"):
        export_head(directory, model, checkpoint, "0" * 64)
    assert not directory.exists()
    exported = export_head(directory, model, checkpoint, pin, labels=("search", "compute"))
    with pytest.raises(FileExistsError):
        export_head(directory, model, checkpoint, pin)
    assert _digest(exported.checkpoint) == exported.checkpoint_sha256 == pin
    assert _digest(directory / "weights.pt") == exported.descriptor["sidecar"]["sha256"]
    assert _digest(directory / "sidecar.json") == exported.descriptor["sidecar"]["manifestSha256"]

    reloaded = torch.nn.Linear(trunk.config.hidden_size, 2)
    sidecar = load_sidecar(directory, reloaded, kind="classify", trunk_sha256=pin)
    assert sidecar["labels"] == ["search", "compute"]
    torch.testing.assert_close(reloaded.weight, model.projection.weight)
    torch.testing.assert_close(reloaded.bias, model.projection.bias)
    config = tmp_path / "model-worker.json"
    config_sha = write_worker_config(config, heads={"route": exported}, checkpoint=checkpoint,
                                     checkpoint_sha256=pin, tokenizer_identity=tokenizer.identity,
                                     eos_token_id=tokenizer.eos_token_id)
    assert _digest(config) == config_sha
    with pytest.raises(FileExistsError):
        write_worker_config(config, heads={"route": exported}, checkpoint=checkpoint, checkpoint_sha256=pin,
                            tokenizer_identity=tokenizer.identity, eos_token_id=tokenizer.eos_token_id)
    with pytest.raises(ValueError, match="share the exact trunk pin"):
        write_worker_config(tmp_path / "wrong.json", heads={"route": exported}, checkpoint=checkpoint,
                            checkpoint_sha256="0" * 64, tokenizer_identity=tokenizer.identity,
                            eos_token_id=tokenizer.eos_token_id)
    for invalid in ({"route/unsupported": exported}, {"x" * 65: exported},
                    {f"head-{index}": exported for index in range(33)}):
        with pytest.raises(ValueError, match="head identifiers"):
            write_worker_config(tmp_path / "invalid.json", heads=invalid, checkpoint=checkpoint, checkpoint_sha256=pin,
                                tokenizer_identity=tokenizer.identity, eos_token_id=tokenizer.eos_token_id)


def _origin_worker(ref: str, directory: Path) -> Path:
    available = subprocess.run(["git", "rev-parse", "--verify", ref], cwd=REPOSITORY, capture_output=True, check=False)
    if available.returncode:
        pytest.skip(f"Fetch origin's worker PR ref {ref} to run its parity test.")
    archive = subprocess.check_output(["git", "archive", ref, f"{WORKER_ROOT}/model_worker"], cwd=REPOSITORY)
    with tarfile.open(fileobj=io.BytesIO(archive)) as source:
        source.extractall(directory, filter="data")
    return directory / WORKER_ROOT


def _worker_outputs(worker_root, configs):
    # Load the actual PR worker in a separate interpreter so the two PR versions
    # each import their own package and read the same pinned trunk implementation.
    runner = """
import inspect
import json
from pathlib import Path
import sys

root, worker_root, configs = sys.argv[1:]
sys.path[:0] = [worker_root, str(Path(root) / 'packages/execution-model'),
                str(Path(root) / 'packages/execution-pipeline')]
from model_worker.engine import load_engine, torch
from model_worker.worker import _read_config

torch.set_num_threads(1)
outputs = []
for path, requests in json.loads(configs):
    path = Path(path)
    identity, config, limits, *_ = _read_config(path)
    kwargs = {'base_dir': path.parent, 'max_output_tokens': limits.max_output_tokens}
    if 'tokenizer_id' in inspect.signature(load_engine).parameters:
        kwargs['tokenizer_id'] = identity['tokenizerId']
    engine = load_engine(config, **kwargs)
    try:
        results = []
        for operation, head, payload in requests:
            value = engine.prepare(operation, head, payload)
            results.extend(engine.run_batch(operation, head, [value]))
        assert len({id(head.trunk) for head in engine.heads.values()}) == 1
        outputs.append(results)
    finally:
        engine.close()
print(json.dumps(outputs))
"""
    result = subprocess.run([sys.executable, "-B", "-c", runner, str(REPOSITORY), str(worker_root), json.dumps(configs)],
                            capture_output=True, text=True, timeout=60, check=False)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


@pytest.mark.parametrize("ref", ["origin/pr/19", "origin/pr/29"])
def test_actual_worker_matches_direct_classification_ranking_and_lora(tmp_path, trunk_files, ref):
    worker_root = _origin_worker(ref, tmp_path / "worker")
    trunk, checkpoint, pin, tokenizer, tokenizer_path = trunk_files
    route = HeadModel(trunk, kind="classification", num_classes=3, seed=11).eval()
    ranker = HeadModel(trunk, kind="pairwise", seed=17).eval()
    selector = HeadModel(trunk, kind="selection", seed=22).eval()
    base_config = tmp_path / "model-worker.json"
    tokenizer_pins = {"tokenizer_path": tokenizer_path, "tokenizer_sha256": _digest(tokenizer_path)} if ref.endswith("29") else {}
    common = dict(tokenizer_identity=tokenizer.identity, eos_token_id=tokenizer.eos_token_id, **tokenizer_pins)
    write_worker_config(
        base_config, heads={name: export_head(tmp_path / name, model, checkpoint, pin)
                            for name, model in (("route", route), ("rank", ranker), ("answer", selector))},
        checkpoint=checkpoint, checkpoint_sha256=pin, **common,
    )

    adapted_trunk = ExecutionModel(trunk.config)
    adapted_trunk.load_state_dict(trunk.state_dict())
    adapted = HeadModel(adapted_trunk, kind="classification", num_classes=3, seed=11, lora_rank=2).eval()
    assert adapted.adapter is not None
    with torch.no_grad():
        for value in adapted.adapter.parameters()[1::2]:
            value.copy_(torch.arange(value.numel()).reshape(value.shape) / 100)
    bundle = export_head(tmp_path / "adapted", adapted, checkpoint, pin)
    assert bundle.checkpoint_sha256 != pin and _digest(checkpoint) == pin
    adapted_config = tmp_path / "adapted-worker.json"
    write_worker_config(adapted_config, heads={"route": bundle}, checkpoint=bundle.checkpoint,
                        checkpoint_sha256=bundle.checkpoint_sha256, **common)

    ids = [5, 7, 2, 9]
    positions = [3, 1]
    classify = ["classify", "route", {"inputIds": ids}]
    ranked = {"inputIds": ids, "candidatePositions": positions}
    results, [adapted_result] = _worker_outputs(worker_root, [
        [str(base_config), [classify, ["score", "rank", ranked], ["select", "answer", ranked]]],
        [str(adapted_config), [classify]],
    ])
    with torch.inference_mode():
        inputs = torch.tensor([ids])
        candidates = torch.tensor([positions])
        assert not torch.allclose(route(inputs), adapted(inputs))
        for output, model in ((results[0], route), (adapted_result, adapted)):
            expected = model(inputs)[0]
            assert output["logits"] == pytest.approx(expected.tolist(), abs=2e-6, rel=2e-6)
            assert output["classIndex"] == int(expected.argmax())
        rank_scores = ranker(inputs, candidate_positions=candidates)[0]
        selection_scores = selector(inputs, candidate_positions=candidates)[0]
        assert results[1]["scores"] == pytest.approx(rank_scores.tolist(), abs=2e-6, rel=2e-6)
        assert results[2]["scores"] == pytest.approx(selection_scores.tolist(), abs=2e-6, rel=2e-6)
        assert results[2]["selectedIndex"] == int(selection_scores.argmax())
        assert results[2]["selectedPosition"] == positions[int(selection_scores.argmax())]
