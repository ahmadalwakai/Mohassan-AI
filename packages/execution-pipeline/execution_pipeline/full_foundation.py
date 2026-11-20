"""A separately pinned one-billion-position run on the selected human text mix.

The pilot's cosine schedule ends at 300M. The full run deliberately uses fresh
initialization and a 1B schedule rather than silently changing a saved optimizer.
Only the approved, verified corpus streams are opened; no evaluation cases.
"""
from __future__ import annotations

from collections import Counter
from copy import deepcopy
from hashlib import sha256
from struct import pack

from .comparison_sampling import FrozenComparisonSampler, Window


INTERVAL = 50_000_000
TARGET = 1_000_000_000
MILESTONES = tuple(range(INTERVAL, TARGET + 1, INTERVAL))
MIX = "simplewiki_enriched"


def source_segment(start: int, end: int, sources: tuple[str, ...], width: int = 512) -> dict:
    """Exact 49.4% Wikipedia, 50% SimpleWiki, 0.6% human dialogue in English."""
    positions = (end - start) // 2
    if end <= start or (end - start) % 2000:
        raise ValueError("Full-run segments require positive multiples of 2000 positions.")
    budgets = dict(zip(sources, (positions * 494 // 1000, positions // 2, positions * 6 // 1000)))
    tail_sources, lengths, occupied = [], [], 0
    for source in sources:
        remainder = budgets[source] % width
        while remainder:
            length = min(remainder, width - occupied)
            if length < 2:
                raise ValueError("A next-token window cannot contain one position.")
            tail_sources.append(source)
            lengths.append(length)
            remainder -= length
            occupied = (occupied + length) % width
    return {"from": start, "to": end,
            "full_windows_per_language": sum(value // width for value in budgets.values()),
            "english_target": {MIX: budgets}, "tail_sources": {MIX: tail_sources},
            "short_window_lengths_for_both_languages": lengths}


class FullFoundationSampler(FrozenComparisonSampler):
    """Replayable balanced windows, with a digest at every 50M checkpoint."""

    def __init__(self, prep, allocation, *, verifier_sha256, expected_receipts=None):
        super().__init__(prep, allocation, seed=1729, mix=MIX, view="existing",
                         verifier_sha256=verifier_sha256)
        # The base loader verifies the frozen 100M cap before this extension.
        for start in range(100_000_000, TARGET, INTERVAL):
            self._append(source_segment(start, start + INTERVAL, self.sources))
        if self._ends[-1] != TARGET or set(self._receipts) != set(MILESTONES):
            raise ValueError("Full foundation schedule missed a fixed milestone.")
        if expected_receipts is not None and self.planned_receipts() != expected_receipts:
            raise ValueError("Full foundation windows changed after preparation.")

    def _build_schedule(self, verifier, expected, segments, banks, seed, mix, view, positions_per_update):
        self._verifier, self._banks = verifier, banks
        self._positions_per_update = positions_per_update
        self._rng = {source: verifier["random_stream"](seed, f"full-v1-window:{source}") for source in self.sources}
        self._arabic_rng = verifier["random_stream"](seed, "full-v1-arabic-window")
        self._ledgers = {source: sha256() for source in (*self.sources, "arabic")}
        self._source_slots = sha256()
        self._english, self._dialogue = Counter(), Counter()
        self._positions = 0
        for start in (0, INTERVAL):
            self._append(source_segment(start, start + INTERVAL, self.sources))

    def _append(self, segment):
        windows, slots = [], 0
        codes = {source: code for code, source in enumerate(self.sources)}
        for source, length in self._verifier["english_schedule"](segment, 1729, MIX):
            pair = self._verifier["take_window"](self._banks[source], self._rng[source], length)
            ar_start = self._arabic_rng.randrange(len(self._stream["ar"]) - length + 1)
            windows.append(Window(source, ar_start, pair[0], length))
            self._ledgers[source].update(pack("<QQH", *pair, length))
            self._ledgers["arabic"].update(pack("<QH", ar_start, length))
            self._source_slots.update(pack("<BH", codes[source], length))
            self._english[source] += length
            if source == "dialogue":
                self._verifier["add_dialogue_counts"](self._banks[source], pair[0], length, self._dialogue)
            slots += 2 * length
            if slots > self._positions_per_update:
                raise ValueError("Full foundation update crossed its position budget.")
            if slots == self._positions_per_update or self._positions + slots == segment["to"]:
                self._positions += slots
                self._updates.append(tuple(windows))
                self._ends.append(self._positions)
                windows, slots = [], 0
        if windows or self._positions != segment["to"]:
            raise ValueError("Full foundation segment did not close at its checkpoint.")
        self._receipts[self._positions] = {
            "english_positions": dict(self._english), "dialogue_positions_by_source": dict(self._dialogue),
            "ordered_window_sha256_by_source": {source: digest.hexdigest() for source, digest in self._ledgers.items()},
            "source_slot_schedule_sha256": self._source_slots.hexdigest()}

    def planned_receipts(self):
        return {str(point): deepcopy(self._receipts[point]) for point in sorted(self._receipts)}
