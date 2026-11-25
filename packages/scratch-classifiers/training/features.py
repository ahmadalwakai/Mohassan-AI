"""Self-contained feature extraction mirrored by src/features.ts."""

import re
import unicodedata


RAW_LIMIT = 2048
TEXT_LIMIT = 512
LETTER_FORMS = str.maketrans({
    "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ی": "ي", "ئ": "ي", "ؤ": "و", "ة": "ه", "ک": "ك",
    "’": "'", "−": "-", "؟": "?", "٪": "%", "٫": ".",
    **{digit: str(index) for index, digit in enumerate("٠١٢٣٤٥٦٧٨٩")},
    **{digit: str(index) for index, digit in enumerate("۰۱۲۳۴۵۶۷۸۹")},
})
ARABIZI_LETTERS = {
    "a": "", "b": "ب", "c": "ك", "d": "د", "e": "", "f": "ف", "g": "ج", "h": "ه", "i": "ي", "j": "ج", "k": "ك", "l": "ل",
    "m": "م", "n": "ن", "o": "و", "p": "ب", "q": "ق", "r": "ر", "s": "س", "t": "ت", "u": "و", "v": "ف", "w": "و", "x": "كس",
    "y": "ي", "z": "ز", "2": "ء", "3": "ع", "5": "خ", "6": "ط", "7": "ح", "8": "ق", "9": "ص", "'": "",
}
ARABIZI_PAIRS = {
    "aa": "ا", "ay": "اي", "ee": "ي", "gh": "غ", "kh": "خ", "oo": "و", "ou": "و", "sh": "ش", "th": "ث",
    "3'": "غ", "6'": "ظ", "7'": "خ", "9'": "ض",
}
TOKENS = re.compile(r"[^\W_]+(?:'[^\W_]+)*'?|[!?+*/=:%@.\-]")
ARABIZI_DIGIT = re.compile(r"[2356789]")
ARABIZI_WORD = re.compile(r"[a-z2356789']+")
ARABIZI_VOWEL = re.compile(r"[aeiou][2356789]|[2356789]'?[aeiou]")
ADJACENT_DIGITS = re.compile(r"[0-9]{2}")
LATIN_LETTER = re.compile(r"[a-z]")


def _fold_arabizi(word: str) -> str:
    if (not ARABIZI_WORD.fullmatch(word) or ADJACENT_DIGITS.search(word)
            or not ARABIZI_VOWEL.search(word) or len(LATIN_LETTER.findall(word)) < 3):
        return word.removesuffix("'")
    folded = []
    index = 0
    while index < len(word):
        pair = ARABIZI_PAIRS.get(word[index:index + 2])
        if pair is not None:
            folded.append(pair)
            index += 2
        else:
            letter = word[index]
            folded.append("ا" if letter == "a" and index == 0 else ARABIZI_LETTERS[letter])
            index += 1
    return "".join(folded)


def normalize(text: str) -> str:
    folded = unicodedata.normalize("NFKC", text[:RAW_LIMIT]).lower().translate(LETTER_FORMS)
    folded = "".join(character for character in folded
                     if character != "ـ" and not unicodedata.category(character).startswith("M"))
    tokens = (_fold_arabizi(word) if ARABIZI_DIGIT.search(word) else word.removesuffix("'")
              for word in TOKENS.findall(folded))
    return " ".join(tokens)[:TEXT_LIMIT].rstrip()


HASH_START = 0x811C9DC5
HASH_PRIME = 0x01000193
SPACE = 32


def _append_hash(value: int, code_point: int) -> int:
    return ((value ^ code_point) * HASH_PRIME) & 0xFFFFFFFF


def _hash_word(value: int, word: str) -> int:
    for character in word:
        value = _append_hash(value, ord(character))
    return value


def _add_ngrams(ids: dict[int, None], text: str, words: list[str], size: int, char_namespace: int) -> None:
    characters = [ord(character) for character in f"^{text}$"]
    char_seed = _append_hash(HASH_START, char_namespace)
    for start in range(len(characters) - 1):
        value = _append_hash(char_seed, characters[start])
        for end in range(start + 1, min(start + 5, len(characters))):
            value = _append_hash(value, characters[end])
            ids[value % size] = None

    word_seed = _append_hash(HASH_START, char_namespace + 1)
    previous_hash = None
    for word in words:
        value = _hash_word(word_seed, word)
        ids[value % size] = None
        if previous_hash is not None:
            ids[_hash_word(_append_hash(previous_hash, SPACE), word) % size] = None
        previous_hash = value


def feature_ids(text: str, size: int, previous_text: str | None = None) -> list[int]:
    """Binary character 2–5 and word 1–2 features in deterministic traversal order."""
    if type(size) is not int or not 0 < size < 2**53:
        raise ValueError("Feature space must be a positive integer")
    current = normalize(text)
    if not current:
        return []
    ids = {}
    words = current.split(" ")
    _add_ngrams(ids, current, words, size, 1)
    previous = normalize(previous_text) if previous_text else ""
    if previous:
        previous_words = previous.split(" ")
        _add_ngrams(ids, previous, previous_words, size, 3)
        current_terms = {word for word in words if word[0].isalnum()}
        previous_terms = {word for word in previous_words if word[0].isalnum()}
        possible = min(len(current_terms), len(previous_terms))
        if possible > 0:
            shared = len(current_terms & previous_terms)
            overlap = 0 if shared == 0 else (1 if shared * 2 < possible else 2)
            ids[_append_hash(_append_hash(HASH_START, 5), overlap) % size] = None
    return list(ids)
