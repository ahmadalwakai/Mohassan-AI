"""Verify exact full-run source budgets and the no-single-token tail rule."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline.full_foundation import INTERVAL, MILESTONES, MIX, source_segment


def test_each_full_run_segment_has_exact_balanced_source_budgets():
    sources = ("wikipedia-20231101-en", "simplewiki-20261101", "dialogue")
    for end in MILESTONES:
        segment = source_segment(end - INTERVAL, end, sources)
        budgets = segment["english_target"][MIX]
        assert budgets == dict(zip(sources, (12_350_000, 12_500_000, 150_000)))
        assert 2 * (512 * segment["full_windows_per_language"]
                    + sum(segment["short_window_lengths_for_both_languages"])) == INTERVAL
        assert all(2 <= length <= 512 for length in segment["short_window_lengths_for_both_languages"])
