"""Character set, text normalisation and the shared visual-order (bidi) rules.

The reader in packages/vision/src/bidi.ts mirrors `to_visual`/`to_logical` exactly.
Both sides are checked against the parity fixtures the export writes, so the
labels the model learns and the text the server reconstructs always agree.
"""
from __future__ import annotations

import unicodedata

ARABIC_LETTERS = "ءآأؤإئابةتثجحخدذرزسشصضطظعغفقكلمنهوىي"
ARABIC_EXTRA = "پچژگڤ"
ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩"
ARABIC_PUNCT = "،؛؟٪"
ASCII = "".join(chr(c) for c in range(0x21, 0x7F))
SPECIAL = "«»©®°±×÷–—‘’“”…•€£¥§¢→←✓★"
CHARS = " " + ASCII + ARABIC_LETTERS + ARABIC_EXTRA + ARABIC_DIGITS + ARABIC_PUNCT + SPECIAL
assert len(set(CHARS)) == len(CHARS)
# Index 0 is the CTC blank; every other class is one character.
CLASSES = ["<blank>"] + list(CHARS)
CHAR_TO_INDEX = {c: i + 1 for i, c in enumerate(CHARS)}
CHARSET = set(CHARS)

MIRROR = {"(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<", "«": "»", "»": "«"}
SPACES = {" ", " ", " ", " ", "　", "\t"} | {chr(c) for c in range(0x2000, 0x200B)}
INVISIBLE = ({chr(c) for c in range(0x200B, 0x2010)} | {chr(c) for c in range(0x202A, 0x202F)}
             | {chr(c) for c in range(0x2060, 0x2065)} | {"﻿", "؜", "­", "ـ"})
REMAP = {
    "‐": "-", "‑": "-", "‒": "-", "−": "-", "–": "–", "—": "—", "―": "—",
    "′": "'", "‵": "'", "″": '"', "‶": '"', "‚": "‘", "‛": "‘", "„": "“", "‟": "“",
    "‹": "<", "›": ">", "⁄": "/", "∙": "•", "·": "•", "․": ".",
    "ک": "ك", "ڪ": "ك", "ۃ": "ة", "ھ": "ه", "ە": "ه", "ی": "ي", "ٱ": "ا",
    "✔": "✓", "☆": "★",
}
for _i in range(10):
    REMAP[chr(0x06F0 + _i)] = ARABIC_DIGITS[_i]


def _is_mark(c: str) -> bool:
    code = ord(c)
    return (0x064B <= code <= 0x065F or code == 0x0670 or 0x0610 <= code <= 0x061A
            or 0x06D6 <= code <= 0x06ED or unicodedata.category(c) == "Mn")


def strip_marks(text: str) -> str:
    return "".join(c for c in text if not _is_mark(c))


def normalize_text(text: str) -> str | None:
    """Return the label form of `text`, or None when it holds a character the model never learns."""
    out: list[str] = []
    for raw in unicodedata.normalize("NFC", text):
        if raw in INVISIBLE:
            continue
        c = REMAP.get(raw, raw)
        if c in SPACES:
            c = " "
        code = ord(c)
        if 0xFB50 <= code <= 0xFDFF or 0xFE70 <= code <= 0xFEFF or 0xFF01 <= code <= 0xFF5E:
            folded = strip_marks(unicodedata.normalize("NFKC", c)).replace("ـ", "")
            for part in folded:
                part = REMAP.get(part, part)
                if part not in CHARSET:
                    return None
                out.append(part)
            continue
        if _is_mark(c):
            continue
        if c in ("\n", "\r"):
            c = " "
        if c not in CHARSET:
            return None
        out.append(c)
    collapsed = " ".join("".join(out).split())
    return collapsed or None


def normalize_char(c: str) -> str | None:
    """One raw character to its label form: '' (dropped), ' ', label characters, or None (not learnable).

    The per-character counterpart of normalize_text, for text whose characters carry positions.
    """
    if c in INVISIBLE:
        return ""
    c = REMAP.get(c, c)
    if c in SPACES or c in ("\n", "\r", "\t", " "):
        return " "
    code = ord(c)
    if 0xFB50 <= code <= 0xFDFF or 0xFE70 <= code <= 0xFEFF or 0xFF01 <= code <= 0xFF5E:
        out = ""
        for part in strip_marks(unicodedata.normalize("NFKC", c)).replace("ـ", ""):
            part = REMAP.get(part, part)
            if part not in CHARSET:
                return None
            out += part
        return out
    if _is_mark(c):
        return ""
    return c if c in CHARSET else None


def encode(label: str) -> list[int]:
    return [CHAR_TO_INDEX[c] for c in label]


def decode(indices) -> str:
    return "".join(CLASSES[i] for i in indices if i > 0)


# ---------------------------------------------------------------- bidi (shared with bidi.ts)

def _is_arabic_letter(code: int) -> bool:
    return ((0x0620 <= code <= 0x064A) or (0x066E <= code <= 0x06D3) or (0x06FA <= code <= 0x06FC)
            or (0xFB50 <= code <= 0xFDFF) or (0xFE70 <= code <= 0xFEFF))


def classify(c: str) -> str:
    """UBA-like class: L, R, EN, AN, ET, CS or N."""
    code = ord(c)
    if _is_arabic_letter(code):
        return "R"
    if 0x30 <= code <= 0x39:
        return "EN"
    if 0x0660 <= code <= 0x0669 or 0x06F0 <= code <= 0x06F9:
        return "AN"
    if c in "%٪$€£¥¢#°+-":
        return "ET"
    if c in ",.:/٬٫،":
        return "CS"
    if unicodedata.category(c).startswith("L"):
        return "L"
    return "N"


