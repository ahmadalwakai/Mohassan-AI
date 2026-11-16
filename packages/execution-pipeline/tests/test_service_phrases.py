"""Checks for boundary and provenance failures in local-corpus phrase extraction."""
import hashlib
import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("service_phrases", ROOT / "scripts/ads-training/extract_service_phrases.py")
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)


def phrases(line, language):
    results = list(extractor.extract_line(line, language))
    assert all(line[start:end] == text for text, start, end in results)
    return [text for text, _, _ in results]


def test_english_offering_boundaries_and_business_modifiers():
    assert phrases("We provide expert garden machinery repair for local residents.", "en") == ["garden machinery repair"]
    assert phrases("We specialise in acoustic panel installation and painting.", "en") == ["acoustic panel installation"]
    assert phrases("Our services include musical instrument restoration, at our premises.", "en") == ["musical instrument restoration"]


def test_arabic_offering_boundaries():
    assert phrases("نقدم خدمات صيانة آلات التصوير بأعلى معايير الجودة.", "ar") == ["خدمات صيانة آلات التصوير"]
    assert phrases("شركة متخصصة في تركيب نوافذ خشبية، مع ضمان.", "ar") == ["تركيب نوافذ خشبية"]
    assert phrases("نوفر خدمات الحراسة الأمنية المتكاملة للشركات.", "ar") == ["خدمات الحراسة الأمنية"]


def test_rejects_clauses_boilerplate_names_and_personal_information():
    for line in ("We offer all the help you need.", "We provide services for everyone.",
                 "We provide contact email support.", "We offer John Smith services.",
                 "We offer repairs contact@example.com.", "We provide FREE BEST SERVICES."):
        assert not phrases(line, "en")
    for line in ("نقدم خدمات عامة.", "نقدم خدمات محمد بن علي.", "نقدم خدمات عالية الجودة.",
                 "نوفر خدمات الاتصال على 0551234567."):
        assert not phrases(line, "ar")


def test_overlength_phrases_are_rejected_instead_of_truncated():
    assert not phrases("We offer large green wooden garden door frame installation.", "en")
    assert not phrases("We offer estimated delivery windows.", "en")
    assert phrases("We offer replacement sash windows.", "en") == ["replacement sash windows"]


def test_file_deduplicates_and_records_exact_evidence(tmp_path):
    source = tmp_path / "en.txt"
    line = "We provide custom furniture restoration for museums."
    source.write_text(line + "\n" + line + "\n", encoding="utf-8")
    rows, summary = extractor.extract_file(source, "en")
    assert len(rows) == 1 and rows[0]["occurrences"] == 2
    evidence = rows[0]["provenance"]
    assert evidence["line"] == 1 and line[evidence["start"]:evidence["end"]] == rows[0]["text"]
    assert evidence["lineSha256"] == hashlib.sha256(line.encode()).hexdigest()
    assert summary["sha256"] == hashlib.sha256(source.read_bytes()).hexdigest()
    assert rows == extractor.extract_file(source, "en")[0]
