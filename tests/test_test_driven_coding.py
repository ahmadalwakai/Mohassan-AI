"""Integration tests for Python assertions and the isolated verifier process."""

import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest


WORKER = Path(__file__).resolve().parents[1] / "apps/server/src/assistant/test-driven-coding/worker.py"
PYTHON = [sys.executable, "-I", "-B", "-S"]


def run_worker(payload):
    with TemporaryDirectory(prefix="mohassan-python-test-") as temp:
        result = subprocess.run(
            [*PYTHON, str(WORKER)], input=json.dumps(payload), cwd=temp,
            env={}, capture_output=True, text=True, timeout=5, check=True,
        )
        if list(Path(temp).iterdir()):
            raise AssertionError("the sandbox directory is no longer empty")
    if result.stderr:
        raise AssertionError(result.stderr)
    return json.loads(result.stdout)


@unittest.skipUnless(sys.platform == "linux", "seccomp is a Linux backend")
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
            "assertionIndex": 1, "assertion": "assert tag(9) == 15",
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
        self.assertEqual(result["assertion"], assertions[result["assertionIndex"]])
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

    def test_kernel_denies_file_network_and_child_process_operations(self):
        # The trusted fixture exercises the system filter separately from the AST checks.
        fixture = """
import errno
import os
import socket
import sys
sys.path.insert(0, sys.argv[1])
from isolation import isolate
isolate()
for operation in (
    lambda: os.open('result.txt', os.O_WRONLY | os.O_CREAT),
    lambda: socket.socket(),
    os.fork,
):
    try:
        operation()
    except OSError as error:
        if error.errno != errno.EPERM:
            raise SystemExit(2)
    else:
        raise SystemExit(3)
print('denied')
"""
        with TemporaryDirectory(prefix="mohassan-python-test-") as temp:
            result = subprocess.run(
                [*PYTHON, "-c", fixture, str(WORKER.parent)], cwd=temp, env={},
                capture_output=True, text=True, timeout=5, check=True,
            )
            self.assertEqual(result.stdout, "denied\n")
            self.assertEqual(list(Path(temp).iterdir()), [])

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
