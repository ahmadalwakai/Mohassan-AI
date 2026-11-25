"""Exercise collection productions under the same syntax and scope as the verifier."""

import json
from pathlib import Path
import subprocess
import sys
import unittest


SYNTHESIS_PATH = Path(__file__).resolve().parents[1] / "apps/server/src/assistant/test-driven-coding"
sys.path.insert(0, str(SYNTHESIS_PATH))
from assertions import compile_candidate, parse_assertions, python_scope
from collection_rules import collection_rules
from synthesis import _render, rule


class CollectionProductionTest(unittest.TestCase):
    productions = {production.template.template: production for production in collection_rules(rule)}

    def check_rule(self, template, examples):
        production = self.productions[template]
        assertion_sources = []
        for arguments, expected in examples:
            actual = production.evaluate(*arguments)
            self.assertIs(type(actual), type(expected))
            self.assertEqual(actual, expected)
            arguments_source = ", ".join(map(repr, arguments))
            assertion_sources.append(f"assert transform({arguments_source}) == {expected!r}")
        parameters = ("source", "option", "extra")[:len(production.kinds)]
        expression = production.template.substitute(dict(zip("abc", parameters)))
        source = _render("transform", parameters, expression, production.imports)
        problem = parse_assertions(assertion_sources)
        scope = python_scope(self.fail)
        exec(compile_candidate(source, problem), scope)
        for assertion in problem.assertions:
            exec(assertion.code, scope)

    def test_keyed_ordering_and_nested_transforms(self):
        examples = {
            "sorted($a, key=sum)": [(([[14, -8], [3], [4, 0]],), [[3], [4, 0], [14, -8]])],
            "sorted($a, key=lambda item: item.casefold())": [((['Maple', 'elm', 'Ash'],), ['Ash', 'elm', 'Maple'])],
            "sorted($a, key=lambda item: item[$b])": [(([(7, 2, 14), (8, 3, -9)], 2), [(8, 3, -9), (7, 2, 14)])],
            "[sorted(item) for item in $a]": [(([[9, -7, 4], [], [6, 2]],), [[-7, 4, 9], [], [2, 6]])],
            "[tuple(sorted(item)) for item in $a]": [(([(8, 3), (3, 8), (5, -8)],), [(3, 8), (3, 8), (-8, 5)])],
            "max(((len(item), item) for item in $a), key=lambda pair: pair[0])": [(([[7], [8, 4], [9, 3]],), (2, [8, 4]))],
            "[item[$b] for item in $a]": [(([(9, 5), (8, 3)], -1), [5, 3])],
            "[item[:$b] for item in $a]": [(([(9, 5, 8), (8, 3, 4)], 2), [(9, 5), (8, 3)])],
            "[item[$b:] for item in $a]": [(([(9, 5, 8), (8, 3, 4)], 2), [(8,), (4,)])],
            "[item for item in $a if len(item) == $b]": [((['tint', 'copper', 'mica'], 4), ['tint', 'mica'])],
            "[item for item in $a if len(item) > $b]": [((['tint', 'copper', 'mica'], 4), ['copper'])],
            "[item for item in $a if all(value % $b == 0 for value in item)]": [(([(9, 27), (8, 3), (54, 81)], 9), [(9, 27), (54, 81)])],
        }
        for template, cases in examples.items():
            with self.subTest(template=template):
                self.check_rule(template, cases)

    def test_collection_membership_count_and_merge(self):
        examples = {
            "all(item == $b for item in $a)": [(((25, 25), 25), True), (([25, 26], 25), False)],
            "sum(item in $b for item in $a)": [(((5, 2, 5, 8), {5, 8}), 3)],
            "[item for item in $a if item not in $b]": [(([4, 8, 6, 4], (8, 6)), [4, 4])],
            "[value for item in $a for value in ($b, item)]": [(([4, 6], 'beam'), ['beam', 4, 'beam', 6])],
            "min($a, key=$a.count)": [(("dappled",), "a"), (((7, 4, 5, 4, 5, 7, 8),), 8)],
            "sum(item > 0 for item in $a)": [(([-9, 3, 0, 8, 7],), 3)],
            "sum(item for index, item in enumerate($a) if index % 2 == item % 2 == 0)": [(([16, 4, 3, 4, 12],), 28)],
            "sorted([*$a, *$b, *$c])": [(([9, 4], [5], [-2, 9]), [-2, 4, 5, 9, 9])],
            "{**$a, **$b, **$c}": [(({'oak': 4}, {'ash': -3, 'oak': 9}, {'ash': 8}), {'oak': 9, 'ash': 8})],
            "len(set($a.values()))": [(({'gap': 11, 'rim': 17, 'width': 11},), 2), (({},), 0)],
            "{key: value for key, value in $a.items() if value}": [(({'gap': 11, 'rim': '', 'slot': []},), {'gap': 11})],
            "($b in $a, $a.index($b) if $b in $a else -1)": [(([7, 4, 9, 4], 4), (True, 1)), (([31, 45], 40), (False, -1))],
            "$a[$b - 1]": [(((81, 93, 44), 1), 81), (("limestone", 3), "m")],
        }
        for template, cases in examples.items():
            with self.subTest(template=template):
                self.check_rule(template, cases)

    def test_splitting_keeps_direction_and_delimiters(self):
        examples = {
            "($a[:$b], $a[$b:])": [((['clip', 'brace', 'rib'], -1), (['clip', 'brace'], ['rib']))],
            "$a[$b::$c]": [(("steel beam", 3, 2), "e em"), (((8, 6, 3, 1, 7, 5), -2, -2), (7, 3, 8))],
            "[$a[offset::$b] for offset in range($b)]": [((list(range(7)), 3), [[0, 3, 6], [1, 4], [2, 5]])],
            "[$a[offset:offset + $b] for offset in range(0, len($a), $b)]": [((tuple(range(7)), 3), [(0, 1, 2), (3, 4, 5), (6,)])],
            "$a.partition($b)": [(("kiln+glass+clay", "+"), ("kiln", "+", "glass+clay"))],
            "$a.rpartition($b)": [(("kiln+glass+clay", "+"), ("kiln+glass", "+", "clay"))],
            "$a.rsplit($b, $c)": [(("kiln+glass+clay", "+", 1), ["kiln+glass", "clay"])],
            "$a.split($b, $c)": [
                (("kiln+glass+clay", "+", 1), ["kiln", "glass+clay"]),
                (("kiln+glass", "+", 0), ["kiln+glass"]),
            ],
        }
        for template, cases in examples.items():
            with self.subTest(template=template):
                self.check_rule(template, cases)

    def test_rendering_mixed_values_and_bounded_templates(self):
        examples = {
            "''.join(item for item in $a if item not in $b)": [(("stonework", "tok"), "snewr")],
            "(lambda parts: parts[0] + ''.join(part.capitalize() for part in parts[1:]))($a.rsplit($b))": [
                (("faint.glass.rod", "."), "faintGlassRod"), (("undivided", "."), "undivided"),
            ],
            "''.join(part.capitalize() for part in $a.rsplit($b))": [(("faint.glass.rod", "."), "FaintGlassRod")],
            "tuple(item for item in $a if not item.isspace())": [(("ch\te s\ns",), ('c', 'h', 'e', 's', 's'))],
            "$a.join(str(item) for item in $b)": [(("|", (5, 'peg', -7)), "5|peg|-7")],
            r"[re.sub(r'\{\{|\}\}|\{0?\}', lambda token: token.group()[0] if token.group() in ('{{', '}}') else str(item), $b) for item in $a]": [
                (([71, 'clay'], 'brace:{{{0}}}'), ['brace:{71}', 'brace:{clay}']),
                ((['{0}'], 'tag={}'), ['tag={0}']),
                (([7], '{0.__class__}'), ['{0.__class__}']),
            ],
            "f'{${a}:.{${b}}f}'": [((3.1427, 3), "3.143"), ((-.17, 0), "-0")],
        }
        for template, cases in examples.items():
            with self.subTest(template=template):
                self.check_rule(template, cases)

    def test_selects_tokens_by_case_insensitive_prefix(self):
        texts = ("Mica pottery\tmisfit", "OXIDE  mine", "", "millstone Lima")
        matching = ("Mica", "misfit", "mine", "millstone")
        for container in (list, tuple):
            with self.subTest(container=container):
                self.check_rule(
                    f"{container.__name__}(token for line in $a for token in line.split() if token.casefold().startswith($b.casefold()))",
                    [((texts, "Mi"), container(matching)), ((texts, "unlisted"), container())],
                )

    def test_elementwise_operators_preserve_container_type(self):
        self.check_rule(
            "tuple(left + right for left, right in zip($a, $a[1:]))",
            [(((8, -2, 9, 4),), (6, 7, 13)), (((),), ())],
        )
        results = {"+": (19, 5), "-": (11, 1), "*": (60, 6), "&": (4, 2), "^": (11, 1)}
        for container in (list, tuple):
            for symbol, result in results.items():
                with self.subTest(container=container, symbol=symbol):
                    self.check_rule(
                        f"{container.__name__}(left {symbol} right for left, right in zip($a, $b))",
                        [((container((15, 3, 61)), container((4, 2))), container(result))],
                    )


