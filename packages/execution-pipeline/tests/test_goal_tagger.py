"""CPU-only checks of the goal tagger's word handling, labels and decoding (no trained weights)."""
import argparse
import copy
import json
import random
import sys
from pathlib import Path

import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline import goal_tagger as gt  # noqa: E402


def test_words_match_the_pointer_format():
    raw, words = gt.split_words('Advertise "kerbsidetyres.co.uk" in Wigan, £20 a day!')
    assert words == ["Advertise", "kerbsidetyres.co.uk", "in", "Wigan", "£20", "a", "day"]
    assert raw[3] == "Wigan,"
    assert gt.split_words("حملة بالخبر، ٦٠ ريال؟")[1] == ["حملة", "بالخبر", "٦٠", "ريال"]
    assert gt.split_words("go - now")[1] == ["go", "-", "now"]


def test_amounts_and_links():
    assert gt.one_number("£1,250.50") and gt.one_number("١٬٥٠٠٫٥٠") and gt.one_number("£24/day")
    assert not gt.one_number("£20-£40") and not gt.one_number("Wigan") and not gt.one_number("1234567")
    assert gt.URL_WORD.match("https://tidebookshop.co.uk/shop") and gt.URL_WORD.match("linen20.com")
    assert not gt.URL_WORD.match("19.50") and not gt.URL_WORD.match("Wigan")


def test_labels_from_a_pointer_answer():
    labels = gt.parse_pointer("intent create_campaign; url 2; service 4-5@1; locations 7 8@1; amount 9; currency SAR; period week; goal leads", 10)
    assert labels["tags"] == [0, 1, 0, 2, 3, 0, 4, 4, 6, 0]
    assert labels["offsets"][3] == 1 and labels["offsets"][6] == 0 and labels["offsets"][7] == 1 and labels["offsets"][0] == -100
    assert (labels["intent"], gt.CURRENCIES[labels["currency"]], gt.PERIODS[labels["period"]], gt.GOALS[labels["goal"]]) == (1, "SAR", "week", "leads")
    empty = gt.parse_pointer("intent other", 3)
    assert empty["tags"] == [0, 0, 0] and empty["intent"] == 0


def _outputs(count, tags, offsets=None, intent=1, currency=0, period=0, goal=0):
    def one_hot(values, size):
        tensor = torch.full((1, len(values), size), -5.0)
        for index, value in enumerate(values):
            tensor[0, index, value] = 5.0
        return tensor

    def choice(value, size):
        tensor = torch.full((1, size), -5.0)
        tensor[0, value] = 5.0
        return tensor

    return {"tags": one_hot(tags, len(gt.TAGS)), "offsets": one_hot(offsets or [0] * count, 4), "intent": choice(intent, 2),
            "currency": choice(currency, len(gt.CURRENCIES)), "period": choice(period, len(gt.PERIODS)), "goal": choice(goal, len(gt.GOALS))}


def _example(message):
    vocabulary = gt.Vocabulary.build([gt.split_words(message)[1]], minimum=1)
    return gt.encode_sentence(vocabulary, message)


def test_decoding_spells_the_pointer_answer():
    example = _example("ads for pet transport in Reading, Slough and Windsor; budget £35 a day")
    tags = [0, 0, 2, 3, 0, 4, 4, 0, 4, 0, 6, 0, 0]
    answer = gt.decode(example, _outputs(13, tags, currency=1, period=1, goal=2), 0)
    assert answer == "intent create_campaign; service 3-4; locations 6 7 9; amount 11; currency £; period day; goal bookings"


def test_decoding_preserves_six_word_service_and_location():
    example = _example("ads for one two three four five six in north upper old river valley district")
    tags = [0, 0, 2, 3, 3, 3, 3, 3, 0, 4, 5, 5, 5, 5, 5]
    answer = gt.decode(example, _outputs(15, tags), 0)
    assert answer == "intent create_campaign; service 3-8; locations 10-15"


