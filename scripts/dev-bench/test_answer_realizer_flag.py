from runner import collect_environment


def test_answer_realizer_can_be_enabled_for_one_arm(tmp_path, monkeypatch):
    flag = 'MOHASSAN_ANSWER_REALIZER'
    monkeypatch.setenv(flag, '1')

    base, base_settings = collect_environment({}, tmp_path)
    candidate, candidate_settings = collect_environment({flag: '1'}, tmp_path)

    assert flag not in base
    assert flag not in base_settings
    assert candidate == base | {flag: '1'}
    assert candidate_settings == base_settings | {flag: '1'}
