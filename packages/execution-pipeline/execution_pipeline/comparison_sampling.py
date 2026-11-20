"""Open and replay the approved paired source-window schedule."""
from __future__ import annotations

from bisect import bisect_left
from collections import Counter, defaultdict
from dataclasses import dataclass
from hashlib import sha256
import json
from pathlib import Path
import platform
import runpy
from struct import pack

from . import REPOSITORY_ROOT
from .ads_finetune import _sha256


@dataclass(frozen=True)
class Window:
    source: str
    arabic_start: int
    english_start: int
    length: int


class FrozenComparisonSampler:
    """Verify the frozen windows before exposing exact balanced optimizer updates."""

    def __init__(self, prep: Path, allocation: dict, *, seed: int, mix: str, view: str, verifier_sha256: str,
                 max_microbatch_rows: int | None = None):
        import numpy as np

        if platform.python_version() != allocation["python_version"]:
            raise ValueError("Comparison sampler requires the Python version used for the frozen schedule.")
        verifier_path = prep / "budgets/verify.py"
        if _sha256(verifier_path) != verifier_sha256:
            raise ValueError("Frozen comparison sampler code digest changed.")
        verifier = runpy.run_path(str(verifier_path))
        segments = verifier["build_segments"]()
        if verifier["allocation"](segments) != allocation:
            raise ValueError("Frozen position allocation did not match the pinned sampler.")
        verified = json.loads((prep / "budgets/sampling-verification.json").read_text(encoding="utf-8"))
        streams_path = prep / "packed/streams/manifest.json"
        streams = json.loads(streams_path.read_text(encoding="utf-8"))
        if _sha256(streams_path) != verified["packed_manifest_sha256"]:
            raise ValueError("Packed source manifest differs from the comparison's frozen ledger.")
        context = allocation["sequence_length"]
        self.microbatch = allocation["microbatch_rows_at_most"]
        self.execution_microbatch = self.microbatch if max_microbatch_rows is None else max_microbatch_rows
        if type(self.execution_microbatch) is not int or not 1 <= self.execution_microbatch <= self.microbatch:
            raise ValueError("Execution microbatch must fit within the frozen batch size.")
        self.sources = tuple(allocation["source_order"])
        self._stream = {}
        banks = {}
        checked_binary = {}
        for source in self.sources:
            views = streams["streams"][source]
            for stream in views.values():
                binary = streams_path.parent / stream["binary"]
                if binary not in checked_binary:
                    checked_binary[binary] = _sha256(binary)
                if checked_binary[binary] != stream["binary_sha256"]:
                    raise ValueError(f"Packed comparison binary digest changed: {binary}")
            bank = verifier["open_paired"](streams_path, source, views)
            if bank["summary"] != verified["logical_english_streams"][source]:
                raise ValueError(f"Packed comparison index differs from its frozen ledger: {source}")
            banks[source] = bank
            self._stream[source] = np.memmap(streams_path.parent / views[view]["binary"], dtype="<u2", mode="r")
        arabic = verified["arabic_stream"]
        arabic_info = streams["arabic_training"]
        arabic_path = REPOSITORY_ROOT / arabic_info["path"]
        if (_sha256(arabic_path) != arabic["sha256"] or arabic_info["sha256"] != arabic["sha256"]
                or arabic_path.stat().st_size != arabic["tokens"] * 2):
            raise ValueError("Arabic training stream differs from its frozen ledger.")
        self._stream["ar"] = np.memmap(arabic_path, dtype="<u2", mode="r")

        self._updates = []
        self._ends = []
        self._receipts = {}
        self._cursor = 0
        positions_per_update = context * self.microbatch * allocation["regular_accumulation_microbatches"]
        self._build_schedule(verifier, verified["runs"][str(seed)][mix], segments, banks, seed, mix, view,
                             positions_per_update)
        if self._ends[-1] != allocation["training_positions_per_start"]:
            raise ValueError("Comparison schedule does not end at the authorized token cap.")

    def _build_schedule(self, verifier, expected, segments, banks, seed, mix, view, positions_per_update):
        random_stream = verifier["random_stream"]
        rng = {source: random_stream(seed, f"paired-window:{source}") for source in self.sources}
        arabic_rng = random_stream(seed, "arabic-window")
        ledgers = {source: sha256() for source in (*self.sources, "arabic")}
        source_slots = sha256()
        positions, expected_updates = 0, 0
        english, dialogue = Counter(), Counter()
        view_index = ("existing", "repaired").index(view)
        codes = {name: index for index, name in enumerate(self.sources)}
        for segment in segments:
            windows, slots = [], 0
            for source, length in verifier["english_schedule"](segment, seed, mix):
                pair = verifier["take_window"](banks[source], rng[source], length)
                ar_start = arabic_rng.randrange(len(self._stream["ar"]) - length + 1)
                windows.append(Window(source, ar_start, pair[view_index], length))
                ledgers[source].update(pack("<QQH", *pair, length))
                ledgers["arabic"].update(pack("<QH", ar_start, length))
                source_slots.update(pack("<BH", codes[source], length))
                english[source] += length
                if source == "dialogue":
                    verifier["add_dialogue_counts"](banks[source], pair[0], length, dialogue)
                slots += 2 * length
                if slots > positions_per_update:
                    raise ValueError("An approved comparison update exceeded its position budget.")
                if slots == positions_per_update or positions + slots == segment["to"]:
                    positions += slots
                    self._updates.append(tuple(windows))
                    self._ends.append(positions)
                    windows, slots = [], 0
            expected_updates += segment["optimizer_updates"]
            if windows or positions != segment["to"] or len(self._updates) != expected_updates:
                raise ValueError("Comparison updates did not close exactly at the approved milestone.")
            receipt = {
                "english_positions": dict(english),
                "dialogue_positions_by_source": dict(dialogue),
                "ordered_window_sha256_by_source": {source: digest.hexdigest() for source, digest in ledgers.items()},
                "source_slot_schedule_sha256": source_slots.hexdigest(),
            }
            if receipt != expected[str(positions)]:
                raise ValueError(f"Comparison windows differ from the frozen ledger at {positions}.")
            self._receipts[positions] = receipt

    def seek(self, positions: int, updates: int):
        """Restore the deterministic cursor at an exact committed optimizer update."""
        cursor = bisect_left(self._ends, positions) + 1 if positions else 0
        if ((positions and (cursor > len(self._ends) or self._ends[cursor - 1] != positions))
                or cursor != updates):
            raise ValueError("Comparison checkpoint did not restore an exact window-ledger cursor.")
        self._cursor = cursor

    def _next(self, positions: int):
        if self._cursor >= len(self._updates):
            raise ValueError("Comparison attempted to read beyond the authorized token cap.")
        windows = self._updates[self._cursor]
        if sum(window.length * 2 for window in windows) != positions:
            raise ValueError("Optimizer update position count differs from the approved window schedule.")
        return windows

    def targets(self, positions: int):
        return positions - 2 * len(self._next(positions))

    def update(self, positions: int, device: str):
        import numpy as np
        import torch

        windows = self._next(positions)
        by_length = defaultdict(list)
        for window in windows:
            by_length[window.length].append(window)
        for length, group in by_length.items():
            for first in range(0, len(group), self.microbatch):
                batch = group[first:first + self.microbatch]
                for language in ("ar", "en"):
                    for offset in range(0, len(batch), self.execution_microbatch):
                        rows = [
                            self._stream["ar"][window.arabic_start:window.arabic_start + length]
                            if language == "ar" else
                            self._stream[window.source][window.english_start:window.english_start + length]
                            for window in batch[offset:offset + self.execution_microbatch]
                        ]
                        ids = torch.from_numpy(np.asarray(rows, dtype=np.int64)).to(device, non_blocking=True)
                        yield language, ids
        self._cursor += 1

    def receipt(self, positions: int):
        if not self._cursor or self._ends[self._cursor - 1] != positions:
            raise ValueError("Milestone cannot be reported before consuming its exact window schedule.")
        return self._receipts[positions]
