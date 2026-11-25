"""Bounded typed enumeration of pure Python expressions from input/output examples."""

import ast
from collections import defaultdict
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from itertools import islice, product
import keyword
import math
import re
from string import Template
from time import process_time

from collection_rules import collection_rules
from numeric_productions import numeric_rules
from statement_productions import statement_programs


# The grammar uses the intersection of these types across all observed inputs.
Kind = str
Example = tuple[tuple[object, ...], object]

BASIC_BUILTINS = {
    function.__name__: function for function in (
        abs, all, any, bool, chr, dict, divmod, enumerate, float, int, isinstance, len, list,
        max, min, ord, range, reversed, round, set, sorted, str, sum, tuple, zip,
    )
}
EVALUATION_GLOBALS = {"__builtins__": BASIC_BUILTINS, "math": math, "re": re}
EVALUATION_ERRORS = (ArithmeticError, AttributeError, LookupError, RecursionError, TypeError, ValueError, re.error)
MAX_SIZE = 5
MAX_EVALUATIONS = 18_000
MAX_SEARCH_CPU_SECONDS = 0.5
MAX_PER_RULE_AND_SIZE = 256
MAX_VERIFICATIONS = 24
MAX_COLLECTION_SIZE = 256
MAX_STRING_SIZE = 4096
MAX_VALUE_NODES = 2048


@dataclass(frozen=True)
class Rule:
    kinds: tuple[Kind, ...]
    template: Template
    evaluate: Callable[..., object]
    words: frozenset[str]
    weight: int
    imports: frozenset[str]
    distinct: bool
    result: Kind | None
    commutative: bool


def rule(kinds: str, expression: str, words: str, *, weight=1, imports=(), distinct=False,
         result=None, commutative=False) -> Rule:
    template = Template(expression)
    argument_kinds = tuple(kinds.split())
    parameters = ("a", "b", "c")[:len(argument_kinds)]
    body = template.substitute({name: name for name in parameters})
    evaluate = eval(f"lambda {', '.join(parameters)}: {body}", EVALUATION_GLOBALS)
    return Rule(argument_kinds, template, evaluate, frozenset(words.split()), weight,
                frozenset(imports), distinct, result, commutative)


