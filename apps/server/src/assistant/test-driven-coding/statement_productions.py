"""Typed loop and recursive candidates for stateful Python computations."""

from dataclasses import dataclass
from functools import partial
from string import Template
from textwrap import dedent, indent

from assertions import Problem, UnsupportedSyntax, compile_candidate, python_scope


@dataclass(frozen=True)
class Statement:
    kinds: tuple[str, ...]
    result: str
    template: Template
    words: frozenset[str]
    index_limit: int | None = None
    sequence_limit: int | None = None


def _statement(kinds, result, body, words, *, index_limit=None, sequence_limit=None):
    return Statement(
        tuple(kinds.split()), result, Template(dedent(body).strip()),
        frozenset(words.split()), index_limit, sequence_limit,
    )


def _scan(seed, operator, words):
    return _statement("sequence", "list", f"""
        result = []
        state = {seed}
        for item in $a:
            state = state {operator} item
            result.append(state)
        return result
    """, f"prefix cumulative running scan {words}")


def _linear_recurrence(first, second, words):
    return _statement("nonnegative-integer", "number", f"""
        previous, current = {first}, {second}
        for index in range($a):
            previous, current = current, previous + current
        return previous
    """, words, index_limit=128)


def _increasing_subsequence(contribution, words):
    return _statement("sequence", "number", f"""
        scores = []
        for index, item in enumerate($a):
            weight = {contribution}
            best = weight
            for earlier in range(index):
                if $a[earlier] < item:
                    best = max(best, scores[earlier] + weight)
            scores.append(best)
        return max(scores, default=0)
    """, f"increasing subsequence {words}", sequence_limit=128)


def _nested_leaves(result_kind, returned, words):
    return _statement("sequence", result_kind, f"""
        def append_leaves(items, result):
            for item in items:
                if isinstance(item, (list, tuple)):
                    append_leaves(item, result)
                else:
                    result.append(item)
        result = []
        append_leaves($a, result)
        return {returned}
    """, f"nested deep recursion recursive recursively {words}")

STATEMENTS = (
    _scan(0, "+", "sum total addition"),
    _scan(1, "*", "product multiply"),
    _scan(0, "^", "xor bitwise"),
    _statement("sequence", "number", """
        if not $a:
            return 0
        ending = best = $a[0]
        for item in $a[1:]:
            ending = max(item, ending + item)
            best = max(best, ending)
        return best
    """, "maximum largest contiguous subarray sum"),
    _increasing_subsequence("1", "longest length count"),
    _increasing_subsequence("item", "maximum sum total"),
    _linear_recurrence(0, 1, "fibonacci recurrence sequence"),
    _linear_recurrence(2, 1, "lucas recurrence sequence"),
    _statement("nonnegative-integer", "number", """
        row = [1]
        for index in range($a):
            next_row = [row[-1]]
            for item in row:
                next_row.append(next_row[-1] + item)
            row = next_row
        return row[0]
    """, "bell partitions sets triangle recurrence", index_limit=64),
    _statement("nonnegative-integer nonnegative-integer", "number", """
        if $b >= $a:
            return int($a == $b == 0)
        row = [1] + [0] * $b
        for width in range(1, $a + 1):
            for index in range(min(width - 1, $b), 0, -1):
                row[index] = (index + 1) * row[index] + (width - index) * row[index - 1]
        return row[$b]
    """, "eulerian permutations ascents descents triangle recurrence", index_limit=64),
    _statement("nonnegative-integer nonnegative-integer", "number", """
        if $b > $a:
            return 0
        row = [1] + [0] * $b
        for width in range(1, $a + 1):
            for index in range(min(width, $b), 0, -1):
                row[index] = index * row[index] + row[index - 1]
            row[0] = 0
        return row[$b]
    """, "stirling partitions subsets triangle recurrence", index_limit=64),
    _statement("integer", "number", """
        if $a < 0:
            return $entry(-$a)
        if $a < 10:
            return $a
        return $a % 10 + $entry($a // 10)
    """, "sum digits decimal recursion recursive recursively", index_limit=(1 << 256) - 1),
    _nested_leaves("list", "result", "flatten"),
    _nested_leaves("number", "sum(result)", "sum total add"),
)


def _bounded_call(function, index_limit, sequence_limit, *arguments):
    if index_limit is not None and any(abs(value) > index_limit for value in arguments):
        raise ValueError("statement index outside search bounds")
    if sequence_limit is not None and len(arguments[0]) > sequence_limit:
        raise ValueError("statement sequence outside search bounds")
    return function(*arguments)


def statement_programs(name, parameters, argument_types, expected_types, words):
    """Yield typed sources and deferred example evaluators in description order."""
    ranked = sorted(STATEMENTS, key=lambda statement: -len(statement.words & words))
    bindings = dict(zip(("a", "b"), parameters), entry=name)
    problem = Problem(name, len(parameters), ())
    for statement in ranked:
        if len(statement.kinds) != len(parameters) or statement.result not in expected_types:
            continue
        if any(kind not in types for kind, types in zip(statement.kinds, argument_types)):
            continue
        if "fibonacci" in statement.words and words & {"recursive", "recursively", "recursion"}:
            # Leave explicit recursion requests to the recursive production.
            continue
        body = statement.template.substitute(bindings)
        source = f"def {name}({', '.join(parameters)}):\n{indent(body, '    ')}\n"
        scope = python_scope(lambda *_args: None)
        try:
            exec(compile_candidate(source, problem), scope)
        except UnsupportedSyntax:
            continue
        evaluate = partial(_bounded_call, scope[name], statement.index_limit, statement.sequence_limit)
        yield source, evaluate