def test_decoding_refuses_impossible_tags():
    example = _example("make ads for Wigan please")
    # A link tag on a plain word and an amount tag on a word without a number are not answers.
    answer = gt.decode(example, _outputs(5, [0, 0, 0, 1, 6], period=1), 0)
    assert answer == "intent create_campaign"
    assert gt.decode(example, _outputs(5, [0, 0, 0, 4, 0], intent=0), 0) == "intent other"


def test_decoding_keeps_a_budget_only_with_its_period_and_reads_arabic_offsets():
    example = _example("حملة بالخبر لخياطة الملابس ٦٠ يوميا")
    tags = [0, 4, 2, 3, 6, 0]
    assert gt.decode(example, _outputs(6, tags, offsets=[0, 1, 1, 0, 0, 0], period=0), 0) == "intent create_campaign; service 3-4@1; locations 2@1"
    assert gt.decode(example, _outputs(6, tags, offsets=[0, 1, 1, 0, 0, 0], period=1), 0).endswith("amount 5; currency none; period day")


def test_confidence_includes_omitted_token_uncertainty_and_ignores_padding():
    example = _example("advertise repairs")
    outputs = _outputs(4, [0, 0, 0, 0])
    certain = gt.confidence_of(example, outputs, 0)
    assert certain > 0.99
    outputs["tags"][0, 2:] = 0  # Padded positions are not part of the request.
    assert gt.confidence_of(example, outputs, 0) == certain
    outputs["tags"][0, 1, gt.TAGS.index("SVC_B")] = 5  # O and service now tie.
    assert gt.decode(example, outputs, 0) == "intent create_campaign"
    assert gt.confidence_of(example, outputs, 0) == pytest.approx(0.5, abs=0.001)


def test_confidence_applies_the_same_impossible_url_and_amount_masks_as_decoding():
    example = _example("advertise repairs")
    outputs = _outputs(2, [0, 0])
    before = gt.confidence_of(example, outputs, 0)
    outputs["tags"][0, :, gt.TAGS.index("URL")] = 30
    outputs["tags"][0, :, gt.TAGS.index("AMT")] = 30
    assert gt.decode(example, outputs, 0) == "intent create_campaign"
    assert gt.confidence_of(example, outputs, 0) == before


@pytest.mark.parametrize("begin", ["SVC_B", "SVC_I", "LOC_B", "LOC_I"])
def test_confidence_includes_arabic_offset_uncertainty_at_each_span_start(begin):
    example = _example("حملة بالدوحة")
    outputs = _outputs(2, [0, gt.TAGS.index(begin)], offsets=[0, 1])
    assert gt.confidence_of(example, outputs, 0) > 0.99
    outputs["offsets"][0, 1, 0] = 5  # The model cannot distinguish the attached prefix.
    assert gt.confidence_of(example, outputs, 0) == pytest.approx(0.5, abs=0.001)


def test_confidence_ignores_unused_offsets_and_fields_but_checks_currency_for_a_budget():
    latin = _example("advertise lamp repairs")
    outputs = _outputs(3, [0, 2, 3])
    outputs["offsets"].fill_(0)
    outputs["currency"].fill_(0)
    assert gt.confidence_of(latin, outputs, 0) > 0.99

    arabic = _example("حملة لإصلاح الأجهزة")
    outputs = _outputs(3, [0, 2, 3], offsets=[0, 1, 0])
    outputs["offsets"][0, 2].fill_(0)  # Continuation-token offsets are not decoded.
    assert gt.confidence_of(arabic, outputs, 0) > 0.99

    budget = _example("advertise £45 daily")
    outputs = _outputs(3, [0, 6, 0], period=1, currency=1)
    outputs["currency"].fill_(0)
    assert gt.confidence_of(budget, outputs, 0) == pytest.approx(1 / len(gt.CURRENCIES))
    outputs["intent"][0] = torch.tensor([5.0, -5.0])
    for name in ("tags", "offsets", "currency", "period", "goal"):
        outputs[name].fill_(0)
    assert gt.decode(budget, outputs, 0) == "intent other"
    assert gt.confidence_of(budget, outputs, 0) > 0.99


