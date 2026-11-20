"""Lightweight CPU gate/immutability tests; the trainer and GPU are mocked."""
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline import stage5_finetune as stage5


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def pin(path):
    return {"path": str(path), "sha256": stage5.sha256(path)}


@pytest.fixture
def evidence(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    root.mkdir()
    for name in stage5.CODE_PATHS:
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("# fixture source; no model code loaded\n", encoding="utf-8")
    frozen = root / stage5.FROZEN_PROBE_MANIFEST
    write(frozen, {"frozen": True})
    monkeypatch.setattr(stage5, "FROZEN_PROBE_MANIFEST_SHA256", stage5.sha256(frozen))
    run = root / "run"
    (run / "adapted").mkdir(parents=True)
    (run / "adapted/best.pt").write_bytes(b"adapted checkpoint fixture")
    write(run / "adapted/settings.json", {"prompt_hint": None})
    write(run / "tokenizer.json", {})
    write(run / "tokenizer-report.json", {})
    data = root / "data"
    data.mkdir()
    # Row bytes are never parsed by these metadata validators.
    (data / "train.jsonl").write_bytes(b"opaque train fixture bytes\n")
    (data / "validation.jsonl").write_bytes(b"opaque validation fixture bytes\n")
    files = {f"{name}.jsonl": {"sha256": stage5.sha256(data / f"{name}.jsonl")}
             for name in ("train", "validation")}
    manifest = {"source": "fixture-source", "files": files,
                "tokenizer_sha256": stage5.sha256(run / "tokenizer.json"),
                "inference_format": "execution_pipeline.chat.conversation_prompt(messages)",
                "counts": {lang: {"train": {"rows": 20_000, "multi_turn": 6_000},
                                  "validation": {"rows": 1_000, "multi_turn": 300}}
                           for lang in ("ar", "en")}}
    write(data / "manifest.json", manifest)
    reports = root / "reports"
    qa = reports / "qa.json"
    write(qa, {"semantic_quality_passed": True, "independent_review": True, "files": files,
               "reviews": [{"language": lang, "source": "fixture-source", "sample_size": 200,
                            "wrong_or_unnatural": 0, "passed": True} for lang in ("ar", "en")]})
    carrier, split = reports / "carrier.json", reports / "split.json"
    write(carrier, {"passed": True, "files": files,
                    "counts": {lang: {"rows": 21_000, "peak_carrier_rows": 105, "peak_carrier_fraction": 0.005}
                               for lang in ("ar", "en")}})
    write(split, {"passed": True, "files": files, "group_overlap_train_validation": 0,
                  "exact_normalized_prompt_target_duplicates": 0})
    eligibility = reports / "eligibility.json"
    write(eligibility, {"eligible_for_training": True, "semantic_quality_passed": True,
                       "dataset_manifest_sha256": stage5.sha256(data / "manifest.json"),
                       "dataset_sha256": {name: files[f"{name}.jsonl"]["sha256"] for name in ("train", "validation")},
                       "qa": [pin(qa)], "carrier_audit": pin(carrier), "split_audit": pin(split)})
    predictions = reports / "predictions.jsonl"
    predictions.write_bytes(b"opaque original prediction fixture bytes\n")
    foundation_sha = "a" * 64
    generation = reports / "generation.json"
    write(generation, {"checkpoint_sha256": foundation_sha, "input": {"sha256": stage5.FROZEN_PROBES_SHA256},
                       "scheduled": {"total": 40, "ar": 20, "en": 20},
                       "generated": {"total": 40, "ar": 20, "en": 20},
                       "finished": {"total": 40, "ar": 20, "en": 20},
                       "decoding": {"method": "greedy_argmax", "max_new_tokens": 192, "raw_prompt": True},
                       "predictions": pin(predictions)})
    gate3 = reports / "gate3.json"
    write(gate3, {"gate3_passed": True, "candidate_checkpoint_sha256": foundation_sha,
                  "frozen_probe_manifest_sha256": stage5.FROZEN_PROBE_MANIFEST_SHA256,
                  "results": {lang: {"passed": 16, "total": 20} for lang in ("ar", "en")},
                  "generation_manifest": pin(generation)})
    gate4 = reports / "gate4.json"
    write(gate4, {"gate4_passed": True, "base_checkpoint_sha256": foundation_sha,
                  "candidate_checkpoint_sha256": stage5.sha256(run / "adapted/best.pt"),
                  "validation_sha256": files["validation.jsonl"]["sha256"],
                  "answer_loss_before": {"ar": 4.0, "en": 6.0, "macro": 5.0},
                  "answer_loss_after": {"ar": 3.0, "en": 5.0, "macro": 4.0}})
    kwargs = {"run": run, "base_checkpoint": Path("adapted/best.pt"),
              "base_sha256": stage5.sha256(run / "adapted/best.pt"), "out_name": "sft",
              "campaign": root / "campaign", "dataset_dir": data,
              "gate3": gate3, "gate3_sha256": stage5.sha256(gate3),
              "gate4": gate4, "gate4_sha256": stage5.sha256(gate4),
              "eligibility": eligibility, "eligibility_sha256": stage5.sha256(eligibility),
              "qa": [(qa, stage5.sha256(qa))], "root": root}
    return kwargs, {"qa": qa, "carrier": carrier, "split": split, "generation": generation,
                    "predictions": predictions, "manifest": data / "manifest.json"}


def refresh(kwargs, key, transform):
    value = stage5._read(kwargs[key])
    transform(value)
    write(kwargs[key], value)
    kwargs[f"{key}_sha256"] = stage5.sha256(kwargs[key])


def refresh_audit(kwargs, reports, kind, transform):
    path = reports[kind]
    report = stage5._read(path)
    transform(report)
    write(path, report)
    refresh(kwargs, "eligibility", lambda receipt: receipt.update({f"{kind}_audit": pin(path)}))


def test_cpu_prepare_check_and_shared_validators_load_no_gpu_or_model(evidence, monkeypatch):
    kwargs, _ = evidence
    monkeypatch.setattr(stage5, "GpuJob", lambda *args, **kw: pytest.fail("preflight must not inspect GPU"))
    monkeypatch.setattr(stage5, "finetune", lambda *args, **kw: pytest.fail("preflight must not load a model"))
    prepared = stage5.prepare(**kwargs)
    protocol = stage5.check(Path(prepared["protocol"]), prepared["protocol_sha256"], root=kwargs["root"])
    assert protocol["parameters"] == stage5.PARAMETERS
    assert protocol["parameters"]["preserve_evaluations"] is False
    assert protocol["parameters"]["batch"] * protocol["parameters"]["accumulation"] == 16
    assert not (kwargs["run"] / "sft").exists()
    eligibility = stage5.verify_eligibility(kwargs["eligibility"], kwargs["eligibility_sha256"], protocol["qa"],
                                            dataset_dir=kwargs["dataset_dir"], root=kwargs["root"])
    assert eligibility["data_dir"] == kwargs["dataset_dir"]
    assert stage5.verify_gate3(kwargs["gate3"], kwargs["gate3_sha256"], root=kwargs["root"])["gate3"]["gate3_passed"] is True


@pytest.mark.parametrize("change", [lambda gate: gate.update(gate3_passed=False),
                                   lambda gate: gate.update(results={}),
                                   lambda gate: gate["results"]["ar"].update(passed=15),
                                   lambda gate: gate.update(frozen_probe_manifest_sha256="0" * 64)])
def test_boolean_or_incomplete_gate3_cannot_unlock_training(evidence, change):
    kwargs, _ = evidence
    refresh(kwargs, "gate3", change)
    with pytest.raises(ValueError, match="Gate 3"):
        stage5.prepare(**kwargs)
    assert not kwargs["campaign"].exists()


def test_gate3_pass_count_cannot_exceed_finished_eos_outputs(evidence):
    kwargs, reports = evidence
    generation = stage5._read(reports["generation"])
    generation["finished"]["ar"] = 15
    write(reports["generation"], generation)
    refresh(kwargs, "gate3", lambda gate: gate.update(generation_manifest=pin(reports["generation"])))
    with pytest.raises(ValueError, match="EOS-finished"):
        stage5.prepare(**kwargs)


@pytest.mark.parametrize("change", [lambda gate: gate.update(gate4_passed=False),
                                   lambda gate: gate.update(candidate_checkpoint_sha256="0" * 64),
                                   lambda gate: gate.update(validation_sha256="0" * 64),
                                   lambda gate: gate.update(answer_loss_after={"ar": 4.0, "en": 6.0, "macro": 5.0}),
                                   lambda gate: gate.update(answer_loss_after={"ar": float("nan"), "en": 5.0, "macro": 4.0})])
def test_gate4_must_bind_exact_adapted_base_validation_and_finite_improvement(evidence, change):
    kwargs, _ = evidence
    refresh(kwargs, "gate4", change)
    with pytest.raises(ValueError, match="Stage 4"):
        stage5.prepare(**kwargs)


def test_gate4_uses_declared_macro_objective_instead_of_inventing_per_language_decline_rule(evidence):
    kwargs, _ = evidence
    refresh(kwargs, "gate4", lambda gate: gate.update(answer_loss_after={"ar": 4.1, "en": 3.9, "macro": 4.0}))
    assert stage5.prepare(**kwargs)["status"] == "prepared"


def test_final_data_eligibility_is_required_even_if_all_other_gates_pass(evidence):
    kwargs, _ = evidence
    refresh(kwargs, "eligibility", lambda receipt: receipt.update(eligible_for_training=False))
    with pytest.raises(ValueError, match="Final dataset eligibility"):
        stage5.prepare(**kwargs)


def test_eligible_dataset_audited_with_another_tokenizer_is_refused_before_gpu(evidence, monkeypatch):
    kwargs, reports = evidence
    manifest = stage5._read(reports["manifest"])
    manifest["tokenizer_sha256"] = "0" * 64
    write(reports["manifest"], manifest)
    refresh(kwargs, "eligibility", lambda receipt: receipt.update(dataset_manifest_sha256=stage5.sha256(reports["manifest"])))
    monkeypatch.setattr(stage5, "GpuJob", lambda *args, **kw: pytest.fail("mismatched tokenizer must not acquire GPU"))
    with pytest.raises(ValueError, match="different tokenizer SHA-256"):
        stage5.prepare(**kwargs)
    assert not kwargs["campaign"].exists()


@pytest.mark.parametrize("kind,change", [
    ("carrier", lambda report: report["counts"]["ar"].update(peak_carrier_rows=210, peak_carrier_fraction=0.01)),
    ("carrier", lambda report: report.update(counts={})),
    ("split", lambda report: report.update(group_overlap_train_validation=1)),
    ("split", lambda report: report.update(passed=False)),
])
def test_true_carrier_and_split_evidence_cannot_be_replaced_by_passed_booleans(evidence, kind, change):
    kwargs, reports = evidence
    refresh_audit(kwargs, reports, kind, change)
    with pytest.raises(ValueError, match="carrier|split|overlapping"):
        stage5.prepare(**kwargs)


@pytest.mark.parametrize("change", [lambda qa: qa.update(independent_review=False),
                                   lambda qa: qa["reviews"][0].update(sample_size=199),
                                   lambda qa: qa["reviews"][0].update(wrong_or_unnatural=7),
                                   lambda qa: qa.update(reviews=qa["reviews"][:1])])
def test_independent_semantic_qa_requires_every_source_language_200_reads_and_max_three_percent_bad(evidence, change):
    kwargs, reports = evidence
    report = stage5._read(reports["qa"])
    change(report)
    write(reports["qa"], report)
    kwargs["qa"] = [(reports["qa"], stage5.sha256(reports["qa"]))]
    refresh(kwargs, "eligibility", lambda receipt: receipt.update(qa=[pin(reports["qa"])]))
    with pytest.raises(ValueError, match="QA"):
        stage5.prepare(**kwargs)


@pytest.mark.parametrize("asset", ["checkpoint", "dataset", "code", "qa", "tokenizer"])
def test_changed_pinned_assets_refuse_run_before_gpu_acquisition(evidence, monkeypatch, asset):
    kwargs, reports = evidence
    prepared = stage5.prepare(**kwargs)
    target = {"checkpoint": kwargs["run"] / "adapted/best.pt", "dataset": kwargs["dataset_dir"] / "validation.jsonl",
              "code": kwargs["root"] / stage5.CODE_PATHS[0], "qa": reports["qa"],
              "tokenizer": kwargs["run"] / "tokenizer.json"}[asset]
    target.write_bytes(b"changed pinned bytes")
    monkeypatch.setattr(stage5, "GpuJob", lambda *args, **kw: pytest.fail("changed pins must fail before GPU"))
    with pytest.raises(ValueError, match="Pinned evidence changed"):
        stage5.run(Path(prepared["protocol"]), prepared["protocol_sha256"], root=kwargs["root"])
    assert not (kwargs["campaign"] / "started.json").exists()


def fake_runtime(monkeypatch):
    calls = {"awake": [], "training": []}
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
            calls["training"].append(name)
        def record_training_update(self, positions, elapsed):
            calls["update"] = (positions, elapsed)
    monkeypatch.setattr(stage5, "GpuJob", Guard)
    monkeypatch.setattr(stage5, "_cuda_start", lambda guard: guard.start_monitor())
    monkeypatch.setattr(stage5, "_awake", lambda flags: calls["awake"].append(flags) or 1)
    return calls


def test_mocked_training_uses_fixed_gate0_configuration_hooks_and_selects_best_not_last(evidence, monkeypatch):
    kwargs, _ = evidence
    prepared = stage5.prepare(**kwargs)
    calls = fake_runtime(monkeypatch)
    def trainer(run, **arguments):
        calls["trainer"] = arguments
        assert {name: arguments[name] for name in stage5.PARAMETERS} == stage5.PARAMETERS
        arguments["progress_check"]()
        arguments["training_update"](100, 0.1)
        output = run / arguments["out_name"]
        output.mkdir()
        (output / "best.pt").write_bytes(b"best validation weights")
        (output / "last.pt").write_bytes(b"last weights with worse validation")
        write(output / "settings.json", {"fixture": True})
        result = {"status": "early_stopped", "best_step": 100, "steps": 700,
                  "best_checkpoint_sha256": stage5.sha256(output / "best.pt"),
                  "last_checkpoint_sha256": stage5.sha256(output / "last.pt"),
                  "validation_selection_metric": "macro_language_answer_loss", "best_validation_metrics": {"macro_language_answer_loss": 2.0}}
        write(output / "status.json", result)
        return result
    monkeypatch.setattr(stage5, "finetune", trainer)
    selected = stage5.run(Path(prepared["protocol"]), prepared["protocol_sha256"], root=kwargs["root"])
    assert selected["selected_checkpoint"]["sha256"] == stage5.sha256(kwargs["run"] / "sft/best.pt")
    assert selected["selected_checkpoint"]["sha256"] != stage5.sha256(kwargs["run"] / "sft/last.pt")
    assert selected["gate5_passed"] is None and selected["ready_for_chat"] is False
    assert calls["trainer"]["base_checkpoint"] == Path("adapted/best.pt")
    assert calls["monitored"] and calls["released"] and calls["update"] == (100, 0.1)
    assert calls["guard_kwargs"]["max_seconds"] == 4 * 3600
    assert calls["awake"] == [0x80000001, 0x80000000]
    with pytest.raises(FileExistsError, match="never overwrite"):
        stage5.run(Path(prepared["protocol"]), prepared["protocol_sha256"], root=kwargs["root"])


def test_runtime_failure_preserves_attempt_receipt_releases_guard_and_restores_sleep(evidence, monkeypatch):
    kwargs, _ = evidence
    prepared = stage5.prepare(**kwargs)
    calls = fake_runtime(monkeypatch)
    def fail(*args, **kw):
        raise RuntimeError("simulated monitored stop")
    monkeypatch.setattr(stage5, "finetune", fail)
    with pytest.raises(RuntimeError, match="monitored stop"):
        stage5.run(Path(prepared["protocol"]), prepared["protocol_sha256"], root=kwargs["root"])
    assert calls["released"] and calls["awake"] == [0x80000001, 0x80000000]
    assert "simulated monitored stop" in stage5._read(kwargs["campaign"] / "failure.json")["error"]
    assert not (kwargs["campaign"] / "selection.json").exists()


def test_holdout_path_is_refused_without_opening_or_listing_it(evidence, monkeypatch):
    kwargs, _ = evidence
    sealed = kwargs["root"] / "artifacts/chat-training/conversation-v1/holdout/cases.jsonl"
    monkeypatch.setattr(stage5, "sha256", lambda path: pytest.fail("sealed path must be rejected before opening"))
    with pytest.raises(ValueError, match="sealed"):
        stage5._pin(sealed, kwargs["root"])
