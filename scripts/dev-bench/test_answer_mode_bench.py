import pytest

from answer_mode_bench import summarize_turn_resources


def test_resource_summary_counts_replies_and_attempted_turns_separately():
    scores = [
        {'id': 'one', 'replies': ['reply', 'follow-up'], 'turnResources': [
            {'finalAnswerMs': 10, 'cpuMs': 2},
            {'finalAnswerMs': 50, 'cpuMs': 6},
        ]},
        {'id': 'two', 'replies': ['', 'reply'], 'turnResources': [
            {'finalAnswerMs': None, 'cpuMs': 12},
            {'finalAnswerMs': 20, 'cpuMs': 4},
        ]},
        {'id': 'setup-failed', 'replies': [''], 'turnResources': [{'finalAnswerMs': None, 'cpuMs': None}]},
    ]

    assert summarize_turn_resources(scores) == {
        'finalAnswerTurns': 3,
        'p50FinalAnswerMs': 20,
        'p95FinalAnswerMs': 50,
        'cpuMeasuredTurns': 4,
        'meanNodeCpuMsPerTurn': 6,
    }


def test_resource_summary_checks_turn_coverage_and_rejects_invalid_samples():
    with pytest.raises(ValueError, match='do not match'):
        summarize_turn_resources([{'id': 'one', 'replies': ['reply'], 'turnResources': []}])

    scores = [{'id': 'one', 'replies': ['reply'], 'turnResources': [{'finalAnswerMs': 1, 'cpuMs': -1}]}]
    with pytest.raises(ValueError, match='invalid cpuMs'):
        summarize_turn_resources(scores)