def test_training_noise_keeps_labels_and_shapes():
    import random
    message = "create ads for carpet cleaning in Leeds"
    vocabulary = gt.Vocabulary.build([gt.split_words(message)[1]], minimum=1)
    example = gt.encode_sentence(vocabulary, message)
    example.update(gt.parse_pointer("intent create_campaign; service 4-5; locations 7", 7))
    for seed in range(20):
        noisy = gt.augment(vocabulary, example, random.Random(seed))
        assert noisy["tags"] == example["tags"] and len(noisy["ids"]) == 7 and all(len(row) == gt.MAX_CHARS for row in noisy["chars"])
    batch = gt.collate([example, gt.augment(vocabulary, example, random.Random(1))], "cpu")
    model = gt.build_model({"words": len(vocabulary.words), "chars": len(vocabulary.chars), "width": 32, "word_width": 160, "char_width": 64,
                            "heads": 2, "feed_forward": 64, "layers": 1, "dropout": 0.0})
    outputs = model(batch["ids"], batch["chars"], batch["features"], batch["mask"])
    assert outputs["tags"].shape == (2, 7, len(gt.TAGS)) and torch.isfinite(gt.loss_of(outputs, batch))


def test_entity_dropout_hides_whole_arabic_spans_without_changing_characters_or_source():
    message = "أريد حملة لخياطة الملابس في أبو ظبي"
    vocabulary = gt.Vocabulary.build([gt.split_words(message)[1]] * 5, minimum=1)
    example = gt.encode_sentence(vocabulary, message)
    example.update(gt.parse_pointer("intent create_campaign; service 3-4@1; locations 6-7", 7))
    original = copy.deepcopy(example)
    for seed in range(30):
        noisy = gt.augment(vocabulary, example, random.Random(seed), entity_word_dropout=0.65, invented_name_probability=0)
        assert noisy["chars"] == original["chars"]
        assert noisy["features"] == original["features"]
        assert noisy["tags"] == original["tags"] and noisy["offsets"] == original["offsets"]
        for span in ((2, 3), (5, 6)):
            hidden = [noisy["ids"][index][0] == gt.UNK for index in span]
            assert all(hidden) or not any(hidden)
    assert example == original
    noisy = gt.augment(vocabulary, example, random.Random(0), entity_word_dropout=1, invented_name_probability=0)
    for index in (2, 3, 5, 6):
        assert noisy["ids"][index] == [gt.PAD if value == gt.PAD else gt.UNK for value in original["ids"][index]]


def test_balanced_context_and_entity_dropout_masks_word_ids_at_the_same_threshold():
    message = "أريد حملة لخياطة الملابس في أبو ظبي"
    vocabulary = gt.Vocabulary.build([gt.split_words(message)[1]] * 5, minimum=1)
    example = gt.encode_sentence(vocabulary, message)
    example.update(gt.parse_pointer("intent create_campaign; service 3-4@1; locations 6-7", 7))
    original = copy.deepcopy(example)

    class FixedRandom(random.Random):
        def __init__(self, value):
            super().__init__(0)
            self.value = value

        def random(self):
            return self.value

    for value, hidden in ((0.34, True), (0.36, False)):
        noisy = gt.augment(vocabulary, example, FixedRandom(value), entity_word_dropout=0.35,
                           context_word_dropout=0.35, invented_name_probability=0)
        expected_ids = [[gt.PAD if value == gt.PAD else gt.UNK for value in row] for row in original["ids"]] if hidden else original["ids"]
        assert noisy["ids"] == expected_ids
        for key in ("chars", "features", "tags", "offsets"):
            assert noisy[key] == original[key]
    assert example == original


def test_missing_normalization_setting_preserves_legacy_model_outputs():
    settings = {"words": 8, "chars": 2, "width": 16, "word_width": 8, "char_width": 4,
                "heads": 2, "feed_forward": 32, "layers": 1, "dropout": 0.0}
    legacy = gt.build_model(settings).eval()
    explicit = gt.build_model({**settings, "word_variant_normalization": "none"}).eval()
    explicit.load_state_dict(legacy.state_dict(), strict=True)
    ids = torch.tensor([[[2, 3, 4, 5], [6, 0, 0, 0]]])
    chars = torch.zeros((1, 2, gt.MAX_CHARS), dtype=torch.long)
    features = torch.zeros((1, 2, gt.FEATURES))
    mask = torch.ones((1, 2), dtype=torch.bool)
    with torch.no_grad():
        before, after = legacy(ids, chars, features, mask), explicit(ids, chars, features, mask)
    assert all(torch.equal(before[key], after[key]) for key in before)