# Each rule is a typed production. The description only affects order within a
# size, so new combinations are possible without adding a prompt-specific rule.
RULES = (
    rule("number", "abs($a)", "absolute magnitude distance"),
    rule("number", "-$a", "negative opposite negate"),
    rule("number", "round($a)", "round nearest"),
    rule("number", "int($a)", "integer truncate"),
    rule("number", "float($a)", "float decimal"),
    rule("number", "math.floor($a)", "floor lower", imports=("math",)),
    rule("number", "math.ceil($a)", "ceiling upper", imports=("math",)),
    rule("number", "math.sqrt($a)", "square root", imports=("math",)),
    rule("number", "math.log2($a)", "logarithm log base two", imports=("math",)),
    rule("number", "float($a).is_integer()", "whole integer"),
    rule("number", "str($a)", "convert string text digits"),
    rule("integer", "$a.bit_count()", "bit bits count binary set"),
    rule("integer", "$a.bit_length()", "bit bits length binary"),
    rule("integer", "chr($a)", "character code unicode ascii"),
    rule("number number", "$a + $b", "add sum total plus", result="number", commutative=True),
    rule("number number", "$a - $b", "subtract difference minus", distinct=True),
    rule("number number", "$a * $b", "multiply product times area square", result="number", commutative=True),
    rule("number number", "$a / $b", "divide quotient ratio average", distinct=True),
    rule("number number", "$a // $b", "divide quotient floor", distinct=True),
    rule("number number", "$a % $b", "modulo remainder divisible multiple odd even", distinct=True),
    rule("number number", "min($a, $b)", "minimum smaller smallest"),
    rule("number number", "max($a, $b)", "maximum larger largest"),
    rule("number number", "divmod($a, $b)", "division quotient remainder", distinct=True),
    rule("number precision", "round($a, $b)", "round decimals precision places"),
    rule("number small-integer", "$a ** $b", "power exponent raise square cube"),
    rule("integer integer", "math.gcd($a, $b)", "greatest common divisor gcd", imports=("math",)),
    rule("integer integer", "math.lcm($a, $b)", "least common multiple lcm", imports=("math",)),
    rule("small-integer", "math.factorial($a)", "factorial", imports=("math",)),
    rule("integer integer", "$a & $b", "bitwise bit binary and", result="integer", commutative=True),
    rule("integer integer", "$a | $b", "bitwise bit binary or", result="integer", commutative=True),
    rule("integer integer", "$a ^ $b", "bitwise bit binary xor", result="integer", commutative=True),
    rule("integer small-integer", "$a << $b", "shift left bits binary"),
    rule("integer small-integer", "$a >> $b", "shift right bits binary"),
    rule("value value", "$a == $b", "equals equal same exactly", distinct=True, result="boolean", commutative=True),
    rule("value value", "$a != $b", "different unequal distinct", distinct=True, result="boolean", commutative=True),
    rule("number number", "$a < $b", "less below smaller", distinct=True),
    rule("number number", "$a <= $b", "less below at most", distinct=True),
    rule("number number", "$a > $b", "more above greater larger", distinct=True),
    rule("number number", "$a >= $b", "more above at least", distinct=True),
    rule("boolean", "not $a", "not invert false opposite"),
    rule("boolean boolean", "$a and $b", "both and all", distinct=True),
    rule("boolean boolean", "$a or $b", "either or any", distinct=True),
    rule("boolean value value", "$b if $a else $c", "if conditional otherwise else"),
    rule("value", "bool($a)", "boolean truth true false empty"),
    rule("iterable", "len($a)", "length size count number", result="integer"),
    rule("ordered", "list($a)", "convert list elements", result="list"),
    rule("ordered", "tuple($a)", "convert tuple elements", result="tuple"),
    rule("iterable", "set($a)", "convert set distinct unique elements", result="set"),
    rule("ordered", "dict($a)", "convert dictionary mapping", result="dictionary"),
    rule("iterable", "min($a)", "minimum min smallest least"),
    rule("iterable", "max($a)", "maximum max largest greatest"),
    rule("ordered", "sum($a)", "sum total add"),
    rule("ordered", "math.prod($a)", "product multiply total", imports=("math",)),
    rule("iterable", "any($a)", "any some exists true"),
    rule("iterable", "all($a)", "all every each true"),
    rule("iterable", "sorted($a)", "sort sorted order ascending", result="list"),
    rule("iterable", "sorted($a, reverse=True)", "sort sorted order descending reverse", result="list"),
    rule("ordered", "sorted($a, key=len)", "sort sorted length shortest longest", result="list"),
    rule("ordered", "sorted($a, key=abs)", "sort sorted absolute magnitude", result="list"),
    rule("ordered", "max($a, key=len)", "longest length maximum"),
    rule("ordered", "min($a, key=len)", "shortest length minimum"),
    rule("value iterable", "$a in $b", "contains member present includes"),
    rule("value iterable", "$a not in $b", "absent missing excludes"),
    rule("sliceable value", "$a.count($b)", "count occurrences frequency times"),
    rule("sliceable value", "$a.index($b)", "first position index find"),
    rule("sliceable integer", "$a[$b]", "element character index at first last"),
    rule("sliceable integer", "$a[:$b]", "prefix first take slice"),
    rule("sliceable integer", "$a[$b:]", "suffix last skip slice"),
    rule("sliceable integer", "$a[::$b]", "stride every step alternate slice"),
    rule("sliceable integer integer", "$a[$b:$c]", "slice between range substring start end"),
    rule("sliceable", "$a[::-1]", "reverse backwards invert"),
    rule("sliceable small-integer", "$a * $b", "repeat replicate duplicate"),
    rule("list list", "$a + $b", "concatenate extend append join merge combine"),
    rule("tuple tuple", "$a + $b", "concatenate tuple join merge combine"),
    rule("text text", "$a + $b", "concatenate string join combine"),
    rule("text ordered", "$a.join($b)", "join concatenate separator delimit"),
    rule("text", "$a.lower()", "lower lowercase case"),
    rule("text", "$a.upper()", "upper uppercase case"),
    rule("text", "$a.swapcase()", "swap invert case toggle"),
    rule("text", "$a.title()", "title capitalize words"),
    rule("text", "$a.capitalize()", "capitalize first initial letter"),
    rule("text", "$a.strip()", "trim strip spaces whitespace leading trailing"),
    rule("text", "$a.split()", "split words tokenize whitespace", result="list"),
    rule("text", "$a.splitlines()", "split lines newline"),
    rule("text", "$a.isupper()", "upper uppercase case"),
    rule("text", "$a.islower()", "lower lowercase case"),
    rule("text", "$a.isalpha()", "alphabetic letters alpha"),
    rule("text", "$a.isalnum()", "alphanumeric letters digits"),
    rule("text", "$a.isdigit()", "digit numeric digits"),
    rule("text", "int($a)", "convert integer digits number"),
    rule("text", "float($a)", "convert decimal float number"),
    rule("text", "ord($a)", "ascii unicode code point"),
    rule("text text", "$a.split($b)", "split separator delimiter", result="list"),
    rule("text text", "$a.strip($b)", "trim strip characters"),
    rule("text text", "$a.find($b)", "find index substring position first"),
    rule("text text", "$a.rfind($b)", "find index substring position last"),
    rule("text text", "$a.startswith($b)", "starts prefix begins"),
    rule("text text", "$a.endswith($b)", "ends suffix ending"),
    rule("text text short-text", "$a.replace($b, $c)", "replace substitute occurrences remove"),
    rule("set set", "$a | $b", "union combine merge", distinct=True),
    rule("set set", "$a & $b", "intersection common shared overlap", distinct=True),
    rule("set set", "$a - $b", "difference exclude subtract", distinct=True),
    rule("set set", "$a ^ $b", "symmetric difference exclude xor", distinct=True),
    rule("set set", "$a.issubset($b)", "subset contained includes", distinct=True),
    rule("dictionary dictionary", "$a | $b", "merge combine dictionary mapping", distinct=True),
    rule("dictionary hashable", "$a[$b]", "value key dictionary mapping lookup"),
    rule("dictionary hashable", "$a.get($b)", "value key dictionary mapping lookup default"),
    rule("dictionary hashable value", "$a.get($b, $c)", "value key dictionary mapping lookup default"),
    rule("dictionary", "list($a.keys())", "dictionary mapping keys", weight=2),
    rule("dictionary", "list($a.values())", "dictionary mapping values", weight=2),
    rule("dictionary", "list($a.items())", "dictionary mapping pairs tuples items", weight=2),
    rule("dictionary", "{value: key for key, value in $a.items()}", "invert reverse dictionary swap", weight=2),
    rule("value value", "($a, $b)", "pair tuple both"),
    rule("value value", "[$a, $b]", "pair list both"),
    rule("hashable value", "{$a: $b}", "dictionary key value pair"),
    rule("sliceable integer", "[$a[$b]]", "element singleton list index first last", weight=2),
    rule("ordered ordered", "list(zip($a, $b))", "zip pair corresponding parallel", weight=2),
    rule("ordered ordered", "dict(zip($a, $b))", "zip pair dictionary keys values", weight=2),
    rule("ordered", "list(enumerate($a))", "enumerate position indices indexed", weight=2),
    rule("sequence", "list(dict.fromkeys($a))", "unique distinct duplicates order", weight=2),
    rule("sequence", "{item: $a.count(item) for item in $a}", "count frequency histogram occurrences", weight=2),
    rule("sequence", "max($a, key=$a.count)", "frequent mode most common", weight=2),
    rule("sequence", "[item for item in $a if item]", "truthy remove false empty filter", weight=2),
    rule("sequence", "[item for item in $a if item % 2 == 0]", "even filter divisible", weight=2),
    rule("sequence", "[item for item in $a if item % 2 != 0]", "odd filter", weight=2),
    rule("sequence", "[item for item in $a if item > 0]", "positive filter greater", weight=2),
    rule("sequence", "[item for item in $a if item < 0]", "negative filter less", weight=2),
    rule("sequence", "[abs(item) for item in $a]", "absolute magnitude map", weight=2),
    rule("sequence", "[item * item for item in $a]", "square element map", weight=2),
    rule("sequence", "[item for group in $a for item in group]", "flatten nested matrix concatenate", weight=2),
    rule("sequence", "[list(column) for column in zip(*$a)]", "transpose matrix columns rows", weight=2),
    rule("ordered", "[''.join(item) for item in $a]", "join string words characters", weight=2),
    rule("sequence number", "[item + $b for item in $a]", "add offset each increment", weight=2),
    rule("sequence number", "[item * $b for item in $a]", "multiply scale each product", weight=2),
    rule("sequence number", "[item for item in $a if item > $b]", "greater above threshold filter", weight=2),
    rule("sequence number", "[item for item in $a if item < $b]", "less below threshold filter", weight=2),
    rule("sequence value", "[item for item in $a if item != $b]", "exclude remove matching occurrences", weight=2),
    rule("sequence", "sorted($a, key=lambda item: item[1])", "sort second element pair index", weight=2),
    rule("sequence", "sorted($a, key=lambda item: item[-1])", "sort last element pair index", weight=2),
    rule("ordered", "sum($a) / len($a)", "average arithmetic mean", weight=2),
    rule("text text", "re.findall(re.escape($a), $b)", "regex find occurrences matches", weight=2, imports=("re",)),
    rule("text", r"re.findall(r'\d+', $a)", "regex digits numbers extract find", weight=2, imports=("re",)),
    rule("text", r"re.findall(r'\w+', $a)", "regex words extract find", weight=2, imports=("re",)),
    rule("text", r"re.findall(r'[A-Z]', $a)", "regex uppercase capital letters extract", weight=2, imports=("re",)),
    rule("text", r"re.findall(r'[a-z]', $a)", "regex lowercase letters extract", weight=2, imports=("re",)),
    rule("text short-text", r"re.sub(r'\s+', $b, $a)", "regex replace normalize whitespace spaces", weight=2, imports=("re",)),
    rule("text", r"re.sub(r'[^\w\s]', '', $a)", "regex remove punctuation letters words", weight=2, imports=("re",)),
    rule("text", r"re.sub(r'\D', '', $a)", "regex remove nondigits extract digits", weight=2, imports=("re",)),
    *collection_rules(rule),
    *numeric_rules(rule),
)


