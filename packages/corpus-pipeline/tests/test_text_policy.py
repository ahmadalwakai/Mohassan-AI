import pytest

from corpus_pipeline.language import LanguageModel, paragraphs
from corpus_pipeline.normalization import match_key, match_tokens, normalize_text
from corpus_pipeline.quality import DEFAULT_END_MARKER, QualityConfig, dialogue_reasons, quality_reasons


def test_storage_keeps_marks_and_arabic_letters_while_match_keys_fold_them():
    raw = "Ａ\u200b\u200c\u200d\u061c\u200e\u200f\u202e\u2067\u2069\ufeff أَهْــلًا\tإِلَى ٱلْمَدْرَسَةِ ١٢۳"
    stored = normalize_text(raw)
    assert stored == "A أَهْلًا\tإِلَى ٱلْمَدْرَسَةِ ١٢۳"
    assert match_key(raw) == "A اهلا الي المدرسه 123"
    assert match_tokens(raw + " room_٤!") == ["A", "اهلا", "الي", "المدرسه", "123", "room", "4"]
    assert match_key(match_key(raw)) == match_key(raw)
    assert match_key("ٵٲٳآأإٱ") == "ااااااا"


def test_language_is_fitted_from_examples_and_reports_labeled_development_predictions():
    model = LanguageModel.train(
        [
            ("ar", "عاد الصياد إلى الميناء بعد أن هدأت الرياح"),
            ("ar", "يتعلم الأطفال القراءة في المكتبة كل أسبوع"),
            ("en", "We used the oldest map to find the cottage in the woods"),
            ("en", "Take the second turn after the bridge and look for the garden"),
        ]
    )
    ar = "ذهبت الأسرة إلى الحديقة وجلبت بعض الكتب"
    en = "The garden has a path leading to the cottage"
    blocks = list(paragraphs(f"{ar}\nفي النهار\r\n \t\r\n{en}\u2029Another paragraph."))
    assert blocks == [f"{ar}\nفي النهار", en, "Another paragraph."]
    assert [model.predict(block) for block in blocks] == ["ar", "en", "en"]
    assert model.confusion([("ar", ar), ("en", en), ("ar", en)]) == {
        "labels": ["ar", "en"],
        "matrix": {"ar": {"ar": 1, "en": 1}, "en": {"ar": 0, "en": 1}},
        "total": 3,
        "correct": 2,
    }


def test_language_model_rejects_missing_training_features_or_development_label():
    with pytest.raises(ValueError, match="labeled text with letters"):
        LanguageModel.train([("en", "12 ___ !")])
    model = LanguageModel.train([("en", "A short sentence with words.")])
    with pytest.raises(ValueError, match="missing from training"):
        model.confusion([("ar", "نص عربي")])


@pytest.mark.parametrize(
    ("text", "reason"),
    [
        ("keep this phrase keep this phrase keep this phrase", "top_ngram_repetition"),
        ("تعود الأمواج نحو الشاطئ تعود الأمواج نحو الشاطئ تعود الأمواج نحو الشاطئ", "top_ngram_repetition"),
        ("الـمَطَر فوق الحقول\nالمطر فوق الحقول", "repeated_lines"),
        ("#$$%!!rain", "symbol_ratio"),
        ("١٢۳۴۵۶۷۸٩ ص", "digit_ratio"),
        ("first entry\nsecond note\nthird heading", "short_lines"),
        ("Home | About us | Contact us", "boilerplate_en"),
        ("«إِعْدَادَاتُ مَلَفَّاتِ تَعْرِيفِ الارتباط»", "boilerplate_ar"),
        ("This website uses cookies to measure visits", "boilerplate_en"),
        ("نستخدم ملفات تعريف الارتباط لتحسين الخدمة", "boilerplate_ar"),
        ("\u200b \n\n", "empty_text"),
    ],
)
def test_quality_reasons(text, reason):
    assert reason in quality_reasons(text, QualityConfig())


def test_nonboilerplate_use_of_navigation_words_is_kept():
    text = "Her journey home took longer since the bridge was closed."
    assert quality_reasons(text, QualityConfig()) == []


def test_quality_config_rejects_invalid_window_and_ratio():
    with pytest.raises(ValueError, match="repetition_ngram_size"):
        QualityConfig(repetition_ngram_size=True)
    with pytest.raises(ValueError, match="max_digit_ratio"):
        QualityConfig(max_digit_ratio=float("nan"))


def test_dialogue_requires_complete_alternating_pairs_with_terminal_marker():
    turns = [
        {"role": "user", "content": "Where is the library?"},
        {"role": "assistant", "content": f"Beside the park.{DEFAULT_END_MARKER}"},
        {"role": "user", "content": "ومتى تفتح؟"},
        {"role": "assistant", "content": f"تفتح صباح الاثنين.{DEFAULT_END_MARKER}"},
    ]
    assert dialogue_reasons(turns) == []
    assert dialogue_reasons(turns[:-1]) == ["dialogue_turn_order"]
    assert dialogue_reasons([turns[1], turns[0]]) == ["dialogue_turn_order"]
    bad_turn = {"role": "assistant", "content": "The library is beside the park."}
    assert dialogue_reasons([turns[0], bad_turn]) == ["dialogue_missing_end_marker"]
    empty_turn = {"role": "assistant", "content": DEFAULT_END_MARKER}
    assert dialogue_reasons([turns[0], empty_turn]) == ["dialogue_empty_turn"]
    early_end = {"role": "assistant", "content": f"{DEFAULT_END_MARKER}Too early.{DEFAULT_END_MARKER}"}
    assert dialogue_reasons([turns[0], early_end]) == ["dialogue_unexpected_end_marker"]
    custom_end = {"role": "assistant", "content": "Beside the park.[END]"}
    assert dialogue_reasons([turns[0], custom_end], "[END]") == []
