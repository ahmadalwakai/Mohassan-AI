"""The pinned scorer emits answer checks separately from other turn failures.

Source (retrieved 2026-11-27):
https://github.com/ahmadalwakai/Mohassan-AI/blob/a1e1cb020b7ba093885edbf501149e7b8252c0cb/scripts/agent-capability-bench/score.ts
"""

import pytest

from runner import HOLDOUTS, SCRATCH_MODELS, model_profile
from truth_audit import summarize_withholds


def check(candidate, *, decision='withhold', published=False):
    return {'candidate': candidate, 'decision': decision, 'published': published}


def score(case_id, truth_checks, failure_stages):
    return {'id': case_id, 'truthChecks': truth_checks,
            'turns': [{'failures': [{'stage': stage} for stage in stages]} for stages in failure_stages]}


def test_classifies_only_matching_published_turns_by_native_answer_checks():
    shadow = score('case', [[check('one')], [check('two')], [check('three')], [check('four')]],
                   [['routing'], ['answer'], [], []])
    enabled = score('case', [[check('one', published=True)], [check('two', published=True)],
                             [check('three')], [check('different', published=True)]], [[], [], [], []])
    result = summarize_withholds([shadow], [enabled])
    assert result == {'publishedDecisions': 3, 'publishedTurns': 3, 'multiDecisionTurns': 0,
                      'falseAlarms': 1, 'saves': 1, 'unmatchedTurns': 1}


def test_combined_answer_has_one_native_score_for_multiple_publication_decisions():
    checks = [check('one'), check('two')]
    shadow = score('case', [checks], [['answer']])
    enabled = score('case', [[{**value, 'published': True} for value in checks]], [[]])
    result = summarize_withholds([shadow], [enabled])
    assert result['publishedDecisions'] == len(checks)
    assert result['publishedTurns'] == result['multiDecisionTurns'] == result['saves'] == 1


def test_rejects_mismatched_case_coverage():
    with pytest.raises(ValueError, match='case coverage'):
        summarize_withholds([score('shadow', [], [])], [score('enabled', [], [])])


def test_model_free_profile_excludes_scratch_artifacts_and_disables_classifier():
    settings = {'MOHASSAN_MODEL_RELATIONS': 'off'}
    assert model_profile(settings, False) == (settings, HOLDOUTS)
    assert model_profile(settings, True) == (
        settings | {'MOHASSAN_SCRATCH_CLASSIFIERS': '0'}, (*HOLDOUTS, SCRATCH_MODELS))
    with pytest.raises(ValueError, match='model files are excluded'):
        model_profile(settings | {'MOHASSAN_SCRATCH_CLASSIFIERS': '1'}, True)
