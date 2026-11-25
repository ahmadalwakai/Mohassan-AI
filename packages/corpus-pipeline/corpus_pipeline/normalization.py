"""Preserve readable text and derive a canonical representation for matching."""

from __future__ import annotations

import re
import unicodedata

VERSION = 1

# Invisible formatting controls, including the Unicode Bidi_Control property.
_REMOVED_CHARACTERS = (
    "\u00ad\u034f\u061c\u0640\u180e"
    "\u200b\u200c\u200d\u200e\u200f"
    "\u202a\u202b\u202c\u202d\u202e"
    "\u2060\u2061\u2062\u2063\u2064\u2066\u2067\u2068\u2069"
    "\u206a\u206b\u206c\u206d\u206e\u206f\ufeff"
)
_STORED_TRANSLATION = str.maketrans("", "", _REMOVED_CHARACTERS)
_MATCH_TRANSLATION = str.maketrans(
    "آأإٱٲٳةى٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹",
    "ااااااهي01234567890123456789",
)
TOKEN_PATTERN = re.compile(r"[^\W_]+")


def normalize_text(text: str) -> str:
    return unicodedata.normalize("NFKC", text).translate(_STORED_TRANSLATION)


def match_key(text: str) -> str:
    folded = normalize_text(text).translate(_MATCH_TRANSLATION)
    if not folded.isascii():
        # NFKC expands the high-hamza alef (U+0675) to this two-letter sequence.
        decomposed = unicodedata.normalize("NFD", folded.replace("اٴ", "ا"))
        folded = unicodedata.normalize(
            "NFC",
            "".join(char for char in decomposed if not unicodedata.category(char).startswith("M")),
        )
    return " ".join(folded.split())


def match_tokens(text_or_key: str) -> list[str]:
    return TOKEN_PATTERN.findall(match_key(text_or_key))