def test_sqrt_normalization_scales_arabic_variants_and_preserves_single_latin_variant():
    settings = {"words": 8, "chars": 2, "width": 16, "word_width": 8, "char_width": 4,
                "heads": 2, "feed_forward": 32, "layers": 1, "dropout": 0.0, "word_variant_normalization": "sqrt"}
    model = gt.build_model(settings).eval()
    with torch.no_grad():
        model.word.weight.fill_(2)
        model.word.weight[gt.PAD].zero_()
        model.strip.zero_()
    captured = []
    handle = model.join.register_forward_pre_hook(lambda _module, inputs: captured.append(inputs[0].detach().clone()))
    ids = torch.tensor([[[2, 3, 4, 5], [6, 0, 0, 0], [0, 0, 0, 0]]])
    with torch.no_grad():
        model(ids, torch.zeros((1, 3, gt.MAX_CHARS), dtype=torch.long),
              torch.zeros((1, 3, gt.FEATURES)), torch.tensor([[True, True, False]]))
    handle.remove()
    word_vectors = captured[0][0, :, :settings["word_width"]]
    assert torch.equal(word_vectors[0], torch.full((8,), 4.0))
    assert torch.equal(word_vectors[1], torch.full((8,), 2.0))
    assert torch.equal(word_vectors[2], torch.zeros(8))


def test_local_initialization_remaps_embedding_identity_and_preserves_new_vocabulary(tmp_path):
    original = gt.Vocabulary(["<pad>", "<unk>", "repair", "lamp", "retired"], ["<pad>", "<unk>", "a", "ب"])
    vocabulary = gt.Vocabulary(["<pad>", "<unk>", "lamp", "new", "repair"], ["<pad>", "<unk>", "ب", "ج", "a"])
    settings = {"words": len(original.words), "chars": len(original.chars), "width": 16, "word_width": 8,
                "char_width": 4, "heads": 2, "feed_forward": 32, "layers": 1, "dropout": 0.0}
    source = gt.build_model(settings)
    with torch.no_grad():
        for index in range(len(original.words)):
            source.word.weight[index].fill_(index + 10)
        for index in range(len(original.chars)):
            source.char.weight[index].fill_(index + 30)
        source.sentence.fill_(0.73)
    torch.save({"settings": settings, "vocabulary": {"words": original.words, "chars": original.chars}, "model_state": source.state_dict()}, tmp_path / "best.pt")
    checkpoint_hash = gt._sha256(tmp_path / "best.pt")
    target = gt.build_model({**settings, "words": len(vocabulary.words), "chars": len(vocabulary.chars)})
    initial = {name: value.clone() for name, value in target.state_dict().items()}
    result = gt.initialize_from_local(target, vocabulary, tmp_path)
    for layer, current_names, previous_names in (("word", vocabulary.words, original.words), ("char", vocabulary.chars, original.chars)):
        actual, previous = getattr(target, layer).weight, getattr(source, layer).weight
        for index, name in enumerate(current_names):
            expected = previous[previous_names.index(name)] if name in previous_names else initial[f"{layer}.weight"][index]
            assert torch.equal(actual[index], expected), (layer, name)
    for name, value in target.state_dict().items():
        if name not in ("word.weight", "char.weight"):
            assert torch.equal(value, source.state_dict()[name]), name
    assert result["transferredVocabulary"] == {"words": 4, "chars": 4}
    assert result["optimizer"] == "fresh" and result["checkpointSha256"] == checkpoint_hash
    assert gt._sha256(tmp_path / "best.pt") == checkpoint_hash