@dataclass(frozen=True)
class Recurrence:
    kinds: tuple[Kind, ...]
    template: Template
    words: frozenset[str]
    size: int


RECURRENCES = (
    Recurrence(("small-integer",), Template("1 if arg1 <= 1 else arg1 * $entry(arg1 - 1)"), frozenset({"factorial", "recursive", "recursively"}), 4),
    Recurrence(("small-integer",), Template("0 if arg1 <= 0 else arg1 + $entry(arg1 - 1)"), frozenset({"sum", "recursive", "recursively"}), 4),
    Recurrence(("sliceable",), Template("arg1 if len(arg1) <= 1 else $entry(arg1[1:]) + arg1[:1]"), frozenset({"reverse", "recursive", "recursively"}), 4),
    Recurrence(("integer", "integer"), Template("abs(arg1) if not arg2 else $entry(arg2, arg1 % arg2)"), frozenset({"gcd", "divisor", "recursive", "recursively"}), 4),
    Recurrence(("small-integer",), Template("arg1 if arg1 <= 1 else $entry(arg1 - 1) + $entry(arg1 - 2)"), frozenset({"fibonacci", "recursive", "recursively"}), 5),
)


@dataclass(frozen=True)
class Term:
    source: str
    values: tuple[object, ...]
    types: frozenset[Kind]
    inputs: int
    imports: frozenset[str] = frozenset()


