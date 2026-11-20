"""Real tiny CPU training verifies foundation provenance and exact safe resume."""
import json
import shutil
import sys
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline import language_adaptation
from execution_pipeline import foundation_comparison
from execution_pipeline.comparison_sampling import FrozenComparisonSampler, Window
from execution_pipeline.language_adaptation import ComparisonAnchor, ComparisonRecovery, ComparisonSettings, PilotSettings, adapt
from execution_pipeline.ads_finetune import _sha256
from execution_model.config import ModelConfig
from execution_model.model import ExecutionModel
from execution_model.tokenizer import ByteBPETokenizer


@pytest.fixture
def small_foundation(tmp_path):
    previous = torch.get_num_threads()
    torch.set_num_threads(1)
    run, corpus = tmp_path / "run", tmp_path / "corpus"
    (run / "pretrain").mkdir(parents=True)
    corpus.mkdir()
    tokenizer = ByteBPETokenizer()
    tokenizer.save(run / "tokenizer.json")
    (run / "tokenizer-report.json").write_text("{}")
    config = ModelConfig(vocab_size=tokenizer.vocab_size, hidden_size=16, intermediate_size=32,
                         num_layers=1, num_heads=2, max_context_length=32, seed=17)
    metadata = {"tokenizer_identity": tokenizer.identity, "config_identity": config.identity}
    (run / "pretrain/settings.json").write_text(json.dumps(metadata))
    torch.save({"config": config.to_dict(), "settings": metadata, "model_state": ExecutionModel(config).state_dict()},
               run / "pretrain/best.pt")
    manifest = {"tokenizer_identity": tokenizer.identity, "files": {}}
    for language, text in (("ar", "العربية لغة جميلة. "), ("en", "English replay text. ")):
        for split in ("train", "validation"):
            path = corpus / f"{language}.{split}.bin"
            tokens = np.array(tokenizer.encode(text * 30), dtype=np.uint16)
            tokens.tofile(path)
            manifest["files"][path.name] = {"tokens": len(tokens), "sha256": _sha256(path), "documents": 1}
    (corpus / "manifest.json").write_text(json.dumps(manifest))
    yield run, corpus
    torch.set_num_threads(previous)


def train_options(corpus):
    return dict(corpus=corpus, base_checkpoint=Path("pretrain/best.pt"), total_tokens=128,
                sequence=8, microbatch=2, accumulation=2, peak_lr=1e-3,
                warmup=1, eval_every=2, seed=8, device="cpu")


def test_real_training_preserves_base_and_writes_pinned_restartable_candidate(small_foundation):
    run, corpus = small_foundation
    original = _sha256(run / "pretrain/best.pt")
    result = adapt(run, out_name="continued", **train_options(corpus))
    assert result["status"] == "completed" and result["processed_tokens"] == 128
    assert sum(result["language_tokens"].values()) == result["processed_tokens"]
    assert result["language_tokens"]["ar"] > 0 and result["language_tokens"]["en"] > 0
    assert _sha256(run / "pretrain/best.pt") == original
    assert result["best_checkpoint_sha256"] == _sha256(run / "continued/best.pt")
    assert result["ready_for_chat"] is False
    last = torch.load(run / "continued/last.pt", weights_only=True)
    assert last["step"] == 4 and last["optimizer_state"]["state"]


def test_interrupted_then_resumed_optimizer_and_sampling_equal_uninterrupted_run(small_foundation):
    run, corpus = small_foundation
    options = train_options(corpus)
    adapt(run, out_name="full", **options)
    paused = adapt(run, out_name="resumed", max_minutes=1e-12, **options)
    assert paused["status"] == "paused_time_limit" and paused["step"] == 1
    result = adapt(run, out_name="resumed", resume=True, **options)
    assert result["status"] == "completed"
    full = torch.load(run / "full/last.pt", weights_only=True)
    resumed = torch.load(run / "resumed/last.pt", weights_only=True)
    assert full["language_tokens"] == resumed["language_tokens"]
    assert torch.equal(full["generator_state"], resumed["generator_state"])
    assert full["language_rng_state"] == resumed["language_rng_state"]
    assert all(torch.equal(tensor, resumed["model_state"][name]) for name, tensor in full["model_state"].items())


