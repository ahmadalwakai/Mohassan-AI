"""Fit a language identifier from labeled corpus paragraphs."""

from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from collections.abc import Iterable, Iterator

from .normalization import match_key

VERSION = 1
NGRAM_WIDTHS = (1, 2, 3)
LAPLACE_ALPHA = 1
_WORD_LETTERS = re.compile(r"[^\W\d_]+")


def paragraphs(text: str) -> Iterator[str]:
    lines: list[str] = []
    for line in text.replace("\u2029", "\n\n").splitlines():
        if line.strip():
            lines.append(line)
        elif lines:
            yield "\n".join(lines)
            lines.clear()
    if lines:
        yield "\n".join(lines)


def _features(text: str) -> Counter[str]:
    letters = " ".join(_WORD_LETTERS.findall(match_key(text).casefold()))
    return Counter(
        letters[start : start + width]
        for width in NGRAM_WIDTHS
        for start in range(len(letters) - width + 1)
    )


class LanguageModel:
    """Multinomial naive Bayes over character n-grams, fit from labeled text."""

    def __init__(self, counts: dict[str, Counter[str]], documents: Counter[str]) -> None:
        self.labels = tuple(sorted(counts))
        self._vocabulary = frozenset(gram for counter in counts.values() for gram in counter)
        total_documents = documents.total()
        self._priors = {label: math.log(documents[label] / total_documents) for label in self.labels}
        # Factor the smoothing mass out of each term so unseen class features
        # use a zero adjustment with the same class denominator.
        self._denominators = {
            label: math.log(counts[label].total() / LAPLACE_ALPHA + len(self._vocabulary))
            for label in self.labels
        }
        self._weights = {
            label: {gram: math.log1p(count / LAPLACE_ALPHA) for gram, count in counts[label].items()}
            for label in self.labels
        }

    @classmethod
    def train(cls, examples: Iterable[tuple[str, str]]) -> LanguageModel:
        counts: dict[str, Counter[str]] = defaultdict(Counter)
        documents: Counter[str] = Counter()
        for label, text in examples:
            features = _features(text)
            if features:
                counts[label].update(features)
                documents[label] += 1
        if not documents:
            raise ValueError("Language training needs at least one labeled text with letters.")
        return cls(counts, documents)

    def predict(self, text: str) -> str:
        features = [
            (gram, count) for gram, count in _features(text).items() if gram in self._vocabulary
        ]
        feature_count = sum(count for _, count in features)

        def score(label: str) -> float:
            weights = self._weights[label]
            return self._priors[label] - feature_count * self._denominators[label] + sum(
                count * weights.get(gram, 0.0) for gram, count in features
            )

        return max(self.labels, key=score)

    def confusion(self, examples: Iterable[tuple[str, str]]) -> dict[str, object]:
        matrix = {actual: dict.fromkeys(self.labels, 0) for actual in self.labels}
        total = 0
        correct = 0
        for actual, text in examples:
            if actual not in matrix:
                raise ValueError(f"Language development label was missing from training: {actual!r}")
            predicted = self.predict(text)
            matrix[actual][predicted] += 1
            total += 1
            correct += predicted == actual
        return {"labels": list(self.labels), "matrix": matrix, "total": total, "correct": correct}