@pytest.mark.parametrize("change", [{"width": 32}, {"layers": 2}, {"word_width": 12}, {"heads": 4}, {"word_variant_normalization": "sqrt"}])
def test_local_initialization_rejects_incompatible_architecture_before_mutating_model(tmp_path, change):
    vocabulary = gt.Vocabulary(["<pad>", "<unk>", "repair"], ["<pad>", "<unk>", "a"])
    settings = {"words": len(vocabulary.words), "chars": len(vocabulary.chars), "width": 16, "word_width": 8,
                "char_width": 4, "heads": 2, "feed_forward": 32, "layers": 1, "dropout": 0.0}
    source = gt.build_model(settings)
    torch.save({"settings": settings, "vocabulary": {"words": vocabulary.words, "chars": vocabulary.chars}, "model_state": source.state_dict()}, tmp_path / "best.pt")
    target = gt.build_model({**settings, **change})
    initial = {name: value.clone() for name, value in target.state_dict().items()}
    with pytest.raises(ValueError, match="Local checkpoint .* (?:mismatch|does not match|do not match)"):
        gt.initialize_from_local(target, vocabulary, tmp_path)
    assert all(torch.equal(value, initial[name]) for name, value in target.state_dict().items())


def test_early_stopping_retains_best_weakest_language_checkpoint_and_reports_progress(tmp_path, monkeypatch):
    data, out = tmp_path / "data", tmp_path / "run"
    data.mkdir()
    rows = [{"input": {"message": f"hello {index}"}, "language": language, "target": "intent other"}
            for language in ("ar", "en") for index in range(3)]
    for split in ("train", "validation"):
        (data / f"{split}.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    expected = [[True, False, False, True, False, False],
                [True, True, False, True, True, True],
                [True, False, False, True, True, True],
                [True, True, False, True, True, True]]
    calls = []

    def validation_answers(*_):
        # Every completed epoch has a readable progress report before the next validation.
        if calls:
            progress = json.loads((out / "report.json").read_text(encoding="utf-8"))
            assert progress["epochsCompleted"] == len(calls)
            assert progress["status"] == "training"
        correct = expected[len(calls)]
        calls.append(True)
        return ["intent other" if value else "intent create_campaign" for value in correct]

    monkeypatch.setattr(gt, "answer_all", validation_answers)
    args = argparse.Namespace(data=data, out=out, epochs=8, batch=6, lr=0.001, width=16, layers=1, seed=7,
                              device="cpu", dropout=0.15, weight_decay=0.01, entity_word_dropout=0.65,
                              invented_name_probability=0.1, patience=2, context_word_dropout=0.35,
                              word_variant_normalization="sqrt")
    assert gt.train(args) == 0
    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    assert report["status"] == "early_stopped" and report["epochsCompleted"] == 4
    assert report["bestEpoch"] == 2 and report["bestValidationExactMinimum"] == pytest.approx(2 / 3)
    assert report["arguments"]["epochs"] == 8 and report["settings"]["dropout"] == 0.15
    assert report["arguments"]["context_word_dropout"] == 0.35 and report["settings"]["word_variant_normalization"] == "sqrt"
    assert report["checkpointSha256"] == gt._sha256(out / "best.pt")
    _, _, payload = gt.load_model(out, "cpu")
    assert payload["epoch"] == 2


class _RecordingOtherModel:
    def __init__(self):
        self.widths = []

    def eval(self):
        return self

    def __call__(self, ids, chars, features, mask):
        assert ids.shape[0] == 1
        self.widths.append(ids.shape[1])
        return _outputs(ids.shape[1], [0] * ids.shape[1], intent=0)


def test_inference_refuses_long_requests_without_reading_a_truncated_prefix():
    supported = " ".join(["word"] * gt.MAX_WORDS)
    too_long = supported + " stop"
    vocabulary = gt.Vocabulary.build([["word", "stop"]], minimum=1)
    model = _RecordingOtherModel()
    results = gt.answer_all(model, vocabulary, [too_long, supported, ""], "cpu")
    assert results == [None, "intent other", "intent other"]
    assert model.widths == [gt.MAX_WORDS]
    model.widths.clear()
    assert gt.answer_all(model, vocabulary, [too_long], "cpu") == [None]
    assert model.widths == []