SPECIFIC_TYPES = {str: "text", bool: "boolean", list: "list", tuple: "tuple", dict: "dictionary", set: "set", frozenset: "set"}


def _value_types(value):
    value_type = type(value)
    kinds = {"value"}
    if value_type in (int, float):
        kinds.update(("number", "hashable"))
    if value_type is int:
        kinds.add("integer")
        if value >= 0:
            kinds.add("nonnegative-integer")
        if abs(value) <= 100_000:
            kinds.add("bounded-integer")
        if abs(value) <= 32:
            kinds.add("precision")
        if 0 <= value <= 32:
            kinds.add("small-integer")
    if value_type in (str, list, tuple):
        kinds.add("sliceable")
    if value_type in (str, list, tuple, dict):
        kinds.add("ordered")
    if value_type in (str, list, tuple, set, frozenset, dict):
        kinds.add("iterable")
    if value_type in (list, tuple):
        kinds.add("sequence")
    if value_type in SPECIFIC_TYPES:
        kinds.add(SPECIFIC_TYPES[value_type])
    if value_type in (str, bool, tuple, frozenset) or value is None:
        kinds.add("hashable")
    if value_type is str and len(value) <= 64:
        kinds.add("short-text")
    return kinds


def _types_for(values):
    return frozenset(set.intersection(*map(_value_types, values)))


