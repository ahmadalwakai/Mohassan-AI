"""CPU tests for the V5-3 runner: the gates it keeps from Stage 5, its Gate 3 base, and the shared GPU lock."""
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline import stage5_finetune as stage5
from execution_pipeline import v5_finetune as v5


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def pin(path):
    return {"path": str(path), "sha256": stage5.sha256(path)}


@pytest.fixture
def evidence(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    root.mkdir()
    for name in v5.CODE_PATHS:
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("# fixture source; no model code loaded\n", encoding="utf-8")
    frozen = root / stage5.FROZEN_PROBE_MANIFEST
    write(frozen, {"frozen": True})
    monkeypatch.setattr(stage5, "FROZEN_PROBE_MANIFEST_SHA256", stage5.sha256(frozen))
    run = root / "run"
    (run / "selected").mkdir(parents=True)
    (run / "selected/best.pt").write_bytes(b"v5 Gate 3 candidate fixture")
    write(run / "selected/settings.json", {"prompt_hint": None})
    write(run / "tokenizer.json", {})
    write(run / "tokenizer-report.json", {})
    data = root / "data"
    data.mkdir()
    (data / "train.jsonl").write_bytes(b"opaque train fixture bytes\n")
    (data / "validation.jsonl").write_bytes(b"opaque validation fixture bytes\n")
    files = {f"{name}.jsonl": {"sha256": stage5.sha256(data / f"{name}.jsonl")} for name in ("train", "validation")}
    write(data / "manifest.json", {"source": "fixture-source", "files": files,
        "tokenizer_sha256": stage5.sha256(run / "tokenizer.json"),
        "inference_format": "execution_pipeline.chat.conversation_prompt(messages)",
        "counts": {lang: {"train": {"rows": 26_400, "multi_turn": 7_920}, "validation": {"rows": 2_400, "multi_turn": 720}}
                   for lang in ("ar", "en")}})
    reports = root / "reports"
    qa = reports / "qa.json"
    write(qa, {"semantic_quality_passed": True, "independent_review": True, "files": files,
               "reviews": [{"language": lang, "source": "fixture-source", "sample_size": 200, "wrong_or_unnatural": 0,
                            "passed": True} for lang in ("ar", "en")]})
    carrier, split = reports / "carrier.json", reports / "split.json"
    write(carrier, {"passed": True, "files": files, "counts": {lang: {"rows": 28_800, "peak_carrier_rows": 120,
        "peak_carrier_fraction": 120 / 28_800} for lang in ("ar", "en")}})
    write(split, {"passed": True, "files": files, "group_overlap_train_validation": 0,
                  "exact_normalized_prompt_target_duplicates": 0})
    eligibility = reports / "eligibility.json"
    write(eligibility, {"eligible_for_training": True, "semantic_quality_passed": True,
                       "dataset_manifest_sha256": stage5.sha256(data / "manifest.json"),
                       "dataset_sha256": {name: files[f"{name}.jsonl"]["sha256"] for name in ("train", "validation")},
                       "qa": [pin(qa)], "carrier_audit": pin(carrier), "split_audit": pin(split)})
    predictions = reports / "predictions.jsonl"
    predictions.write_bytes(b"opaque prediction fixture bytes\n")
    candidate = stage5.sha256(run / "selected/best.pt")
    generation = reports / "generation.json"
    write(generation, {"checkpoint_sha256": candidate, "input": {"sha256": stage5.FROZEN_PROBES_SHA256},
                       "scheduled": {"total": 40, "ar": 20, "en": 20}, "generated": {"total": 40, "ar": 20, "en": 20},
                       "finished": {"total": 40, "ar": 20, "en": 20},
                       "decoding": {"method": "greedy_argmax", "max_new_tokens": 192, "raw_prompt": True},
                       "predictions": pin(predictions)})
    gate3 = reports / "gate3.json"
    write(gate3, {"gate3_passed": True, "candidate_checkpoint_sha256": candidate,
                  "frozen_probe_manifest_sha256": stage5.FROZEN_PROBE_MANIFEST_SHA256,
                  "results": {lang: {"passed": 16, "total": 20} for lang in ("ar", "en")},
                  "generation_manifest": pin(generation)})
    kwargs = {"run": run, "base_checkpoint": Path("selected/best.pt"), "base_sha256": candidate, "out_name": "v5-dialogue",
              "campaign": root / "campaign", "dataset_dir": data, "gate3": gate3, "gate3_sha256": stage5.sha256(gate3),
              "eligibility": eligibility, "eligibility_sha256": stage5.sha256(eligibility),
              "qa": [(qa, stage5.sha256(qa))], "root": root}
    return kwargs


def refresh(kwargs, key, transform):
    value = stage5._read(kwargs[key])
    transform(value)
    write(kwargs[key], value)
    kwargs[f"{key}_sha256"] = stage5.sha256(kwargs[key])


def fake_runtime(monkeypatch, root):
    calls = {"awake": []}

    class Guard:
        def __init__(self, *args, **kwargs):
            calls["guard_kwargs"] = kwargs
        def __enter__(self):
            return self
        def __exit__(self, *args):
            calls["released"] = True
        def start_monitor(self):
            calls["monitored"] = True
        def check(self):
            return None
        def start_training(self, name):
            calls["training"] = name
        def record_training_update(self, positions, elapsed):
            calls["update"] = (positions, elapsed)
    monkeypatch.setattr(v5, "GpuJob", Guard)
    monkeypatch.setattr(stage5, "_cuda_start", lambda guard: guard.start_monitor())
    monkeypatch.setattr(stage5, "_awake", lambda flags: calls["awake"].append(flags) or 1)
    return calls


def test_prepare_and_check_need_no_gpu_and_keep_the_stage5_parameters(evidence, monkeypatch):
    monkeypatch.setattr(v5, "GpuJob", lambda *args, **kw: pytest.fail("preflight must not inspect the GPU"))
    monkeypatch.setattr(v5, "finetune", lambda *args, **kw: pytest.fail("preflight must not load a model"))
    prepared = v5.prepare(**evidence)
    protocol = v5.check(Path(prepared["protocol"]), prepared["protocol_sha256"], root=evidence["root"])
    assert protocol["parameters"] == stage5.PARAMETERS and protocol["stage"] == "v5-3"
    assert protocol["runtime_limit_seconds"] == 8 * 3600
    assert not (evidence["run"] / "v5-dialogue").exists()


def test_the_base_must_be_the_checkpoint_that_passed_gate3(evidence):
    refresh(evidence, "gate3", lambda gate: gate.update(candidate_checkpoint_sha256="b" * 64))
    with pytest.raises(ValueError):
        v5.prepare(**evidence)


@pytest.mark.parametrize("change", [lambda gate: gate.update(gate3_passed=False),
                                   lambda gate: gate["results"]["ar"].update(passed=15)])
def test_an_unpassed_gate3_cannot_unlock_fine_tuning(evidence, change):
    refresh(evidence, "gate3", change)
    with pytest.raises(ValueError):
        v5.prepare(**evidence)


def test_data_without_final_eligibility_is_refused(evidence):
    refresh(evidence, "eligibility", lambda receipt: receipt.update(eligible_for_training=False))
    with pytest.raises(ValueError, match="eligibility"):
        v5.prepare(**evidence)


def test_run_holds_the_shared_gpu_lock_and_selects_the_best_checkpoint(evidence, monkeypatch):
    prepared = v5.prepare(**evidence)
    calls = fake_runtime(monkeypatch, evidence["root"])
    lock = evidence["root"] / v5.SHARED_GPU_LOCK

    def trainer(run, **arguments):
        assert lock.exists(), "training must run while the shared lock is held"
        assert {name: arguments[name] for name in stage5.PARAMETERS} == stage5.PARAMETERS
        assert arguments["base_checkpoint"] == Path("selected/best.pt")
        arguments["progress_check"]()
        arguments["training_update"](100, 0.1)
        output = run / arguments["out_name"]
        output.mkdir()
        (output / "best.pt").write_bytes(b"best validation weights")
        (output / "last.pt").write_bytes(b"last weights")
        write(output / "settings.json", {"fixture": True})
        result = {"status": "early_stopped", "best_step": 100, "best_checkpoint_sha256": stage5.sha256(output / "best.pt"),
                  "validation_selection_metric": "macro_language_answer_loss",
                  "best_validation_metrics": {"macro_language_answer_loss": 2.0}}
        write(output / "status.json", result)
        return result
    monkeypatch.setattr(v5, "finetune", trainer)
    selected = v5.run(Path(prepared["protocol"]), prepared["protocol_sha256"], root=evidence["root"])
    assert selected["selected_checkpoint"]["sha256"] == stage5.sha256(evidence["run"] / "v5-dialogue/best.pt")
    assert selected["gate5_passed"] is None and selected["ready_for_chat"] is False
    assert not lock.exists() and calls["released"] and calls["awake"] == [0x80000001, 0x80000000]
    assert calls["guard_kwargs"]["max_seconds"] == 8 * 3600


def test_a_held_shared_lock_stops_the_run_before_training(evidence, monkeypatch):
    prepared = v5.prepare(**evidence)
    calls = fake_runtime(monkeypatch, evidence["root"])
    lock = evidence["root"] / v5.SHARED_GPU_LOCK
    write(lock, {"owner": "another job"})
    monkeypatch.setattr(v5, "finetune", lambda *args, **kw: pytest.fail("no training while another job holds the GPU"))
    with pytest.raises(RuntimeError, match="held by another job"):
        v5.run(Path(prepared["protocol"]), prepared["protocol_sha256"], root=evidence["root"])
    assert lock.exists(), "another job's lock is never removed"
    assert "held by another job" in stage5._read(evidence["campaign"] / "failure.json")["error"]
    assert calls["awake"] == [0x80000001, 0x80000000]
