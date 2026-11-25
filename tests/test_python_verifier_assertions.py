"""Integration checks for the verifier's bounded Python assertion subset."""

import sys
import time
import unittest

from test_test_driven_coding import run_worker


@unittest.skipUnless(sys.platform == "linux", "seccomp is a Linux backend")
class VerifierAssertionTests(unittest.TestCase):
    def verify(self, source, assertion):
        return run_worker({"mode": "verify", "source": source, "assertions": [assertion]})

    def test_expensive_operations_fail_quickly(self):
        statements = (
            "return range(0, n, 2)",
            "return range(n * n * n * n)",
            "return math.factorial(n)",
            "from math import comb as choose\n    return choose(n, 2)",
            "return math.perm(n)",
            "return 2 ** n",
            "return pow(2, n)",
            "return pow(2, n, 17)",
            "return 1 << n",
            "value = 1\n    value <<= n\n    return value",
            "items = [2]\n    items[0] **= n\n    return items[0]",
        )
        for body in statements:
            with self.subTest(body=body):
                start = time.perf_counter()
                result = self.verify(f"def checked(n):\n    {body}", "assert checked(1000000) is not None")
                self.assertEqual(result, {"status": "failed", "reason": "assertion-error", "assertionIndex": 0})
                self.assertLess(time.perf_counter() - start, 1.25)

    def test_guards_assertion_and_example_expression_operators(self):
        result = self.verify("def checked(n):\n    return n", "assert checked(2) == (1 << 1000000)")
        self.assertEqual(result, {"status": "failed", "reason": "assertion-error", "assertionIndex": 0})
        result = run_worker({
            "mode": "solve", "description": "Return a power.",
            "assertions": ["assert checked(2) == 2 ** 1000000"],
        })
        self.assertEqual(result, {"status": "failed", "reason": "no-supported-examples", "tried": 0})

    def test_small_operations_and_augmented_assignment_order(self):
        source = """def checked(n):
    seen = []
    items = [2]
    def index():
        seen.append(1)
        return 0
    def exponent():
        seen.append(2)
        items[0] = 5
        return n
    items[index()] **= exponent()
    value = 2
    value <<= n
    return items[0], value, seen, list(range(n)), math.comb(n, 2), math.perm(n), math.factorial(n)
"""
        self.assertEqual(self.verify(
            source, "assert checked(3) == (8, pow(4, 2), [1, 2], [0, 1, 2], 3, 6, 6)",
        ), {"status": "passed"})

    def test_rejects_names_reserved_for_operator_guards(self):
        self.assertEqual(self.verify(
            "def checked(n):\n    return __verifier_left_shift(1, n)", "assert checked(3) == 8",
        )["reason"], "unsupported-candidate")
        self.assertEqual(self.verify(
            "def checked(n):\n    return n", "assert checked(3) == __verifier_power(3, 1)",
        )["reason"], "unsupported-assertion")

    def test_regex_flags_in_keyword_and_positional_arguments(self):
        self.assertEqual(self.verify(
            "from re import search\ndef checked(text):\n    return bool(search('a.b', text, re.IGNORECASE | re.DOTALL))",
            "assert checked('A\\nB')",
        ), {"status": "passed"})
        for expression in (
            "re.compile('a', 128)", "re.search('a', 'a', flags=128)",
            "re.split('a', 'a', 0, 128)", "re.sub('a', 'b', 'a', 0, 128)",
        ):
            with self.subTest(expression=expression):
                result = self.verify("def checked(n):\n    return n", f"assert checked(3) and {expression}")
                self.assertEqual(result, {"status": "failed", "reason": "assertion-error", "assertionIndex": 0})

    def test_rejects_assertion_bindings_that_shadow_the_entry_name(self):
        for assertion in (
            "assert (lambda checked: checked(1))(lambda n: n) == 1",
            "assert [checked(1) for checked, marker in [(lambda n: n, 0)]] == [1]",
        ):
            with self.subTest(assertion=assertion):
                result = self.verify("def checked(n):\n    return 0", assertion)
                self.assertEqual(result, {"status": "failed", "reason": "unsupported-assertion", "assertionIndex": 0})

    def test_rejects_candidate_module_binding_that_replaces_the_entry(self):
        self.assertEqual(self.verify(
            "def checked(n):\n    return 0\nfrom math import factorial as checked",
            "assert checked(3) == 6",
        ), {"status": "failed", "reason": "unsupported-candidate"})


if __name__ == "__main__":
    unittest.main()
