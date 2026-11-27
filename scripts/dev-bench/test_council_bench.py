from council_bench import summarize_council


def test_council_summary_distinguishes_graded_answers_from_other_members():
    def turn(correct, *, chosen='pipeline', changed=True, elapsed=6, eligible=False, uncertainty=None):
        return {'chosen': chosen, 'changed': changed, 'sentCorrect': correct, 'elapsedMs': elapsed,
                'v5Eligible': eligible, 'uncertaintyPath': uncertainty, 'members': [
            {'model': 'reader', 'correct': correct},
            {'model': 'verifier', 'correct': None},
        ]}

    result = summarize_council([
        {'area': 'web', 'language': 'ar', 'passed': False,
         'council': [turn(True, elapsed=1), turn(False, chosen='uncertain', elapsed=14, uncertainty='blocked_with_pages')]},
        {'area': 'web', 'language': 'en', 'passed': True, 'council': [None, turn(True, changed=False, elapsed=11)]},
        {'area': 'files', 'language': 'en', 'passed': True, 'publishedV5': 1,
         'council': [turn(None, chosen='chat-v5', eligible=True)]},
        {'area': 'other', 'language': 'ar', 'passed': True},
    ])

    assert result['turns'] == 4
    assert result['turnsByAreaAndLanguage'] == {'web/ar': 2, 'web/en': 1, 'files/en': 1}
    assert result['changed'] == {'total': 3, 'correct': 1, 'wrong': 1, 'ungraded': 1}
    assert result['decisions'] == {'chat-v5': 1, 'pipeline': 2, 'uncertain': 1}
    assert result['elapsedMs'] == {'count': 4, 'p50': 6, 'p95': 14}
    assert result['v5'] == {'eligibleCouncilTurns': 1, 'selectedCouncilTurns': 1, 'publishedReplies': 1}
    assert result['uncertainty'] == {'total': 1, 'byPath': {
        'blocked_with_pages': {'total': 1, 'correct': 0, 'wrong': 1, 'ungraded': 0, 'casePassed': 0, 'caseFailed': 1},
    }}
    groups = result['membersByAreaAndLanguage']
    assert groups['web/ar']['reader'] == {'recorded': 2, 'graded': 2, 'correct': 1, 'accuracy': 1 / 2}
    assert groups['web/ar']['verifier'] == {'recorded': 2, 'graded': 0, 'correct': 0, 'accuracy': None}
    assert groups['web/en']['reader']['accuracy'] == 1
    assert groups['files/en']['reader']['accuracy'] is None


def test_council_off_summary_has_no_timing_samples():
    result = summarize_council([{'council': [None], 'publishedV5': 1}])

    assert result['turns'] == 0
    assert result['elapsedMs'] == {'count': 0, 'p50': None, 'p95': None}
    assert result['v5'] == {'eligibleCouncilTurns': 0, 'selectedCouncilTurns': 0, 'publishedReplies': 1}
