"""Exercise loop and recursive synthesis in the isolated Python worker."""

from math import comb, factorial
import sys
import unittest

from test_test_driven_coding import WORKER, run_worker


sys.path.insert(0, str(WORKER.parent))
from statement_productions import statement_programs


@unittest.skipUnless(sys.platform == "linux", "seccomp is a Linux backend")
class StatementSynthesisTests(unittest.TestCase):
    def check_program(self, name, description, examples, statement):
        assertions = [f"assert {name}{args!r} == {expected!r}" for args, expected in examples]
        result = run_worker({"mode": "solve", "description": description, "assertions": assertions})
        self.assertEqual(result["status"], "passed", result)
        self.assertIn(statement, result["source"])
        self.assertEqual(
            run_worker({"mode": "verify", "source": result["source"], "assertions": assertions}),
            {"status": "passed"},
        )
        return result["source"]

    def test_running_scans(self):
        for operation, expected, second in (
            ("sum", [4, 10, 13, 20], [9, 11, 16]),
            ("product", [4, 24, 72, 504], [9, 18, 90]),
            ("xor", [4, 2, 1, 6], [9, 11, 14]),
        ):
            with self.subTest(operation=operation):
                self.check_program(
                    "meter_snapshots", f"Scan the readings and keep the running {operation}.",
                    [(([4, 6, 3, 7],), expected), (([9, 2, 5],), second), (([],), [])],
                    "result.append(state)",
                )

    def test_contiguous_and_increasing_aggregation(self):
        for description, expected, statement in (
            ("Find the maximum contiguous sum of the readings.", (31, -1, 0), "ending + item"),
            ("Find the length of the longest increasing subsequence.", (4, 1, 0), "scores[earlier]"),
            ("Find the maximum sum of an increasing subsequence.", (22, -1, 0), "scores[earlier]"),
        ):
            with self.subTest(description=description):
                batches = ([8, 2, 5, 1, 6, 9], [-1, -8, -10], [])
                self.check_program(
                    "select_readings", description,
                    [((batch,), value) for batch, value in zip(batches, expected)], statement,
                )

    def test_linear_recurrence(self):
        for sequence, index_values in (
            ("Fibonacci", [(13, 233), (17, 1597), (24, 46368)]),
            ("Lucas", [(13, 521), (17, 3571), (24, 103682)]),
        ):
            with self.subTest(sequence=sequence):
                self.check_program(
                    "sequence_index", f"Find a term of the {sequence} recurrence.",
                    [((index,), value) for index, value in index_values], "previous + current",
                )

    def test_rolling_triangles(self):
        partitions = [1]
        for index in range(13):
            partitions.append(sum(comb(index, column) * partitions[column] for column in range(index + 1)))
        self.check_program(
            "group_arrangements", "Return the Bell number for partitioning a labeled group.",
            [((index,), partitions[index]) for index in (8, 11, 13)], "next_row",
        )

        pairs = [(7, 2), (8, 4), (11, 4)]
        eulerian = [
            ((n, k), sum((-1) ** j * comb(n + 1, j) * (k + 1 - j) ** n for j in range(k + 1)))
            for n, k in pairs
        ]
        self.check_program(
            "count_orderings", "Count permutations with the requested ascents using an Eulerian number.",
            eulerian, "width - index",
        )

        stirling = [
            ((n, k), sum((-1) ** j * comb(k, j) * (k - j) ** n for j in range(k + 1)) // factorial(k))
            for n, k in pairs
        ]
        self.check_program(
            "split_groupings", "Count partitions into a given number of groups using a Stirling number.",
            stirling, "index * row[index]",
        )

    def test_recursive_digit_sum_and_nested_traversal(self):
        self.check_program(
            "digit_measure", "Recursively compute the sum of the decimal digits.",
            [((92754,), 27), ((-41692,), 22), ((305,), 8)], "digit_measure(arg1 // 10)",
        )
        self.check_program(
            "collect_leaves", "Recursively flatten a deeply nested list.",
            [(([['a', [3, [[5]]]], 9],), ['a', 3, 5, 9]),
             (([(7,), [], ([3, [[4]]],)],), [7, 3, 4]), (([],), [])], "append_leaves(item, result)",
        )

        self.check_program(
            "combine_readings", "Recursively sum readings in a deeply nested list.",
            [(([8, [-3, [[11]], (2, 6)]],), 24), (([[-4, [1]], (3,)],), 0), (([],), 0)],
            "sum(result)",
        )

    def test_statement_also_needs_unprojected_assertions_to_pass(self):
        result = run_worker({
            "mode": "solve",
            "description": "Calculate a running total of the readings.",
            "assertions": [
                "assert meter_points([3, 5, 6, 2]) == [3, 8, 14, 16]",
                "assert tuple(meter_points([3, 5, 6, 2])) == (3, 8, 14, 17)",
            ],
        })
        self.assertEqual(result["status"], "failed", result)
        self.assertEqual(result["assertionIndex"], 1)
        self.assertNotIn("source", result)

    def test_search_bounds_prevent_large_index_and_quadratic_iterations(self):
        _, evaluate = next(statement_programs(
            "order_count", ("arg1", "arg2"),
            (frozenset({"nonnegative-integer"}), frozenset({"nonnegative-integer"})),
            frozenset({"number"}), frozenset({"eulerian"}),
        ))
        with self.assertRaises(ValueError):
            evaluate(10 ** 9, 10 ** 8)

        _, evaluate = next(statement_programs(
            "increasing_measure", ("arg1",), (frozenset({"sequence"}),),
            frozenset({"number"}), frozenset({"increasing", "subsequence"}),
        ))
        with self.assertRaises(ValueError):
            evaluate([0] * 256)


if __name__ == "__main__":
    unittest.main()
