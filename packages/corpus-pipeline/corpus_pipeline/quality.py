"""Measure document quality and validate dialogue turn structure."""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from .normalization import TOKEN_PATTERN, match_key, normalize_text

VERSION = 1
DEFAULT_END_MARKER = "<|eos|>"
_NON_ALPHANUMERIC = re.compile(r"[^\w\s]|_")
_DIGITS = re.compile(r"\d")

_BOILERPLATE_LINES = {
    "ar": (
        "الرئيسية",
        "الصفحة الرئيسية",
        "من نحن",
        "اتصل بنا",
        "تواصل معنا",
        "سياسة الخصوصية",
        "سياسة ملفات تعريف الارتباط",
        "قبول جميع ملفات تعريف الارتباط",
        "إعدادات ملفات تعريف الارتباط",
        "تخطي إلى المحتوى",
        "الرئيسية من نحن اتصل بنا",
    ),
    "en": (
        "home",
        "about us",
        "contact us",
        "privacy policy",
        "cookie policy",
        "accept all cookies",
        "reject all cookies",
        "cookie settings",
        "skip to content",
        "home about us contact us",
    ),
}
_COOKIE_PREFIXES = {
    "ar": (
        "نستخدم ملفات تعريف الارتباط",
        "يستخدم هذا الموقع ملفات تعريف الارتباط",
        "هذا الموقع يستخدم ملفات تعريف الارتباط",
    ),
    "en": ("we use cookies", "this website uses cookies", "our website uses cookies"),
}
_BOILERPLATE_KEYS = {
    language: frozenset(match_key(line).casefold() for line in lines)
    for language, lines in _BOILERPLATE_LINES.items()
}
_COOKIE_PREFIX_KEYS = {
    language: tuple(match_key(prefix).casefold() for prefix in prefixes)
    for language, prefixes in _COOKIE_PREFIXES.items()
}


@dataclass(frozen=True)
class QualityConfig:
    repetition_ngram_size: int = 3
    min_repetition_ngrams: int = 4
    max_top_ngram_share: float = 0.25
    max_repeated_line_share: float = 0.35
    max_symbol_ratio: float = 0.30
    max_digit_ratio: float = 0.35
    short_line_min_tokens: int = 4
    max_short_line_share: float = 0.75
    min_short_line_count: int = 3

    def __post_init__(self) -> None:
        for name in (
            "repetition_ngram_size",
            "min_repetition_ngrams",
            "short_line_min_tokens",
            "min_short_line_count",
        ):
            value = getattr(self, name)
            if type(value) is not int or value < 1:
                raise ValueError(f"{name} must be a positive integer.")
        for name in (
            "max_top_ngram_share",
            "max_repeated_line_share",
            "max_symbol_ratio",
            "max_digit_ratio",
            "max_short_line_share",
        ):
            value = getattr(self, name)
            if type(value) not in (int, float) or not 0 <= value <= 1:
                raise ValueError(f"{name} must be a number between 0 and 1.")


def quality_reasons(text: str, config: QualityConfig) -> list[str]:
    lines = [key for line in text.splitlines() if (key := match_key(line).casefold())]
    if not lines:
        return ["empty_text"]

    reasons = []
    line_tokens = [TOKEN_PATTERN.findall(line) for line in lines]
    tokens = [token for group in line_tokens for token in group]
    width = config.repetition_ngram_size
    window_count = len(tokens) - width + 1
    if window_count >= config.min_repetition_ngrams:
        counts = Counter(tuple(tokens[start : start + width]) for start in range(window_count))
        top_count = max(counts.values())
        if top_count > 1 and top_count / window_count > config.max_top_ngram_share:
            reasons.append("top_ngram_repetition")

    if (len(lines) - len(set(lines))) / len(lines) > config.max_repeated_line_share:
        reasons.append("repeated_lines")

    folded = " ".join(lines)
    non_spaces = len(folded) - folded.count(" ")
    if len(_NON_ALPHANUMERIC.findall(folded)) / non_spaces > config.max_symbol_ratio:
        reasons.append("symbol_ratio")
    if len(_DIGITS.findall(folded)) / non_spaces > config.max_digit_ratio:
        reasons.append("digit_ratio")

    if len(lines) >= config.min_short_line_count:
        short_lines = sum(len(group) < config.short_line_min_tokens for group in line_tokens)
        if short_lines / len(lines) > config.max_short_line_share:
            reasons.append("short_lines")

    token_lines = [" ".join(group) for group in line_tokens]
    for language, entries in _BOILERPLATE_KEYS.items():
        prefixes = _COOKIE_PREFIX_KEYS[language]
        if any(
            line in entries or any(line == prefix or line.startswith(prefix + " ") for prefix in prefixes)
            for line in token_lines
        ):
            reasons.append(f"boilerplate_{language}")
    return reasons


def dialogue_reasons(turns: object, end_marker: str = DEFAULT_END_MARKER) -> list[str]:
    if not isinstance(turns, Sequence) or isinstance(turns, (str, bytes)) or not turns:
        return ["dialogue_turn_order"]
    reasons: set[str] = set()
    if len(turns) % 2:
        reasons.add("dialogue_turn_order")
    for i, turn in enumerate(turns):
        expected = "assistant" if i % 2 else "user"
        if not isinstance(turn, Mapping) or turn.get("role") != expected:
            reasons.add("dialogue_turn_order")
            continue
        content = turn.get("content")
        if not isinstance(content, str):
            reasons.add("dialogue_empty_turn")
            continue
        content = normalize_text(content)
        if expected == "assistant":
            if not content.endswith(end_marker):
                reasons.add("dialogue_missing_end_marker")
            content = content.removesuffix(end_marker)
        if end_marker in content:
            reasons.add("dialogue_unexpected_end_marker")
        if not content.strip():
            reasons.add("dialogue_empty_turn")
    return sorted(reasons)