def test_confidence_scores_follow_original_order_and_reset_existing_values():
    supported = " ".join(["word"] * gt.MAX_WORDS)
    too_long = supported + " stop"
    vocabulary = gt.Vocabulary.build([["word", "stop"]], minimum=1)
    model = _RecordingOtherModel()
    scores = [999.0]
    answers = gt.answer_all(model, vocabulary, [too_long, supported, ""], "cpu", confidence_scores=scores)
    assert answers == [None, "intent other", "intent other"]
    assert len(scores) == 3 and scores[0] is None and scores[2] == 0
    assert 0.99 < scores[1] <= 1
    assert model.widths == [gt.MAX_WORDS]
    assert gt.answer_all(model, vocabulary, [], "cpu", confidence_scores=scores) == []
    assert scores == []


def test_answer_file_marks_overlong_row_incomplete_and_preserves_other_rows(tmp_path, monkeypatch):
    messages = [" ".join(["word"] * (gt.MAX_WORDS + 1)), "hello"]
    source, output = tmp_path / "input.jsonl", tmp_path / "answers.jsonl"
    source.write_text("".join(json.dumps({"id": str(index), "input": {"message": message}}) + "\n"
                              for index, message in enumerate(messages)), encoding="utf-8")
    vocabulary = gt.Vocabulary.build([["word", "hello"]], minimum=1)
    monkeypatch.setattr(gt, "load_model", lambda *_: (_RecordingOtherModel(), vocabulary, {}))
    monkeypatch.setattr(gt, "_sha256", lambda _: "test-checkpoint")
    args = argparse.Namespace(model=tmp_path, input=source, output=output, device="cpu")
    assert gt.answers(args) == 0
    rows = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
    assert rows[0]["id"] == "0" and rows[0]["finished"] is False and rows[0]["answer_text"] == ""
    assert rows[0]["error"] == "INPUT_TOO_LONG"
    assert rows[0]["error_detail"] == {"words": gt.MAX_WORDS + 1, "maximum_words": gt.MAX_WORDS}
    assert rows[0]["confidence"] is None
    assert rows[0]["confidenceMethod"] == "minimum_decision_probability_v1"
    assert rows[1]["id"] == "1" and rows[1]["finished"] is True and rows[1]["answer_text"] == "intent other"
    assert 0.99 < rows[1]["confidence"] <= 1
    assert rows[1]["confidenceMethod"] == "minimum_decision_probability_v1"
    assert "error" not in rows[1]


def test_answers_never_overwrites_existing_predictions(tmp_path, monkeypatch):
    output = tmp_path / "answers.jsonl"
    original = b'{"existing":true}\n'
    output.write_bytes(original)

    def unexpected_load(*_):
        raise AssertionError("Existing output must be rejected before loading the model")

    monkeypatch.setattr(gt, "load_model", unexpected_load)
    args = argparse.Namespace(model=tmp_path, input=tmp_path / "missing.jsonl", output=output, device="cpu")
    with pytest.raises(SystemExit, match="Refusing to overwrite existing predictions"):
        gt.answers(args)
    assert output.read_bytes() == original


def _presence_settings(enabled=None):
    result = {"words": 5, "chars": 4, "width": 16, "word_width": 8, "char_width": 4,
              "heads": 2, "feed_forward": 32, "layers": 1, "dropout": 0.0,
              "word_variant_normalization": "sqrt"}
    if enabled is not None:
        result["field_presence"] = enabled
    return result


@pytest.mark.parametrize("target,expected", [
    ("intent other", (0, 0)), ("intent create_campaign", (0, 0)),
    ("intent create_campaign; service 2-3@1", (1, 0)),
    ("intent create_campaign; locations 2@1 4", (0, 1)),
    ("intent create_campaign; service 2; locations 4", (1, 1)),
])
def test_optional_presence_labels_follow_pointer_fields(target, expected):
    labels = gt.parse_pointer(target, 4)
    assert tuple(labels[name] for name in gt.PRESENCE_FIELDS) == expected


