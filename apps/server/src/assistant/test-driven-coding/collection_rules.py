"""Typed collection transforms shared by the expression search."""


def collection_rules(rule):
    return (
        rule("sequence", "sorted($a, key=sum)", "sort order total sum row", result="list"),
        rule("sequence", "sorted($a, key=lambda item: item.casefold())", "sort order alphabetical case insensitive", result="list"),
        rule("sequence integer", "sorted($a, key=lambda item: item[$b])", "sort order key column index", result="list"),
        rule("sequence", "[sorted(item) for item in $a]", "sort order each nested rows", weight=2, result="list"),
        rule("sequence", "[tuple(sorted(item)) for item in $a]", "canonical unordered pairs normalize sort keys", weight=2, result="list"),
        rule("sequence", "max(((len(item), item) for item in $a), key=lambda pair: pair[0])", "longest length maximum pair", weight=2, result="tuple"),
        rule("sequence integer", "[item[$b] for item in $a]", "select extract each index column", weight=2, result="list"),
        rule("sequence integer", "[item[:$b] for item in $a]", "trim prefix truncate each", weight=2, result="list"),
        rule("sequence integer", "[item[$b:] for item in $a]", "trim suffix skip each", weight=2, result="list"),
        rule("sequence integer", "[item for item in $a if len(item) == $b]", "filter size exact length", weight=2, result="list"),
        rule("sequence integer", "[item for item in $a if len(item) > $b]", "filter longer length above", weight=2, result="list"),
        rule("sequence integer", "[item for item in $a if all(value % $b == 0 for value in item)]", "filter each all divisible multiple", weight=2, result="list"),
        *(
            rule(
                "sequence short-text",
                f"{kind}(token for line in $a for token in line.split() if token.casefold().startswith($b.casefold()))",
                "filter tokens words starts starting prefix case insensitive",
                weight=2,
                result=kind,
            )
            for kind in ("list", "tuple")
        ),
        rule("sequence value", "all(item == $b for item in $a)", "all same equal identical every", weight=2, result="boolean"),
        rule("sequence iterable", "sum(item in $b for item in $a)", "count occurrences membership common", weight=2, result="number"),
        rule("sequence iterable", "[item for item in $a if item not in $b]", "exclude remove difference membership", weight=2, result="list"),
        rule("sequence value", "[value for item in $a for value in ($b, item)]", "insert interleave before each", weight=2, result="list"),
        rule("sliceable", "min($a, key=$a.count)", "least frequent uncommon rare count", weight=2),
        rule("sequence", "sum(item > 0 for item in $a)", "count positive greater zero", weight=2, result="number"),
        rule("sequence", "sum(item for index, item in enumerate($a) if index % 2 == item % 2 == 0)", "sum even index position parity", weight=2, result="number"),
        rule("sequence sequence sequence", "sorted([*$a, *$b, *$c])", "sort merge combine concatenate ascending", weight=2, result="list"),
        rule("dictionary dictionary dictionary", "{**$a, **$b, **$c}", "merge combine dictionary maps", weight=2, result="dictionary"),
        rule("dictionary", "len(set($a.values()))", "count unique distinct dictionary values", result="number"),
        rule("dictionary", "{key: value for key, value in $a.items() if value}", "filter remove empty false dictionary", weight=2, result="dictionary"),
        rule("sliceable value", "($b in $a, $a.index($b) if $b in $a else -1)", "index position membership absent find pair", weight=2, result="tuple"),
        rule("sliceable integer", "$a[$b - 1]", "position ordinal kth one based index element", weight=2),
        rule("sliceable integer", "($a[:$b], $a[$b:])", "split partition prefix suffix index", weight=2, result="tuple"),
        rule("sliceable integer integer", "$a[$b::$c]", "stride step start offset alternate slice"),
        rule("sliceable small-integer", "[$a[offset::$b] for offset in range($b)]", "split stride group every nth", weight=2, result="list"),
        rule("sliceable integer", "[$a[offset:offset + $b] for offset in range(0, len($a), $b)]", "split chunk group contiguous blocks", weight=2, result="list"),
        rule("text text", "$a.partition($b)", "partition split separator delimiter left", result="tuple"),
        rule("text text", "$a.rpartition($b)", "partition split separator delimiter right last", result="tuple"),
        rule("text text small-integer", "$a.rsplit($b, $c)", "split right last delimiter limit", result="list"),
        rule("text text small-integer", "$a.split($b, $c)", "split left first delimiter limit", result="list"),
        rule("text text", "''.join(item for item in $a if item not in $b)", "exclude remove filter characters", weight=2, result="text"),
        rule("text text", "(lambda parts: parts[0] + ''.join(part.capitalize() for part in parts[1:]))($a.rsplit($b))", "camel case join tokens capitalize", weight=2, result="text"),
        rule("text text", "''.join(part.capitalize() for part in $a.rsplit($b))", "pascal camel case join tokens capitalize", weight=2, result="text"),
        rule("text", "tuple(item for item in $a if not item.isspace())", "tuple characters remove spaces whitespace", weight=2, result="tuple"),
        rule("text ordered", "$a.join(str(item) for item in $b)", "join concatenate convert string values", weight=2, result="text"),
        rule("sequence short-text", r"[re.sub(r'\{\{|\}\}|\{0?\}', lambda token: token.group()[0] if token.group() in ('{{', '}}') else str(item), $b) for item in $a]", "format template placeholder string substitute each", weight=2, imports=("re",), result="list"),
        rule("number precision", "f'{${a}:.{${b}}f}'", "format fixed decimal precision places", result="text"),
        rule("tuple", "tuple(left + right for left, right in zip($a, $a[1:]))", "add adjacent neighboring pairwise tuple", weight=2, result="tuple"),
        *(
            rule(
                f"{kind} {kind}",
                f"{kind}({expression} for left, right in zip($a, $b))",
                f"elementwise corresponding pairwise {words}",
                weight=2,
                result=kind,
            )
            for kind in ("list", "tuple")
            for expression, words in (
                ("left + right", "add sum plus"),
                ("left - right", "subtract difference minus"),
                ("left * right", "multiply product times"),
                ("left & right", "bitwise and intersection"),
                ("left ^ right", "bitwise xor"),
            )
        ),
    )
