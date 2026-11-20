from collections import Counter

from execution_pipeline.comparison_continuation import (
    ANCHOR_POSITIONS,
    ANCHOR_UPDATES,
    ENGLISH_MIX,
    TARGET_POSITIONS,
    TARGET_UPDATES,
    _tail_segment,
)


def test_continuation_source_remainders_fit_exact_bilingual_updates():
    sources = ["wikipedia-20231101-en", "simplewiki-20261101", "dialogue"]
    segment = _tail_segment({"sequence_length": 512, "source_order": sources})
    lengths = segment["short_window_lengths_for_both_languages"]
    tail_sources = segment["tail_sources"][ENGLISH_MIX]

    assert lengths == [192, 128, 192, 256]
    assert tail_sources == [*sources, "dialogue"]
    remaining = Counter()
    for source, length in zip(tail_sources, lengths, strict=True):
        remaining[source] += length
    assert remaining == dict(zip(sources, [192, 128, 448], strict=True))
    assert segment["english_target"][ENGLISH_MIX] == dict(
        zip(sources, [49_400_000, 50_000_000, 600_000], strict=True)
    )

    before_final = 2 * (segment["full_windows_per_language"] * 512 + sum(lengths[:-1]))
    assert before_final % 8192 == 0
    assert before_final + 2 * lengths[-1] == TARGET_POSITIONS - ANCHOR_POSITIONS
    assert ANCHOR_UPDATES + before_final // 8192 + 1 == TARGET_UPDATES
