"""Check numeric productions and the full isolated assertion gate."""

import sys
import unittest

from test_test_driven_coding import WORKER, run_worker


sys.path.insert(0, str(WORKER.parent))
from numeric_productions import _divisors, numeric_rules
from synthesis import _render, rule


@unittest.skipUnless(sys.platform == "linux", "seccomp is a Linux backend")
class NumericSynthesisTest(unittest.TestCase):
    productions = {production.template.template: production for production in numeric_rules(rule)}

    def check_productions(self, cases):
        for template, arguments, expected in cases:
            with self.subTest(template=template):
                production = self.productions[template]
                self.assertEqual(production.evaluate(*arguments), expected)
                parameters = ("sample", "option", "extra")[:len(arguments)]
                expression = production.template.substitute(dict(zip("abc", parameters)))
                source = _render("numeric_result", parameters, expression, production.imports)
                argument_text = ", ".join(map(repr, arguments))
                assertion = f"assert numeric_result({argument_text}) == {expected!r}"
                receipt = run_worker({"mode": "verify", "source": source, "assertions": [assertion]})
                self.assertEqual(receipt, {"status": "passed"})

    def test_arithmetic_and_math(self):
        self.check_productions([
            ("$a * $b * $c", (-7, 8, 9), -504),
            ("min($a, $b, $c)", (22, -9, 3), -9),
            ("max($a, $b, $c)", (4, 7.5, 6), 7.5),
            ("sorted(($a, $b, $c))[1]", (81, -7, 24), 24),
            ("($a + $b) / 2", (-11, 32), 10.5),
            ("$a * $b / 2", (19, 7), 66.5),
            ("math.hypot($a, $b)", (7, -24), 25.0),
            ("math.isqrt($a)", (923,), 30),
            ("math.comb($a, $b)", (9, 6), 84),
            ("math.perm($a, $b)", (7, 3), 210),
            ("$a * ($a + 1) // 2", (21,), 231),
            ("$a % $b == $c", (37, 6, 1), True),
            ("$a % $b != $c", (42, 7, 0), False),
        ])

    def test_numeric_collections(self):
        divisors = _divisors("$a")
        self.check_productions([
            ("max($a) - min($a)", ([41, 13, -7],), 48),
            ("max($a) + min($a)", ((8, -19, 14),), -5),
            ("min(item for item in $a if isinstance(item, (int, float)) and not isinstance(item, bool))", ([True, 9, 'ore', 4.5],), 4.5),
            ("max(item for item in $a if isinstance(item, (int, float)) and not isinstance(item, bool))", (['ore', False, -9, -4.5],), -4.5),
            (f"sorted({divisors})", (49,), [1, 7, 49]),
            (f"sum({divisors})", (81,), 121),
            (f"sum(factor for factor in {divisors} if factor % $b == 0)", (72, 4), 156),
            ("sum(item ** $b for item in range(1, $a + 1))", (6, 4), 2275),
            ("sum((item * $b) ** $c for item in range(1, $a + 1))", (3, 7, 2), 686),
            ("sum((item * $b + 1) ** $c for item in range($a))", (3, 5, 2), 158),
            ("[item ** $b for item in $a]", ([-7, 2, 0], 3), [-343, 8, 0]),
            ("[sum(int(digit) for digit in str(abs(item))) for item in $a]", ((89, -902, 1),), [17, 11, 1]),
        ])

    def test_digits_and_bits(self):
        self.check_productions([
            ("int(str(abs($a))[$b])", (-3527, 1), 5),
            ("int(str(abs($a))[::-1]) * (-1 if $a < 0 else 1)", (-9320,), -239),
            ("~$a", (36,), -37),
            ("$a & ($a - 1)", (44,), 40),
            ("$a > 0 and $a & ($a - 1) == 0", (0,), False),
            ("1 << ($a.bit_length() - 1) if $a else 0", (109,), 64),
            ("1 << ($a - 1).bit_length() if $a > 1 else 1", (109,), 128),
            ("$a | sum(1 << bit for bit in range($b % 2, $a.bit_length(), 2))", (65, 1), 107),
            ("f'{$a:b}'", (-29,), "-11101"),
            ("f'{$a:x}'", (238,), "ee"),
            ("int($a, $b)", ("cafe", 16), 51966),
        ])

    def test_synthesizes_numeric_productions_with_full_assertions(self):
        cases = (
            ("Total the positive divisors of this positive integer.", [
                "assert factor_total(63) == 104",
                "assert factor_total(28) == 56",
                "assert tuple([factor_total(49)]) == (57,)",
            ]),
            ("Serialize the input integer in hexadecimal notation.", [
                "assert encode_pin(274) == '112'",
                "assert encode_pin(111) == '6f'",
                "assert len(encode_pin(164)) == 2",
            ]),
        )
        for description, assertions in cases:
            with self.subTest(description=description):
                receipt = run_worker({"mode": "solve", "description": description, "assertions": assertions})
                self.assertEqual(receipt["status"], "passed", receipt)
                self.assertEqual(run_worker({
                    "mode": "verify", "source": receipt["source"], "assertions": assertions,
                }), {"status": "passed"})


if __name__ == "__main__":
    unittest.main()