@unittest.skipUnless(sys.platform == "linux", "The worker sandbox requires Linux")
class CollectionWorkerTest(unittest.TestCase):
    def solve(self, description, assertions):
        worker = subprocess.run(
            [sys.executable, "-I", "-B", "-S", str(SYNTHESIS_PATH / "worker.py")],
            input=json.dumps({"mode": "solve", "description": description, "assertions": assertions}),
            text=True, capture_output=True, check=True, timeout=2.5,
        )
        return json.loads(worker.stdout)

    def test_orders_batches_by_their_totals(self):
        result = self.solve("Order each batch by the total of its items.", [
            "assert order_batches([[15, -6], [2, 4], [3, 2]]) == [[3, 2], [2, 4], [15, -6]]",
            "assert order_batches([[8, 2], [18, -11], [7, -8]]) == [[7, -8], [18, -11], [8, 2]]",
            "assert all(len(row) == 2 for row in order_batches([[51, 17], [11, 27]]))",
        ])
        self.assertEqual(result["status"], "passed", result)
        self.assertIn("key=sum", result["source"])

    def test_splits_using_the_original_assertions(self):
        examples = [
            "assert fields('oak..elm', '.', 1) == ['oak', '.elm']",
            "assert fields('cedar_ash', '_', 0) == ['cedar_ash']",
            "assert fields('fence,hedge,wall,gate', ',', 2) == ['fence', 'hedge', 'wall,gate']",
            "assert len(fields('pearl/ruby/coral', '/', 2)) == 3",
        ]
        description = "Split from the left, up to the given limit."
        result = self.solve(description, examples)
        self.assertEqual(result["status"], "passed", result)
        self.assertIn(".split(arg2, arg3)", result["source"])
        failure = self.solve(description, [*examples, "assert len(fields('oak..elm', '.', 1)) < 2"])
        self.assertEqual(failure["status"], "failed", failure)
        self.assertNotIn("source", failure)


if __name__ == "__main__":
    unittest.main()