def test_missing_presence_setting_matches_explicit_false_exactly():
    torch.manual_seed(53)
    implicit = gt.build_model(_presence_settings()).eval()
    torch.manual_seed(53)
    explicit = gt.build_model(_presence_settings(False)).eval()
    assert set(implicit.state_dict()) == set(explicit.state_dict())
    assert not any(name.startswith(gt.PRESENCE_FIELDS) for name in implicit.state_dict())
    ids = torch.tensor([[[2, 0, 0, 0], [3, 0, 0, 0]]])
    args = [ids, torch.zeros((1, 2, gt.MAX_CHARS), dtype=torch.long),
            torch.zeros((1, 2, gt.FEATURES)), torch.ones((1, 2), dtype=torch.bool)]
    with torch.no_grad():
        before, after = implicit(*args), explicit(*args)
    assert set(before) == set(after)
    assert all(torch.equal(before[name], after[name]) for name in before)


def test_optional_presence_gates_only_its_own_spans_and_affects_confidence():
    example = _example("create ads for piano lessons in Durham")
    tags = [0, 0, 0, 2, 3, 0, 4]
    for present, expected in [
        ((1, 1), "intent create_campaign; service 4-5; locations 7"),
        ((0, 1), "intent create_campaign; locations 7"),
        ((1, 0), "intent create_campaign; service 4-5"),
        ((0, 0), "intent create_campaign"),
    ]:
        prediction = _outputs(7, tags)
        for name, decision in zip(gt.PRESENCE_FIELDS, present):
            prediction[name] = torch.tensor([[-5.0, 5.0] if decision else [5.0, -5.0]])
        original_tags = prediction["tags"].clone()
        assert gt.decode(example, prediction, 0) == expected
        assert torch.equal(prediction["tags"], original_tags)
    prediction["locations_present"].fill_(0)
    assert gt.confidence_of(example, prediction, 0) == pytest.approx(0.5)
    prediction["intent"][0] = torch.tensor([5.0, -5.0])
    assert gt.decode(example, prediction, 0) == "intent other"
    assert gt.confidence_of(example, prediction, 0) > 0.99


def test_presence_supervision_collates_and_warmup_unfreezes_shared_gradients():
    message = "ads for lessons in Durham"
    vocabulary = gt.Vocabulary.build([gt.split_words(message)[1]] * 5, minimum=1)
    example = gt.encode_sentence(vocabulary, message)
    example.update(gt.parse_pointer("intent create_campaign; service 3; locations 5", 5))
    batch = gt.collate([example], "cpu")
    assert batch["service_present"].tolist() == [1] and batch["locations_present"].tolist() == [1]
    assert batch["locations_present"].dtype == torch.long
    legacy_example = {key: value for key, value in example.items() if key not in gt.PRESENCE_FIELDS}
    assert gt.collate([legacy_example], "cpu")["locations_present"].tolist() == [1]
    model = gt.build_model({**_presence_settings(True), "words": len(vocabulary.words), "chars": len(vocabulary.chars)})
    assert gt.set_presence_training_stage(model, 0, 1) is True
    assert all(parameter.requires_grad == (name.split('.', 1)[0] in gt.PRESENCE_FIELDS) for name, parameter in model.named_parameters())
    output = model(*[batch[name] for name in ("ids", "chars", "features", "mask")])
    loss = gt.loss_of(output, batch)
    assert torch.isfinite(loss)
    loss.backward()
    assert model.service_present.weight.grad is not None and model.locations_present.weight.grad is not None
    assert model.tag.weight.grad is None and model.word.weight.grad is None
    model.zero_grad(set_to_none=True)
    assert gt.set_presence_training_stage(model, 1, 1) is False
    assert all(parameter.requires_grad for parameter in model.parameters())
    output = model(*[batch[name] for name in ("ids", "chars", "features", "mask")])
    gt.loss_of(output, batch).backward()
    assert model.tag.weight.grad is not None and model.word.weight.grad is not None
    legacy = gt.build_model(_presence_settings())
    assert gt.set_presence_training_stage(legacy, 0, 0) is False
    with pytest.raises(ValueError, match="Presence warmup"):
        gt.set_presence_training_stage(legacy, 0, 1)