def test_legacy_adaptation_checkpoint_can_still_resume(small_foundation):
    run, corpus = small_foundation
    options = train_options(corpus)
    adapt(run, out_name="previous", max_minutes=1e-12, **options)
    path = run / "previous/last.pt"
    state = torch.load(path, weights_only=True)
    state["settings"]["trainer_sha256"] = language_adaptation.LEGACY_ADAPTATION_SHA256
    torch.save(state, path)
    (path.parent / "settings.json").write_text(json.dumps(state["settings"]))
    result = adapt(run, out_name="previous", resume=True, **options)
    assert result["status"] == "completed" and result["processed_tokens"] == 128


def test_changed_corpus_and_changed_resume_options_fail_closed(small_foundation):
    run, corpus = small_foundation
    options = train_options(corpus)
    adapt(run, out_name="resumed", max_minutes=1e-12, **options)
    with pytest.raises(ValueError, match="Resume settings"):
        adapt(run, out_name="resumed", resume=True, **{**options, "peak_lr": 2e-3})
    with (corpus / "ar.train.bin").open("ab") as stream:
        stream.write(b"\0\0")
    with pytest.raises(ValueError, match="size or hash"):
        adapt(run, out_name="corrupt", **options)
    assert not (run / "corrupt").exists()


def test_no_implicit_overwrite_or_unverified_tokenizer_mix(small_foundation):
    run, corpus = small_foundation
    adapt(run, out_name="once", **train_options(corpus))
    with pytest.raises(FileExistsError):
        adapt(run, out_name="once", **train_options(corpus))
    file = corpus / "manifest.json"
    manifest = json.loads(file.read_text())
    manifest["tokenizer_identity"] = "wrong"
    file.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="different tokenizer"):
        adapt(run, out_name="wrong-tokenizer", **train_options(corpus))


def pilot_options(small_foundation, tmp_path, attempt_path):
    run, corpus = small_foundation
    reference = tmp_path / "reference"
    reference.mkdir(exist_ok=True)
    attempt_path.mkdir()
    tokenizer_sha256 = _sha256(run / "tokenizer.json")
    manifest_path = corpus / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["tokenizer_sha256"] = tokenizer_sha256
    manifest_path.write_text(json.dumps(manifest))
    for language in ("ar", "en"):
        filename = f"{language}.validation.bin"
        if (corpus / filename).exists():
            shutil.move(corpus / filename, reference / filename)
    (reference / "manifest.json").write_text(json.dumps(manifest))
    config = ModelConfig(vocab_size=ByteBPETokenizer().vocab_size, hidden_size=16, intermediate_size=32,
                         num_layers=1, num_heads=2, max_context_length=8, seed=8)
    options = train_options(corpus)
    options.pop("base_checkpoint")
    options.update(total_tokens=112, arabic_fraction=0.5,
                   pilot=PilotSettings(config, reference, (50, 86, 112), 16, attempt_path, "tiny-pinned-test"))
    return options


