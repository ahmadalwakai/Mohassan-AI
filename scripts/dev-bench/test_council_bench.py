from council_bench import summarize_council


def test_council_summary_distinguishes_graded_answers_from_other_members():
    def turn(correct, *, changed=True):
        return {'changed': changed, 'sentCorrect': correct, 'members': [
            {'model': 'reader', 'correct': correct},
            {'model': 'verifier', 'correct': None},
        ]}

    result = summarize_council([
        {'area': 'web', 'language': 'ar', 'council': [turn(True), turn(False)]},
        {'area': 'web', 'language': 'en', 'council': [None, turn(True, changed=False)]},
        {'area': 'files', 'language': 'en', 'council': [turn(None)]},
        {'area': 'other', 'language': 'ar'},
    ])

    assert result['turnsByAreaAndLanguage'] == {'web/ar': 2, 'web/en': 1, 'files/en': 1}
    assert result['changed'] == {'total': 3, 'correct': 1, 'wrong': 1, 'ungraded': 1}
    groups = result['membersByAreaAndLanguage']
    assert groups['web/ar']['reader'] == {'recorded': 2, 'graded': 2, 'correct': 1, 'accuracy': 1 / 2}
    assert groups['web/ar']['verifier'] == {'recorded': 2, 'graded': 0, 'correct': 0, 'accuracy': None}
    assert groups['web/en']['reader']['accuracy'] == 1
    assert groups['files/en']['reader']['accuracy'] is None