def _presence_checkpoint(directory, model, settings):
    vocabulary = gt.Vocabulary(["<pad>", "<unk>", "ads", "lessons", "durham"], ["<pad>", "<unk>", "a", "ب"])
    torch.save({"settings": settings, "vocabulary": {"words": vocabulary.words, "chars": vocabulary.chars},
                "model_state": model.state_dict()}, directory / "best.pt")
    return vocabulary


def test_training_updates_shared_weights_after_presence_warmup(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    rows = [{"input": {"message": "create ads for lessons in Durham"}, "language": language,
             "target": "intent create_campaign; service 4; locations 6"} for language in ("ar", "en")]
    for split in ("train", "validation"):
        (data / f"{split}.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    weights = []
    original_builder = gt.build_model

    def build(settings):
        model = original_builder(settings)
        weights.append(model.tag.weight.detach().clone())
        return model

    def validate(model, *_):
        weights.append(model.tag.weight.detach().clone())
        return [row["target"] for row in rows]

    monkeypatch.setattr(gt, "build_model", build)
    monkeypatch.setattr(gt, "answer_all", validate)
    args = argparse.Namespace(data=data, out=tmp_path / "run", epochs=2, batch=2, lr=0.001,
                              width=16, layers=1, seed=7, device="cpu", field_presence=True,
                              presence_warmup_epochs=1)
    assert gt.train(args) == 0
    assert torch.equal(weights[0], weights[1]), "The shared tagger must remain frozen during warmup"
    assert not torch.equal(weights[1], weights[2]), "Unfreezing must also allow optimizer updates"


def test_legacy_warmstart_initializes_only_new_presence_heads_and_records_them(tmp_path):
    source = gt.build_model(_presence_settings())
    target = gt.build_model(_presence_settings(True))
    vocabulary = _presence_checkpoint(tmp_path, source, _presence_settings())
    initial = {name: value.clone() for name, value in target.state_dict().items()}
    result = gt.initialize_from_local(target, vocabulary, tmp_path)
    new_keys = {f"{name}.{kind}" for name in gt.PRESENCE_FIELDS for kind in ("weight", "bias")}
    assert set(result["newHeadParameters"]) == new_keys
    for name, value in target.state_dict().items():
        assert torch.equal(value, initial[name] if name in new_keys else source.state_dict()[name])
    vocabulary = _presence_checkpoint(tmp_path, target, _presence_settings(True))
    restored, _, _ = gt.load_model(tmp_path, "cpu")
    assert all(torch.equal(value, restored.state_dict()[name]) for name, value in target.state_dict().items())
    assert gt.initialize_from_local(restored, vocabulary, tmp_path)["newHeadParameters"] == []


@pytest.mark.parametrize("problem", ["shared_missing", "partial_presence", "presence_to_legacy", "false_metadata"])
def test_presence_warmstart_does_not_hide_corruption_or_drop_learned_heads(tmp_path, problem):
    source_settings = _presence_settings(problem != "shared_missing")
    source = gt.build_model(source_settings)
    vocabulary = _presence_checkpoint(tmp_path, source, source_settings)
    payload = torch.load(tmp_path / "best.pt", map_location="cpu", weights_only=True)
    if problem == "shared_missing":
        del payload["model_state"]["tag.bias"]
    if problem == "partial_presence":
        del payload["model_state"]["locations_present.bias"]
    if problem == "false_metadata":
        payload["settings"]["field_presence"] = False
    torch.save(payload, tmp_path / "best.pt")
    target = gt.build_model(_presence_settings(problem != "presence_to_legacy"))
    initial = {name: value.clone() for name, value in target.state_dict().items()}
    with pytest.raises(ValueError, match="Local checkpoint"):
        gt.initialize_from_local(target, vocabulary, tmp_path)
    assert all(torch.equal(value, initial[name]) for name, value in target.state_dict().items())