def _freeze(value):
    """Preserve distinctions that another Python operation can observe."""
    value_type = type(value)
    if value_type is int and value.bit_length() <= 256:
        return int, value
    if value is None or value_type is bool or (value_type is str and len(value) <= MAX_STRING_SIZE):
        return value_type, value
    remaining = MAX_VALUE_NODES

    def freeze(item, depth):
        nonlocal remaining
        remaining -= 1
        if depth > 8 or remaining < 0:
            raise ValueError("value size limit")
        value_type = type(item)
        if value_type is int and item.bit_length() > 256:
            raise ValueError("integer size limit")
        if value_type is float:
            if not math.isfinite(item):
                raise ValueError("non-finite number")
            return value_type, item.hex()
        if item is None or value_type in (int, bool):
            return value_type, item
        if value_type is str and len(item) <= MAX_STRING_SIZE:
            return value_type, item
        if value_type not in (tuple, list, set, frozenset, dict) or len(item) > MAX_COLLECTION_SIZE:
            raise ValueError("unsupported or oversized value")
        if value_type is dict:
            return value_type, tuple((freeze(key, depth + 1), freeze(value, depth + 1)) for key, value in item.items())
        # A later list conversion or iteration can observe set order as well.
        return value_type, tuple(freeze(value, depth + 1) for value in item)

    return freeze(value, 0)


def _literal_constants(description):
    # Constants are language primitives or literals in the description, never
    # the expected outputs or a table constructed from an assertion's inputs.
    yield from (-1, 0, 1, 2, 3, True, False, None, "", " ", "-", ",", "_")
    for token in islice(re.finditer(r"(?<![\w.])-?\d{1,7}(?:\.\d{1,5})?(?![\w.])", description), 8):
        number = token.group()
        yield float(number) if "." in number else int(number)
    quoted = re.finditer(r"`([^`\n]{1,16})`|['\"]([^'\"\n]{1,16})['\"]", description)
    for token in islice(quoted, 6):
        yield token.group(1) or token.group(2)


def _size_partitions(total, length):
    if length == 1:
        if total > 0:
            yield (total,)
        return
    for first in range(1, total - length + 2):
        for rest in _size_partitions(total - first, length - 1):
            yield (first, *rest)


def _combinations(rule, size, pools, arity):
    for sizes in _size_partitions(size - rule.weight, len(rule.kinds)):
        if rule.commutative and sizes[0] > sizes[1]:
            continue
        for operands in product(*(pools[cost, kind] for cost, kind in zip(sizes, rule.kinds))):
            if rule.distinct and len({term.source for term in operands}) != len(operands):
                continue
            if rule.commutative and sizes[0] == sizes[1] and operands[0].source > operands[1].source:
                continue
            inputs = operands[0].inputs
            for operand in operands[1:]:
                inputs |= operand.inputs
            if inputs or not arity:
                yield operands, inputs


def _example_hints(examples):
    """Use consistent changes in sequence length to distinguish common transforms."""
    hints = set()
    for column in zip(*(args for args, _ in examples)):
        inputs = []
        outputs = []
        for value, (_, expected) in zip(column, examples):
            if type(value) not in (str, list, tuple) or type(expected) not in (str, list, tuple):
                break
            inputs.append(len(value))
            outputs.append(len(expected))
        else:
            if all(a == b for a, b in zip(inputs, outputs)) and any(inputs):
                hints.update(("map", "elementwise", "sort", "reverse"))
            elif all(a >= b for a, b in zip(inputs, outputs)):
                hints.update(("filter", "slice", "remove"))
            elif all(a <= b for a, b in zip(inputs, outputs)):
                hints.update(("append", "concat", "repeat"))
    return hints