def test_pilot_uses_only_fixed_reference_and_publishes_exact_balanced_milestones(small_foundation, tmp_path, monkeypatch):
    run, _ = small_foundation
    (run / "pretrain/best.pt").unlink()
    options = pilot_options(small_foundation, tmp_path, tmp_path / "attempt")
    original = language_adaptation._evaluate
    calls = []

    def observe(model, tokens, **settings):
        calls.append((Path(tokens.filename).parent, settings))
        return original(model, tokens, **settings)

    monkeypatch.setattr(language_adaptation, "_evaluate", observe)
    result = adapt(run, out_name="pilot", **options)
    assert result["processed_tokens"] == 112 and result["step"] == 5
    assert result["language_tokens"] == {"ar": 56, "en": 56}
    assert len(calls) == 8
    assert all(path == options["pilot"].reference and settings == {
        "batches": 20, "batch": 4, "length": 8, "device": "cpu"} for path, settings in calls)
    checkpoints = sorted((run / "pilot/checkpoints").glob("tokens-*"))
    receipts = [json.loads((folder / "manifest.json").read_text()) for folder in checkpoints]
    assert [row["tokens"] for row in receipts] == [0, 32, 50, 82, 86, 112]
    assert [row["tokens"] for row in receipts if row["exact_evaluation_milestone"]] == [50, 86, 112]
    for folder, row in zip(checkpoints, receipts):
        assert _sha256(folder / "checkpoint.pt") == row["checkpoint_sha256"]
        assert row["tokens_by_language"] == {"ar": row["tokens"] // 2, "en": row["tokens"] // 2}


def test_pilot_resumes_from_last_published_update_after_interruption(small_foundation, tmp_path):
    class InterruptAfterSecondUpdate:
        updates = 0

        def check(self):
            pass

        def start_training(self, name):
            pass

        def record_training_update(self, positions, seconds):
            self.updates += 1
            if self.updates == 2:
                raise RuntimeError("simulated interruption after update")

    run, _ = small_foundation
    full = pilot_options(small_foundation, tmp_path, tmp_path / "full-attempt")
    adapt(run, out_name="full", **full)
    interrupted = pilot_options(small_foundation, tmp_path, tmp_path / "interrupted-attempt")
    with pytest.raises(RuntimeError, match="simulated interruption"):
        adapt(run, out_name="resumed", guard=InterruptAfterSecondUpdate(), **interrupted)
    status = json.loads((run / "resumed/status.json").read_text())
    assert status["processed_tokens"] == 50 and status["last_checkpoint_tokens"] == 32
    earlier = run / "resumed/checkpoints/tokens-000000000032/manifest.json"
    preserved = _sha256(earlier)
    recovery = pilot_options(small_foundation, tmp_path, tmp_path / "recovery-attempt")
    result = adapt(run, out_name="resumed", resume=True, **recovery)
    assert result["status"] == "completed" and _sha256(earlier) == preserved
    ending = Path("checkpoints/tokens-000000000112/checkpoint.pt")
    uninterrupted = torch.load(run / "full" / ending, weights_only=True)
    resumed = torch.load(run / "resumed" / ending, weights_only=True)
    assert uninterrupted["language_tokens"] == resumed["language_tokens"]
    assert torch.equal(uninterrupted["generator_state"], resumed["generator_state"])
    assert all(torch.equal(tensor, resumed["model_state"][name]) for name, tensor in uninterrupted["model_state"].items())


def test_foundation_plateau_stops_at_committed_eval_and_survives_resume(small_foundation, tmp_path, monkeypatch):
    run, _ = small_foundation
    options = pilot_options(small_foundation, tmp_path, tmp_path / "plateau-first")
    scores = iter((5.0, 5.0, 4.0, 4.0, 4.0, 4.0))
    monkeypatch.setattr(language_adaptation, "_evaluate", lambda *args, **kwargs: next(scores))
    paused = adapt(run, out_name="plateau", max_minutes=1e-12, early_stop_flat_tokens=36, **options)
    assert paused["processed_tokens"] == 32
    replacement = pilot_options(small_foundation, tmp_path, tmp_path / "plateau-resume")
    with pytest.raises(ValueError, match="Resume settings"):
        adapt(run, out_name="plateau", resume=True, early_stop_flat_tokens=35, **replacement)
    result = adapt(run, out_name="plateau", resume=True, early_stop_flat_tokens=36, **replacement)
    assert result["status"] == "early_stopped" and result["processed_tokens"] == 86
    assert result["best_checkpoint_tokens"] == 50
    checkpoint = run / "plateau/checkpoints/tokens-000000000086/checkpoint.pt"
    state = torch.load(checkpoint, weights_only=True)
    assert state["processed_tokens"] == 86 and state["best_checkpoint_tokens"] == 50
    assert state["settings"]["early_stop_flat_tokens"] == 36
    assert not (run / "plateau/checkpoints/tokens-000000000112").exists()


def tiny_comparison_sampler(execution_microbatch=2):
    sampler = FrozenComparisonSampler.__new__(FrozenComparisonSampler)
    sampler._updates = [tuple(Window("source", 1 + index, 2 + index, length) for index, length in enumerate(lengths))
                        for lengths in ((8, 8), (5, 4), (8, 8), (2,), (8, 5))]
    sampler._ends = [32, 50, 82, 86, 112]
    sampler._stream = {"ar": np.arange(12), "source": np.arange(12) + 5}
    sampler._receipts = {m: {"positions_verified": m} for m in (50, 86, 112)}
    sampler.microbatch = 2
    sampler.execution_microbatch = execution_microbatch
    sampler._cursor = 0
    return sampler


class TinyDevelopment:
    def evaluate(self, model, *, output, **kwargs):
        result = {"strata": {"wiki": {"loss": 3.0}}, "equal_weight_prose_loss": 3.0}
        output.mkdir()
        (output / "manifest.json").write_text(json.dumps(result))
        return result


def test_comparison_uses_paired_windows_and_scores_only_its_milestones(small_foundation, tmp_path, monkeypatch):
    run, corpus = small_foundation
    options = pilot_options(small_foundation, tmp_path, tmp_path / "attempt")
    (corpus / "en.train.bin").unlink()
    (run / "pretrain/best.pt").unlink()
    monkeypatch.setattr(language_adaptation, "REPOSITORY_ROOT", tmp_path)
    fixed_calls = []

    def reference_score(model, tokens, **kwargs):
        fixed_calls.append(Path(tokens.filename).name)
        return 2.5

    monkeypatch.setattr(language_adaptation, "_evaluate", reference_score)
    comparison = ComparisonSettings(tiny_comparison_sampler(), TinyDevelopment(), {"seed": 8})
    options["pilot"] = replace(options["pilot"], comparison=comparison)
    result = adapt(run, out_name="comparison", **options)
    assert result["status"] == "completed" and result["processed_tokens"] == 112
    assert result["language_tokens"] == {"ar": 56, "en": 56}
    assert fixed_calls == ["ar.validation.bin", "en.validation.bin"] * 3
    assert len(result["initial_weights_sha256"]) == 64
    for tokens in (50, 86, 112):
        path = run / "comparison/checkpoints" / f"tokens-{tokens:012d}" / "manifest.json"
        receipt = json.loads(path.read_text())
        assert receipt["initial_weights_sha256"] == result["initial_weights_sha256"]
        assert receipt["comparison_sampling_receipt"] == {"positions_verified": tokens}
        development = receipt["development"]
        assert _sha256(tmp_path / development["output"] / "manifest.json") == development["manifest_sha256"]
    initial = run / "comparison/checkpoints/tokens-000000000000/manifest.json"
    assert not json.loads(initial.read_text())["exact_evaluation_milestone"]
    assert not (tmp_path / "attempt/development-000000000000").exists()


def test_comparison_continues_from_frozen_anchor_with_exact_optimizer_state(small_foundation, tmp_path, monkeypatch):
    run, _ = small_foundation
    monkeypatch.setattr(language_adaptation, "REPOSITORY_ROOT", tmp_path)
    monkeypatch.setattr(language_adaptation, "_evaluate", lambda *args, **kwargs: 2.5)
    options = pilot_options(small_foundation, tmp_path, tmp_path / "reference-attempt")
    original = {"seed": 8}
    full = replace(options["pilot"], lr_decay_tokens=112,
                   comparison=ComparisonSettings(tiny_comparison_sampler(), TinyDevelopment(), original))
    adapt(run, out_name="continuous", **{**options, "pilot": full})
    prefix_dir = tmp_path / "prefix-attempt"
    prefix_dir.mkdir()
    prefix = replace(full, milestones=(50, 86), attempt_output=prefix_dir,
                     comparison=ComparisonSettings(tiny_comparison_sampler(), TinyDevelopment(), original))
    adapt(run, out_name="prefix", **{**options, "pilot": prefix, "total_tokens": 86})
    anchor = run / "prefix/checkpoints/tokens-000000000086/checkpoint.pt"
    digest = _sha256(anchor)
    attempt = tmp_path / "fork-attempt"
    attempt.mkdir()
    extended = replace(full, attempt_output=attempt, config_sha256="new-config",
                       comparison=ComparisonSettings(tiny_comparison_sampler(), TinyDevelopment(), {"prefix": original},
                                                     anchor=ComparisonAnchor(anchor, digest, 86)))
    with pytest.raises(ValueError, match="changed settings"):
        adapt(run, out_name="fork", **{**options, "pilot": extended, "peak_lr": 2e-3})
    result = adapt(run, out_name="fork", **{**options, "pilot": extended})
    checkpoint = Path("checkpoints/tokens-000000000112/checkpoint.pt")
    fork = torch.load(run / "fork" / checkpoint, weights_only=True)
    reference = torch.load(run / "continuous" / checkpoint, weights_only=True)
    assert result["processed_tokens"] == 112 and result["step"] == 5
    assert fork["language_tokens"] == reference["language_tokens"] == {"ar": 56, "en": 56}
    assert all(torch.equal(tensor, reference["model_state"][name]) for name, tensor in fork["model_state"].items())
    assert _sha256(anchor) == digest


def test_comparison_rule4_recovery_splits_batches_and_preserves_original_anchor(
        small_foundation, tmp_path, monkeypatch):
    def ordered_rows(sampler):
        return [(language, row.tolist()) for language, batch in sampler.update(32, "cpu") for row in batch]

    assert ordered_rows(tiny_comparison_sampler(1)) == ordered_rows(tiny_comparison_sampler(2))
    assert tiny_comparison_sampler(1).targets(32) == tiny_comparison_sampler(2).targets(32)

    run, _ = small_foundation
    monkeypatch.setattr(language_adaptation, "REPOSITORY_ROOT", tmp_path)
    monkeypatch.setattr(language_adaptation, "_evaluate", lambda *args, **kwargs: 2.5)
    options = pilot_options(small_foundation, tmp_path, tmp_path / "original")
    original_code = {"packages/execution-pipeline/execution_pipeline/language_adaptation.py":
                     _sha256(Path(language_adaptation.__file__))}
    original_pilot = replace(options["pilot"], config_sha256="original-config", code_sha256=original_code,
                             comparison=ComparisonSettings(tiny_comparison_sampler(), TinyDevelopment(), {"seed": 8}))
    options["pilot"] = original_pilot
    first = adapt(run, out_name="comparison", max_minutes=1e-12, **options)
    assert first["status"] == "paused_time_limit" and first["last_checkpoint_tokens"] == 32
    out = run / "comparison"
    anchor = out / "checkpoints/tokens-000000000032/checkpoint.pt"
    original_sha = _sha256(anchor)
    original_settings = (out / "settings.json").read_bytes()
    new_attempt = tmp_path / "recovery"
    new_attempt.mkdir()
    recovery = ComparisonRecovery("original-config", original_code, 32, original_sha)
    changed = ComparisonSettings(tiny_comparison_sampler(1), TinyDevelopment(),
                                 {"seed": 8, "execution_microbatch_rows": 1, "recovery": {"test": True}}, recovery)
    options["pilot"] = replace(original_pilot, config_sha256="recovery-config",
                               code_sha256={**original_code, "new-module.py": "new-code-hash"},
                               attempt_output=new_attempt, comparison=changed)
    with pytest.raises(ValueError, match="may change only"):
        adapt(run, out_name="comparison", resume=True, **{**options, "peak_lr": 2e-3})
    result = adapt(run, out_name="comparison", resume=True, **options)
    assert result["status"] == "completed" and result["processed_tokens"] == 112
    assert result["step"] == 5 and result["language_tokens"] == {"ar": 56, "en": 56}
    assert result["initial_weights_sha256"] == first["initial_weights_sha256"]
    assert (out / "settings.json").read_bytes() == original_settings
    assert _sha256(anchor) == original_sha
    assert json.loads((out / "settings-recovery-recovery-config.json").read_text()) == result["settings"]
    receipt = json.loads((out / "checkpoints/tokens-000000000112/manifest.json").read_text())
    assert receipt["settings"]["comparison"]["execution_microbatch_rows"] == 1
    assert receipt["comparison_sampling_receipt"] == {"positions_verified": 112}


def test_rule4_recovery_chain_validates_prior_hash_and_preserves_original_configuration(tmp_path, monkeypatch):
    monkeypatch.setattr(foundation_comparison, "REPOSITORY_ROOT", tmp_path)
    campaign = tmp_path / "campaign"
    campaign.mkdir()

    def prepare(name, value):
        path = campaign / name
        path.write_text(json.dumps(value), encoding="utf-8")
        return {"path": path.relative_to(tmp_path).as_posix(), "sha256": _sha256(path)}

    original = {"prep": "frozen", "positions": 100_000_000, "code_sha256": {"trainer": "original"}}
    original_pin = prepare("config.json", original)
    first = {"arm": "first", "checkpoint_positions": 60_000_256, "checkpoint_sha256": "a" * 64,
             "max_microbatch_rows": 1, "previous_config": original_pin}
    version1 = {**original, "code_sha256": {"trainer": "first-recovery"}, "recovery": first}
    version1_pin = prepare("config-recovery.json", version1)
    second = {**first, "arm": "second", "checkpoint_sha256": "b" * 64, "previous_config": version1_pin}
    version2 = {**original, "code_sha256": {"trainer": "second-recovery"},
                "recoveries": {"first": first, "second": second}}
    path = campaign / "config-recovery-02.json"
    assert foundation_comparison._recovery_plan(campaign / "config-recovery.json", version1) == {"first": (first, original)}
    assert foundation_comparison._recovery_plan(path, version2) == {"first": (first, original), "second": (second, version1)}
    with pytest.raises(ValueError, match="must preserve earlier"):
        foundation_comparison._recovery_plan(path, {**version2, "recoveries": {"second": second}})
    with pytest.raises(ValueError, match="cannot alter"):
        foundation_comparison._recovery_plan(path, {**version2, "positions": 99_000_000})
    with pytest.raises(ValueError, match="file changed"):
        foundation_comparison._recovery_plan(path, {**version2, "recoveries": {
            "first": first, "second": {**second, "previous_config": {**version1_pin, "sha256": "c" * 64}}}})


@pytest.mark.parametrize(("stop_step", "kind", "expected_checkpoint", "expected_milestones"), [
    (1, "speed", 32, ()),
    (2, "speed", 0, ()),
    (3, "speed", 82, (50,)),
    (3, "memory", 50, (50,)),
])
def test_comparison_saves_only_committed_ordinary_speed_stop_updates(
        small_foundation, tmp_path, monkeypatch, stop_step, kind, expected_checkpoint, expected_milestones):
    class Rule4Stop:
        problem = None
        updates = 0

        def check(self):
            pass

        def start_training(self, name):
            pass

        def record_training_update(self, positions, elapsed):
            self.updates += 1
            if self.updates == stop_step:
                self.problem = f"GPU {kind} stop: synthetic test"
                raise RuntimeError(self.problem)

    run, _ = small_foundation
    monkeypatch.setattr(language_adaptation, "REPOSITORY_ROOT", tmp_path)
    monkeypatch.setattr(language_adaptation, "_evaluate", lambda *args, **kwargs: 2.5)
    options = pilot_options(small_foundation, tmp_path, tmp_path / "original")
    comparison = ComparisonSettings(tiny_comparison_sampler(1), TinyDevelopment(), {"seed": 8})
    options["pilot"] = replace(options["pilot"], comparison=comparison, checkpoint_every_tokens=100)
    with pytest.raises(RuntimeError, match=f"GPU {kind} stop"):
        adapt(run, out_name="comparison", guard=Rule4Stop(), **options)
    directory = run / "comparison"
    status = json.loads((directory / "status.json").read_text())
    assert status["status"] == "failed" and status["last_checkpoint_tokens"] == expected_checkpoint
    assert status["step"] == stop_step and status["processed_tokens"] == (32, 50, 82)[stop_step - 1]
    checkpoints = [json.loads(path.read_text()) for path in (directory / "checkpoints").glob("tokens-*/manifest.json")]
    assert tuple(sorted(row["tokens"] for row in checkpoints if row["exact_evaluation_milestone"])) == expected_milestones

    stop_receipts = [row for row in checkpoints if "stop_recovery" in row]
    if kind == "speed" and stop_step != 2:
        assert len(stop_receipts) == 1
        entry = stop_receipts[0]
        assert entry["stop_recovery"] == {
            "trigger": "rule4_speed_stop", "problem": "GPU speed stop: synthetic test",
            "step": stop_step, "tokens": expected_checkpoint, "committed_optimizer_update": True}
        assert entry["fixed_reference_validation_loss"] == {} and "development" not in entry
        payload = directory / "checkpoints" / f"tokens-{expected_checkpoint:012d}" / "checkpoint.pt"
        assert _sha256(payload) == entry["checkpoint_sha256"]
        state = torch.load(payload, weights_only=True)
        assert state["optimizer_state"]["state"] and state["step"] == stop_step
        assert state["stop_recovery"] == entry["stop_recovery"]
        resumed_attempt = tmp_path / "resumed"
        resumed_attempt.mkdir()
        resumed_comparison = replace(comparison, sampler=tiny_comparison_sampler(1))
        options["pilot"] = replace(options["pilot"], attempt_output=resumed_attempt, comparison=resumed_comparison)
        result = adapt(run, out_name="comparison", resume=True, **options)
        assert result["status"] == "completed" and result["processed_tokens"] == 112
        assert _sha256(payload) == entry["checkpoint_sha256"]
    else:
        assert not stop_receipts
