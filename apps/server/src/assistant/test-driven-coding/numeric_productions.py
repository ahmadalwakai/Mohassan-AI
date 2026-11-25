"""Typed arithmetic, integer, and bitwise productions for synthesis."""


def _divisors(operand):
    # Enumerate factor pairs once, including a square root only once.
    return (
        f"{{factor for low in range(1, math.isqrt({operand}) + 1) "
        f"if {operand} % low == 0 for factor in (low, {operand} // low)}}"
    )


def numeric_rules(rule):
    divisors = _divisors("$a")
    return (
        rule("number number number", "$a * $b * $c", "product multiply volume", result="number"),
        rule("number number number", "min($a, $b, $c)", "minimum smallest least", result="number"),
        rule("number number number", "max($a, $b, $c)", "maximum largest greatest", result="number"),
        rule("number number number", "sorted(($a, $b, $c))[1]", "median middle", result="number"),
        rule("number number", "($a + $b) / 2", "mean average midpoint halfway", result="number", commutative=True),
        rule("number number", "$a * $b / 2", "half product area triangle", result="number", commutative=True),
        rule("number number", "math.hypot($a, $b)", "hypotenuse distance magnitude triangle", imports=("math",), result="number"),
        rule("integer", "math.isqrt($a)", "integer square root floor", imports=("math",), result="integer"),
        rule("small-integer small-integer", "math.comb($a, $b)", "binomial choose combinations", imports=("math",), result="integer"),
        rule("small-integer small-integer", "math.perm($a, $b)", "permutations arrangements", imports=("math",), result="integer"),
        rule("nonnegative-integer", "$a * ($a + 1) // 2", "triangle triangular pairs sum", result="integer"),
        rule("iterable", "max($a) - min($a)", "range spread maximum difference", weight=2, result="number"),
        rule("iterable", "max($a) + min($a)", "sum total maximum minimum", weight=2, result="number"),
        rule(
            "sequence", "min(item for item in $a if isinstance(item, (int, float)) and not isinstance(item, bool))",
            "minimum smallest numeric number mixed heterogeneous", weight=2, result="number",
        ),
        rule(
            "sequence", "max(item for item in $a if isinstance(item, (int, float)) and not isinstance(item, bool))",
            "maximum largest numeric number mixed heterogeneous", weight=2, result="number",
        ),
        rule("integer integer integer", "$a % $b == $c", "multiple divisible remainder equals residue", result="boolean"),
        rule("integer integer integer", "$a % $b != $c", "multiple divisible remainder unequal residue", result="boolean"),
        rule("bounded-integer", f"sorted({divisors})", "list factors divisors", imports=("math",), result="list"),
        rule("bounded-integer", f"sum({divisors})", "sum total factors divisors", imports=("math",), result="integer"),
        rule(
            "bounded-integer small-integer", f"sum(factor for factor in {divisors} if factor % $b == 0)",
            "sum total factors divisors divisible even multiple", imports=("math",), result="integer",
        ),
        rule(
            "small-integer small-integer", "sum(item ** $b for item in range(1, $a + 1))",
            "sum total powers progression natural squares cubes", result="integer",
        ),
        rule(
            "small-integer small-integer small-integer", "sum((item * $b) ** $c for item in range(1, $a + 1))",
            "sum total powers progression multiples even squares cubes", result="integer",
        ),
        rule(
            "small-integer small-integer small-integer", "sum((item * $b + 1) ** $c for item in range($a))",
            "sum total powers progression odd squares cubes", result="integer",
        ),
        rule("integer integer", "int(str(abs($a))[$b])", "decimal digit index first last position", result="integer"),
        rule("integer", "int(str(abs($a))[::-1]) * (-1 if $a < 0 else 1)", "decimal digits reverse", weight=2, result="integer"),
        rule("sequence small-integer", "[item ** $b for item in $a]", "powers squares cubes exponent each map", result="list"),
        rule(
            "sequence", "[sum(int(digit) for digit in str(abs(item))) for item in $a]",
            "decimal digits sum total each", weight=2, result="list",
        ),
        rule("integer", "~$a", "bitwise complement invert flip bits", result="integer"),
        rule("nonnegative-integer", "$a & ($a - 1)", "bitwise clear remove lowest bit mask", result="integer"),
        rule("nonnegative-integer", "$a > 0 and $a & ($a - 1) == 0", "power two single bit binary", result="boolean"),
        rule("nonnegative-integer", "1 << ($a.bit_length() - 1) if $a else 0", "power two highest lower floor binary", result="integer"),
        rule("nonnegative-integer", "1 << ($a - 1).bit_length() if $a > 1 else 1", "power two smallest greater ceiling binary", result="integer"),
        rule(
            "nonnegative-integer small-integer", "$a | sum(1 << bit for bit in range($b % 2, $a.bit_length(), 2))",
            "binary bits set alternate alternating odd even mask", result="integer",
        ),
        rule("integer", "f'{$a:b}'", "format binary representation bits", result="text"),
        rule("integer", "f'{$a:x}'", "format hexadecimal representation digits", result="text"),
        rule("text small-integer", "int($a, $b)", "parse digits integer radix base binary hexadecimal", result="integer"),
    )
