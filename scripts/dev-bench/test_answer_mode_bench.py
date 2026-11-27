import pytest

from answer_mode_bench import summarize_pipeline_proposals, summarize_turn_resources


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


def test_pipeline_proposals_count_strict_turns_and_compare_answer_content():
    def case(label, area, replies, proposals=None):
        score = {'id': label, 'area': area, 'language': 'ar', 'replies': replies}
        if proposals is not None:
            score['councilWeb'] = [None if answer is False else {'pipelineAnswer': answer} for answer in proposals]
        return score

    off = [
        case('fact', 'factual', ['يبلغ عدد سكان فريدونيا **٤٬٢٠٠٬٠٠٠** نسمة.', '848.\n\n**Source:** 48', '']),
        case('comparison', 'comparison', ['بايلايت أكبر.']),
    ]
    web = [
        case('fact', 'factual', ['', '', ''], ['4,200,000', '48', False]),
        case('comparison', 'comparison', [''], ['بايلايت']),
    ]
    assert summarize_pipeline_proposals(off, web) == {
        'councilWeb': {'turns': 3, 'pipelineProposals': 3, 'presentInOffReply': 2},
        'factualFamily': {'turns': 3, 'pipelineProposals': 2, 'presentInOffReply': 1},
        'factualFamilyCouncilWeb': {'turns': 2, 'pipelineProposals': 2, 'presentInOffReply': 1},
    }
    with pytest.raises(ValueError, match='aligned development cases'):
        summarize_pipeline_proposals(off, list(reversed(web)))