def _rank_rules(rules, words, expected_types, hints):
    """Prefer operations suggested by the task and able to return its output kind."""
    def priority(production):
        fit = 0 if production.result is None else 1 if production.result in expected_types else -1
        return -len(production.words & words), -fit, -bool(production.words & hints)

    return sorted(rules, key=priority)


def _render(name, parameters, expression, imports):
    # Unparse just the synthesized expression to remove mechanical parentheses.
    expression = ast.unparse(ast.parse(expression, mode="eval"))
    header = f"def {name}({', '.join(parameters)}):\n"
    modules = "".join(f"    import {module}\n" for module in sorted(imports))
    return f"{header}{modules}    return {expression}\n"


def _matching_examples(values, expected):
    return sum(
        actual == target
        and (type(actual) is type(target) or {type(actual), type(target)} == {int, float})
        for actual, target in zip(values, expected)
    )


def _contradictory_examples(examples):
    seen = {}
    for args, expected in examples:
        try:
            inputs = _freeze(args)
        except ValueError:
            continue
        if inputs in seen and seen[inputs] != expected:
            return True
        seen[inputs] = expected
    return False


def _recurrence_programs(name, parameters, observations, argument_types, size, words):
    recurrences = sorted(RECURRENCES, key=lambda recurrence: -len(recurrence.words & words))
    for recurrence in recurrences:
        if recurrence.size != size or len(parameters) != len(recurrence.kinds):
            continue
        if not all(kind in types for kind, types in zip(recurrence.kinds, argument_types)):
            continue
        # Fibonacci's naive recurrence is exponential. Limit its pruning inputs.
        if "fibonacci" in recurrence.words and any(args[0] > 18 for args in observations):
            continue
        body = recurrence.template.template
        if parameters[0] != "arg1":
            body = re.sub(r"\barg([1-9])\b", lambda match: parameters[int(match[1]) - 1], body)
        expression = Template(body).substitute(entry=name)
        source = _render(name, parameters, expression, ())
        namespace = EVALUATION_GLOBALS.copy()
        exec(source, namespace)
        yield source, namespace[name]