def detect_base(text: str) -> str:
    """R when Arabic letters are at least as many as other letters, else L."""
    right = left = 0
    for c in text:
        kind = classify(c)
        if kind == "R":
            right += 1
        elif kind == "L":
            left += 1
    if right == 0:
        return "L"
    return "R" if right >= left else "L"


def resolve_levels(text: str, base: str) -> list[int]:
    n = len(text)
    types = [classify(c) for c in text]
    # W4: a single separator between two digits of the same kind joins the number.
    for i in range(1, n - 1):
        if types[i] == "CS":
            if types[i - 1] == "EN" and types[i + 1] == "EN" and text[i] in ",.:/":
                types[i] = "EN"
            elif types[i - 1] == "AN" and types[i + 1] == "AN" and text[i] in ",.،٬٫":
                types[i] = "AN"
    # W5: terminators next to a European number join it.
    i = 0
    while i < n:
        if types[i] == "ET":
            j = i
            while j < n and types[j] == "ET":
                j += 1
            if (i > 0 and types[i - 1] == "EN") or (j < n and types[j] == "EN"):
                for k in range(i, j):
                    types[k] = "EN"
            i = j
        else:
            i += 1
    # W7: a European number after Latin text (or at the start of a Latin line) reads as Latin.
    last_strong = base
    for i in range(n):
        if types[i] in ("L", "R"):
            last_strong = types[i]
        elif types[i] == "EN" and last_strong == "L":
            types[i] = "L"
    # N1/N2: neutrals take the direction of equal neighbours, else the base direction.
    i = 0
    while i < n:
        if types[i] in ("N", "CS", "ET"):
            j = i
            while j < n and types[j] in ("N", "CS", "ET"):
                j += 1
            prev = base
            for k in range(i - 1, -1, -1):
                if types[k] in ("L", "R", "EN", "AN"):
                    prev = "L" if types[k] == "L" else "R"
                    break
            nxt = base
            for k in range(j, n):
                if types[k] in ("L", "R", "EN", "AN"):
                    nxt = "L" if types[k] == "L" else "R"
                    break
            kind = prev if prev == nxt else base
            for k in range(i, j):
                types[k] = kind
            i = j
        else:
            i += 1
    levels = []
    for kind in types:
        if kind == "L":
            levels.append(0 if base == "L" else 2)
        elif kind == "R":
            levels.append(1)
        else:
            levels.append(2)
    return levels


def _reorder(text: str, levels: list[int]) -> str:
    chars = [MIRROR[c] if lvl % 2 == 1 and c in MIRROR else c for c, lvl in zip(text, levels)]
    odd = [lvl for lvl in levels if lvl % 2 == 1]
    if not odd:
        return "".join(chars)
    lowest_odd = min(odd)
    levels = list(levels)
    for level in range(max(levels), lowest_odd - 1, -1):
        i = 0
        n = len(chars)
        while i < n:
            if levels[i] >= level:
                j = i
                while j < n and levels[j] >= level:
                    j += 1
                chars[i:j] = chars[i:j][::-1]
                levels[i:j] = levels[i:j][::-1]
                i = j
            else:
                i += 1
    return "".join(chars)


def visual_indices(levels: list[int]) -> list[int]:
    """The logical indices in the left-to-right order they are drawn (rule L2 on positions)."""
    order = list(range(len(levels)))
    odd = [lvl for lvl in levels if lvl % 2 == 1]
    if not odd:
        return order
    current = list(levels)
    for level in range(max(current), min(odd) - 1, -1):
        i, n = 0, len(order)
        while i < n:
            if current[i] >= level:
                j = i
                while j < n and current[j] >= level:
                    j += 1
                order[i:j] = order[i:j][::-1]
                current[i:j] = current[i:j][::-1]
                i = j
            else:
                i += 1
    return order


def to_visual(logical: str, base: str | None = None) -> str:
    """Characters in the left-to-right order they are drawn, as an OCR model sees them."""
    base = base or detect_base(logical)
    return _reorder(logical, resolve_levels(logical, base))


def to_logical(visual: str, base: str | None = None) -> str:
    """Inverse of to_visual for the run structures that occur in real lines."""
    base = base or detect_base(visual)
    return _reorder(visual, resolve_levels(visual, base))


if __name__ == "__main__":
    cases = [
        ("مرحبا 123 world", "R", "world 123 ابحرم"),
        ("السعر 150 ريال", "R", "لاير 150 رعسلا"),
        ("Hello مرحبا", "L", "Hello ابحرم"),
        ("hello مرحبا 150", "L", "hello 150 ابحرم"),
        ("(تجريبي)", "R", "(يبيرجت)"),
        ("Price: 12.5%", "L", "Price: 12.5%"),
        ("نسبة 12.5% فقط", "R", "طقف 12.5% ةبسن"),
        ("تاريخ 22/11/2026", "R", "22/11/2026 خيرات"),
        ("ABC-123", "L", "ABC-123"),
        ("٢٠٢٦ عام", "R", "ماع ٢٠٢٦"),
        ("مرحبا، كيف الحال؟", "R", "؟لاحلا فيك ،ابحرم"),
    ]
    # Bidi is many-to-one: "مرحبا 123 world" and "مرحبا world 123" draw identically in an
    # RTL line. The inverse therefore only promises a logical string that draws the same.
    bad = 0
    for logical, base, expected in cases:
        got = to_visual(logical, base)
        back = to_logical(got, base)
        ok = got == expected and to_visual(back, base) == got
        bad += not ok
        print(("ok  " if ok else "BAD ") + f"{logical!r} -> {got!r} (back {back!r})")
    print("classes", len(CLASSES), "bad", bad)
