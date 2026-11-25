"""Independent examples for the typed candidate iterator."""

from pathlib import Path
import sys
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps/server/src/assistant/test-driven-coding"))
from synthesis import synthesize


def run_examples(name, source, examples):
    namespace = {}
    exec(source, namespace)
    return all(namespace[name](*arguments) == expected for arguments, expected in examples)


class PythonSynthesisTest(unittest.TestCase):
    def check_synthesis(self, name, description, examples, expected_fragment):
        observed = []

        def verify(source):
            observed.append(source)
            return run_examples(name, source, examples)

        candidate = synthesize(name, description, examples, verify)
        self.assertIsNotNone(candidate)
        self.assertEqual(observed[-1], candidate)
        self.assertIn(expected_fragment, candidate)
        self.assertTrue(run_examples(name, candidate, examples))

    def test_composes_numeric_operators(self):
        self.check_synthesis(
            "gap", "Find the absolute difference of two measurements.",
            [((91, 123), 32), ((74, 52), 22), ((-17, 17), 34)], "abs(arg1 - arg2)",
        )

    def test_text_and_slicing(self):
        self.check_synthesis(
            "tail_upper", "Uppercase the characters after the leading character.",
            [(('rGlue-4',), 'GLUE-4'), (('aOpal7',), 'OPAL7'), (('neon',), 'EON')], "[1:]",
        )

    def test_sorting_and_counting(self):
        self.check_synthesis(
            "ordered_lengths", "Sort strings by length.",
            [((['bird', 'z', 'quail'],), ['z', 'bird', 'quail']),
             ((['ab', 'a', 'ice', 'be'],), ['a', 'ab', 'be', 'ice'])], "key=len",
        )
        self.check_synthesis(
            "histogram", "Build an occurrence count dictionary for every item.",
            [((['rim', 'rim', 'pearl', 'pearl', 'pearl'],), {'rim': 2, 'pearl': 3}),
             (([-1, -1, 54, 4, 54],), {-1: 2, 54: 2, 4: 1})], ".count(item)",
        )

    def test_tuple_set_and_dictionary_building_blocks(self):
        self.check_synthesis(
            "paired", "Make a tuple of the two inputs.",
            [((17, 'opal'), (17, 'opal')), ((-5, 'plaid'), (-5, 'plaid'))], "return (arg1, arg2)",
        )
        self.check_synthesis(
            "shared", "Find the intersection of the sets.",
            [(({4, 6}, {6, 12}), {6}), (({'b', 'c'}, {'d', 'b'}), {'b'})], "arg1 & arg2",
        )
        self.check_synthesis(
            "exchanged", "Invert the dictionary, swapping the keys and values.",
            [(({'wire': 31, 'lever': 11},), {31: 'wire', 11: 'lever'}),
             (({'pipe': 75},), {75: 'pipe'})], "for key, value in arg1.items()",
        )

    def test_comprehension_and_regex(self):
        self.check_synthesis(
            "adjust", "Multiply each list element by the given scale.",
            [(([2, 3], 4), [8, 12]), (([0, 9, -1], 2), [0, 18, -2]), (([], 3), [])], "for item in arg1",
        )
        self.check_synthesis(
            "number_groups", "Use a regular expression to extract groups of digits.",
            [(('m31|h976',), ['31', '976']), (('gap5gap29',), ['5', '29']), (('toad',), [])], "re.findall",
        )

    def test_simple_recursion(self):
        self.check_synthesis(
            "seed_ladder", "Recursively calculate a Fibonacci value.",
            [((7,), 13), ((9,), 34), ((15,), 610), ((2,), 1)], "else seed_ladder(",
        )

    def test_candidate_size_and_full_assertions_gate(self):
        examples = [((13,), 13)]
        all_assertions = [*examples, ((-21,), 21)]
        attempted = []

        def verify(source):
            attempted.append(source)
            return run_examples("distance", source, all_assertions)

        chosen = synthesize("distance", "Take the absolute value.", examples, verify)
        self.assertTrue(attempted[0].endswith("return arg1\n"))
        self.assertTrue(chosen.endswith("return abs(arg1)\n"))
        self.assertEqual(len(attempted), 2)

    def test_failed_search_reports_an_assertion_trial_and_returns_no_code(self):
        examples = [((17,), 'blue lamp / green desk'), ((22,), 'white bowl / empty chair')]
        attempted = []

        def verify(source):
            attempted.append(source)
            return run_examples("unspecified", source, examples)

        self.assertIsNone(synthesize("unspecified", "Compute the result.", examples, verify))
        self.assertEqual(len(attempted), 1)
        self.assertFalse(run_examples("unspecified", attempted[0], examples))

    def test_no_examples_or_inconsistent_arity_cannot_verify(self):
        def verify(_source):
            self.fail("No complete example set was parsed")

        self.assertIsNone(synthesize("unseen", "Compute the result.", [], verify))
        self.assertIsNone(synthesize("unseen", "Compute the result.", [((2,), 1), ((2, 3), 2)], verify))

    def test_contradictory_examples_fail_after_a_concrete_attempt(self):
        examples = [((71,), 19), ((71,), 23)]
        attempted = []

        def verify(source):
            attempted.append(source)
            return run_examples("dial", source, examples)

        self.assertIsNone(synthesize("dial", "Find a value for the dial.", examples, verify))
        self.assertEqual(len(attempted), 1)


if __name__ == "__main__":
    unittest.main()