def synthesize(
    name: str,
    description: str,
    examples: Iterable[Example],
    verify: Callable[[str], bool],
    *,
    on_limit: Callable[[str], None] | None = None,
) -> str | None:
    """Return the first size-ordered candidate accepted by the supplied verifier."""
    if not name.isidentifier() or keyword.iskeyword(name):
        return None
    examples = tuple(examples)
    if not examples:
        return None
    # The parent still enforces a wall-clock cap for the entire worker.
    deadline = process_time() + MAX_SEARCH_CPU_SECONDS
    observations, expected = zip(*examples)
    arity = len(observations[0])
    if any(len(args) != arity for args in observations):
        return None
    prefix = "value" if re.fullmatch(r"arg[1-9]\d*", name) else "arg"
    parameters = tuple(f"{prefix}{index + 1}" for index in range(arity))
    words = frozenset(re.findall(r"[a-z]+", description.lower()))
    expected_types = _types_for(expected)
    rules = _rank_rules(RULES, words, expected_types, _example_hints(examples))
    pools: dict[tuple[int, Kind], list[Term]] = defaultdict(list)
    observed = set()
    example_matches = {}
    verified_sources = set()
    evaluations = 0
    verifications = 0
    diagnostic = None
    diagnostic_matches = -1
    example_count = len(expected)

    def verify_source(candidate):
        nonlocal verifications
        if verifications == MAX_VERIFICATIONS or candidate in verified_sources:
            return None
        verified_sources.add(candidate)
        verifications += 1
        return candidate if verify(candidate) else None

    def verify_term(term):
        return verify_source(_render(name, parameters, term.source, term.imports))

    def keep(term, size, observation):
        if observation in observed:
            return
        observed.add(observation)
        for kind in term.types:
            pools[size, kind].append(term)

    def report_failure(limit=None):
        if limit is not None and on_limit is not None:
            on_limit(limit)
        if verifications == 0 and diagnostic is not None:
            # Let the sandbox identify a concrete original assertion failure.
            # A successful full verification is also valid if pruning was stricter.
            return verify_term(diagnostic)
        return None

    initial = [
        Term(parameter, values, _types_for(values), 1 << index)
        for index, (parameter, values) in enumerate(zip(parameters, zip(*observations)))
    ]
    argument_types = tuple(term.types for term in initial)
    for constant in _literal_constants(description):
        initial.append(Term(repr(constant), (constant,) * len(expected), frozenset(_value_types(constant)), 0))
    for term in initial:
        try:
            keep(term, 1, (term.inputs, tuple(map(_freeze, term.values))))
        except ValueError:
            continue
        if (term.inputs or not arity) and _matching_examples(term.values, expected) == example_count:
            if result := verify_term(term):
                return result
        if diagnostic is None and term.inputs:
            diagnostic = term

    if _contradictory_examples(examples):
        return report_failure()

    try:
        for args in observations:
            _freeze(args)
        samples_within_limits = True
    except ValueError:
        samples_within_limits = False

    for size in range(2, MAX_SIZE + 1):
        if samples_within_limits:
            programs = (
                statement_programs(name, parameters, argument_types, expected_types, words)
                if size == 3 else _recurrence_programs(name, parameters, observations, argument_types, size, words)
            )
            for source, evaluate in programs:
                if process_time() >= deadline:
                    return report_failure("search-cpu-time")
                if evaluations >= MAX_EVALUATIONS:
                    return report_failure("search-evaluations")
                if verifications >= MAX_VERIFICATIONS:
                    return report_failure("search-verifications")
                evaluations += 1
                values = []
                try:
                    for args in observations:
                        if process_time() >= deadline:
                            return report_failure("search-cpu-time")
                        values.append(evaluate(*args))
                except EVALUATION_ERRORS:
                    continue
                if _matching_examples(values, expected) == example_count:
                    if result := verify_source(source):
                        return result
        for production in rules:
            if process_time() >= deadline:
                return report_failure("search-cpu-time")
            for operands, inputs in islice(_combinations(production, size, pools, arity), MAX_PER_RULE_AND_SIZE):
                if evaluations >= MAX_EVALUATIONS:
                    return report_failure("search-evaluations")
                if verifications >= MAX_VERIFICATIONS:
                    return report_failure("search-verifications")
                if evaluations % 64 == 0 and process_time() >= deadline:
                    return report_failure("search-cpu-time")
                evaluations += 1
                try:
                    values = tuple(production.evaluate(*args) for args in zip(*(term.values for term in operands)))
                    if size == MAX_SIZE:
                        # Terminal terms cannot supply operands. Avoid retaining
                        # their value graphs or computing keys for poor matches.
                        matched_examples = _matching_examples(values, expected)
                        if matched_examples != example_count and matched_examples <= diagnostic_matches:
                            continue
                        for value in values:
                            _freeze(value)
                    else:
                        signature = tuple(map(_freeze, values))
                        observation = inputs, signature
                        matched_examples = example_matches.get(signature)
                        if matched_examples is None:
                            matched_examples = _matching_examples(values, expected)
                            example_matches[signature] = matched_examples
                        # Equivalent expressions can disagree on assertions
                        # that could not be projected. Keep full-match alternatives.
                        if observation in observed and matched_examples != example_count:
                            continue
                except EVALUATION_ERRORS:
                    continue
                source = production.template.substitute({key: f"({term.source})" for key, term in zip(("a", "b", "c"), operands)})
                imports = production.imports.union(*(term.imports for term in operands))
                term = Term(source, values, _types_for(values), inputs, imports)
                if matched_examples == example_count:
                    if result := verify_term(term):
                        return result
                elif matched_examples > diagnostic_matches:
                    diagnostic = term
                    diagnostic_matches = matched_examples
                if size < MAX_SIZE:
                    keep(term, size, observation)
    return report_failure()
