"""Integration tests for Python assertions and the isolated verifier process."""

import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest


WORKER = Path(__file__).resolve().parents[1] / "apps/server/src/assistant/test-driven-coding/worker.py"
PYTHON = [sys.executable, "-I", "-B", "-S"]


def run_worker(payload, fixture=None):
    args = [str(WORKER)] if fixture is None else ["-c", fixture, str(WORKER.parent)]
    with TemporaryDirectory(prefix="mohassan-python-test-") as temp:
        result = subprocess.run(
            [*PYTHON, *args], input=json.dumps(payload), cwd=temp,
            env={}, capture_output=True, text=True, timeout=5, check=True,
        )
        if list(Path(temp).iterdir()):
            raise AssertionError("the sandbox directory is no longer empty")
    if result.stderr:
        raise AssertionError(result.stderr)
    lines = result.stdout.splitlines()
    if len(lines) != 1 or not result.stdout.endswith("\n"):
        raise AssertionError("the worker did not emit exactly one JSON line")
    return json.loads(lines[0])


@unittest.skipUnless(sys.platform == "linux", "seccomp is a Linux backend")
@unittest.skipIf(getattr(os, "geteuid", lambda: 0)() == 0, "verifier requires an unprivileged user")
class IsolatedVerifierTests(unittest.TestCase):
    def verify(self, source, assertions=None):
        return run_worker({
            "mode": "verify", "source": source,
            "assertions": assertions or ["assert tag(23) == 27"],
        })

    def test_accepts_multiline_examples_and_checks_unprojected_assertions(self):
        assertions = """```python
assert add_offset(
    [26, 31], 3
) == [29, 34]
assert [3, 9] == add_offset([1, 7], 2)
assert tuple(add_offset([2, 6], -3)) == (-1, 3)
```"""
        result = run_worker({
            "mode": "solve",
            "description": "Add the supplied offset to each number.",
            "assertions": assertions,
        })
        self.assertEqual(result["status"], "passed", result)
        self.assertIn("def add_offset(", result["source"])
        self.assertEqual(self.verify(result["source"], assertions), {"status": "passed"})

    def test_reports_first_failing_assertion_without_code(self):
        result = self.verify("def tag(n):\n    return n + 4", [
            "assert tag(23) == 27", "assert tag(9) == 15", "assert tag(0) == 4",
        ])
        self.assertEqual(result, {
            "status": "failed", "reason": "assertion-failed",
            "assertionIndex": 1,
        })

    def test_no_implementation_is_returned_for_inconsistent_examples(self):
        assertions = ["assert adjust(34) == 39", "assert adjust(34) == 27"]
        result = run_worker({
            "mode": "solve", "description": "Apply a fixed offset.",
            "assertions": assertions,
        })
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["reason"], "assertion-failed")
        self.assertNotIn("source", result)
        self.assertIn(result["assertionIndex"], range(len(assertions)))
        self.assertNotIn("assertion", result)
        self.assertGreater(result["tried"], 0)

    def test_parses_nested_python_values_and_allows_pure_module_imports(self):
        self.assertEqual(self.verify(
            "from re import findall\ndef scan(pair):\n    return findall(r'[A-Z]', pair['value'][0])",
            ["assert scan({'value': ('aBCq', {2, 7})}) == ['B', 'C']"],
        ), {"status": "passed"})

    def test_preserves_unicode_separators_inside_assertion_literals(self):
        self.assertEqual(self.verify(
            "def tag(n):\n    return n",
            "assert tag('''first\u2028second''') == 'first\\u2028second'",
        ), {"status": "passed"})

    def test_rejects_missing_mixed_and_inconsistent_assertions(self):
        for raw, reason in [
            ("", "invalid-assertions"),
            ("assert tag(23) == 27\nanswer = 1", "invalid-assertions"),
            ("assert tag(23) == 27\nassert tag(13, 5) == 18", "unsupported-arguments"),
            ("assert tag(23) == 27\nassert extra(13) == 18", "unsupported-assertion"),
        ]:
            with self.subTest(reason=reason, raw=raw):
                failure = run_worker({"mode": "solve", "description": "", "assertions": raw})
                self.assertEqual(failure["reason"], reason)
                self.assertNotIn("source", failure)

    def test_rejects_forbidden_imports_and_file_writes(self):
        for source in [
            "import os\ndef tag(n):\n    return n + 4",
            "def tag(n):\n    import subprocess\n    return n + 4",
            "def tag(n):\n    from socket import socket\n    return n + 4",
            "def tag(n):\n    open('result.txt', 'w').write('fixture')\n    return n + 4",
        ]:
            with self.subTest(source=source):
                self.assertEqual(self.verify(source)["reason"], "unsupported-candidate")
        failure = self.verify("def tag(n):\n    return n + 4", [
            "assert tag(23) == 27 and open('result.txt', 'w')",
        ])
        self.assertEqual(failure["reason"], "unsupported-assertion")

    def test_limits_time_memory_and_output(self):
        for source, reason in [
            ("def tag(n):\n    while True:\n        pass", "time-limit"),
            ("def tag(n):\n    return [0] * 50000000", "memory-limit"),
            ("def tag(n):\n    print('x' * 100000)\n    return n + 4", "output-limit"),
        ]:
            with self.subTest(reason=reason):
                self.assertEqual(self.verify(source)["reason"], reason)

    def test_requires_a_candidate_call_in_each_assertion(self):
        for skipped in ("True or tag(9) == 13", "tag(9) == 13 if False else True"):
            with self.subTest(skipped=skipped):
                result = self.verify("def tag(n):\n    return n + 4", [
                    "assert tag(23) == 27", f"assert {skipped}",
                ])
                self.assertEqual(result, {
                    "status": "failed", "reason": "assertion-failed", "assertionIndex": 1,
                })

    def test_regex_debug_flag_leaves_only_the_json_result(self):
        result = self.verify("def tag(n):\n    return n + 4", [
            "assert tag(23) == 27 and re.search('a', 'a', 128)",
        ])
        self.assertEqual(result, {
            "status": "failed", "reason": "assertion-error", "assertionIndex": 0,
        })

    def test_sinks_process_output_and_ignores_warnings(self):
        fixture = """
import sys
import warnings
sys.path.insert(0, sys.argv[1])
import worker

def request():
    print('stdout fixture')
    print('stderr fixture', file=sys.stderr)
    warnings.warn('warning fixture')
    return {'status': 'passed'}

worker._request = request
worker.main()
"""
        self.assertEqual(run_worker(None, fixture), {"status": "passed"})

    def test_ignores_alarm_delivered_after_verification(self):
        fixture = """
import signal
import sys
sys.path.insert(0, sys.argv[1])
import worker

verify = worker._verify
timed_out = worker._timed_out
delivered = False

def observe_alarm(number, frame):
    global delivered
    delivered = True
    timed_out(number, frame)

def verify_then_alarm(source, problem):
    result = verify(source, problem)
    signal.setitimer(signal.ITIMER_REAL, 0.000001)
    while not delivered:
        pass
    return result

worker._timed_out = observe_alarm
worker._verify = verify_then_alarm
worker.main()
"""
        self.assertEqual(run_worker({
            "mode": "verify", "source": "def tag(n):\n    return n + 4",
            "assertions": ["assert tag(23) == 27"],
        }, fixture), {"status": "passed"})

    def test_unexpected_worker_failure_uses_a_fixed_response(self):
        fixture = """
import sys
sys.path.insert(0, sys.argv[1])
import worker

def request():
    raise RuntimeError('fixture failure')

worker._request = request
worker.main()
"""
        self.assertEqual(run_worker(None, fixture), {"status": "failed", "reason": "internal-error"})

    def test_fail_closed_when_seccomp_is_missing(self):
        fixture = """
import sys
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import worker
with patch('isolation.ctypes.CDLL', side_effect=OSError):
    worker.main()
"""
        with TemporaryDirectory(prefix="mohassan-python-test-") as temp:
            result = subprocess.run(
                [*PYTHON, "-c", fixture, str(WORKER.parent)], cwd=temp, env={},
                input="not read", capture_output=True, text=True, timeout=5, check=True,
            )
        self.assertEqual(json.loads(result.stdout), {
            "status": "unavailable", "reason": "isolation-unavailable",
        })


if __name__ == "__main__":
    unittest.main()
