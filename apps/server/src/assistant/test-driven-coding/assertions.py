"""Parse example assertions and define the Python subset used by the verifier."""

import ast
import builtins
from dataclasses import dataclass
import math
import re
from types import SimpleNamespace


PURE_BUILTINS = {
    name: getattr(builtins, name) for name in (
        "abs", "all", "any", "bool", "bytes", "chr", "dict", "divmod",
        "enumerate", "filter", "float", "frozenset", "int", "isinstance",
        "len", "list", "map", "max", "min", "ord", "pow", "range",
        "reversed", "round", "set", "sorted", "str", "sum", "tuple", "zip",
    )
}
MODULE_MEMBERS = {
    "math": (
        "acos", "asin", "atan", "atan2", "ceil", "comb", "copysign", "cos",
        "degrees", "dist", "e", "exp", "fabs", "factorial", "floor", "fmod",
        "fsum", "gcd", "hypot", "inf", "isclose", "isfinite", "isinf", "isnan",
        "isqrt", "lcm", "log", "log10", "log2", "perm", "pi", "pow", "prod",
        "radians", "remainder", "sin", "sqrt", "tan", "tau", "trunc",
    ),
    "re": (
        "ASCII", "DOTALL", "IGNORECASE", "MULTILINE", "VERBOSE", "compile",
        "escape", "findall", "finditer", "fullmatch", "match", "search",
        "split", "sub", "subn",
    ),
}
MODULES = {"math": math, "re": re}
PUBLIC_ATTRIBUTES = set().union(*MODULE_MEMBERS.values(), (
    "add", "append", "bit_count", "bit_length", "capitalize", "casefold",
    "center", "clear", "copy", "count", "difference", "difference_update",
    "discard", "endswith", "extend", "find", "fromkeys", "get", "group",
    "groupdict", "groups", "index", "insert", "intersection",
    "intersection_update", "isalnum", "isalpha", "isascii", "isdecimal",
    "isdigit", "isdisjoint", "is_integer", "isidentifier", "islower", "isnumeric",
    "isprintable", "isspace", "issubset", "issuperset", "istitle", "isupper",
    "items", "join", "keys", "ljust", "lower", "lstrip", "maketrans",
    "partition", "pop", "popitem", "remove", "removeprefix", "removesuffix",
    "replace", "reverse", "rfind", "rindex", "rjust", "rpartition", "rsplit",
    "rstrip", "setdefault", "sort", "splitlines", "startswith", "strip",
    "swapcase", "symmetric_difference", "symmetric_difference_update", "title",
    "translate", "union", "update", "upper", "values", "zfill",
))
BLOCKED_NAMES = {
    "breakpoint", "delattr", "eval", "exec", "getattr", "globals", "help",
    "input", "locals", "memoryview", "open", "setattr", "super", "type", "vars",
}
EXPRESSION_NODES = (
    ast.Assert, ast.Constant, ast.Name, ast.Attribute, ast.List, ast.Tuple,
    ast.Set, ast.Dict, ast.Slice, ast.Subscript, ast.Starred, ast.Call,
    ast.keyword, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp,
    ast.comprehension, ast.Lambda, ast.arguments, ast.arg, ast.IfExp,
    ast.BinOp, ast.UnaryOp, ast.BoolOp, ast.Compare, ast.JoinedStr,
    ast.FormattedValue, ast.expr_context, ast.operator, ast.unaryop, ast.boolop,
    ast.cmpop,
)
CANDIDATE_NODES = EXPRESSION_NODES + (
    ast.FunctionDef, ast.Return, ast.Expr, ast.Assign, ast.AugAssign, ast.If,
    ast.For, ast.While, ast.Pass, ast.Break, ast.Continue, ast.Import,
    ast.ImportFrom, ast.alias,
)


class UnsupportedSyntax(ValueError):
    pass


def public_name(name):
    return "__" not in name and name not in BLOCKED_NAMES


def inspect_tree(root, supported_nodes):
    for node in ast.walk(root):
        if not isinstance(node, supported_nodes):
            raise UnsupportedSyntax
        if isinstance(node, ast.Name) and not public_name(node.id):
            raise UnsupportedSyntax
        if isinstance(node, ast.arg) and not public_name(node.arg):
            raise UnsupportedSyntax
        if isinstance(node, ast.Attribute) and (
            node.attr not in PUBLIC_ATTRIBUTES or not isinstance(node.ctx, ast.Load)
        ):
            raise UnsupportedSyntax
        if isinstance(node, ast.FunctionDef) and (
            not public_name(node.name) or node.decorator_list
        ):
            raise UnsupportedSyntax
        if isinstance(node, ast.Import) and any(
            alias.name not in MODULES or (alias.asname and not public_name(alias.asname))
            for alias in node.names
        ):
            raise UnsupportedSyntax
        if isinstance(node, ast.ImportFrom) and (
            node.level or node.module not in MODULES
            or any(
                alias.name not in MODULE_MEMBERS[node.module]
                or (alias.asname and not public_name(alias.asname))
                for alias in node.names
            )
        ):
            raise UnsupportedSyntax


def python_scope(printer):
    modules = {
        module: SimpleNamespace(**{
            name: getattr(MODULES[module], name) for name in names
        })
        for module, names in MODULE_MEMBERS.items()
    }

    def safe_import(name, globals=None, locals=None, fromlist=(), level=0):
        if level or name not in modules:
            raise ImportError
        return modules[name]

    return {"__builtins__": dict(PURE_BUILTINS, __import__=safe_import, print=printer), **modules}


@dataclass(frozen=True)
class Assertion:
    source: str
    code: object
    test: ast.expr


@dataclass(frozen=True)
class Problem:
    entry: str
    arity: int
    assertions: tuple[Assertion, ...]


class AssertionProblem(ValueError):
    def __init__(self, reason, index=None, source=None):
        self.reason = reason
        self.index = index
        self.source = source


def parse_assertions(raw):
    if isinstance(raw, list) and all(isinstance(line, str) for line in raw):
        raw = "\n".join(raw)
    if not isinstance(raw, str):
        raise AssertionProblem("invalid-assertions")
    lines = raw.strip("\r\n").split("\n")
    if lines and re.fullmatch(r"```(?:py|python)?\s*", lines[0].strip(), re.IGNORECASE):
        lines.pop(0)
    if lines and lines[-1].strip() == "```":
        lines.pop()
    document = "\n".join(lines)
    try:
        parsed = ast.parse(document)
    except (SyntaxError, ValueError, RecursionError):
        raise AssertionProblem("invalid-assertions") from None
    if not parsed.body or not all(isinstance(node, ast.Assert) for node in parsed.body):
        raise AssertionProblem("invalid-assertions")
    return _build_problem(document, parsed.body)


def _build_problem(document, nodes):
    result = []
    calls_in_assertion = []
    for index, node in enumerate(nodes):
        source = ast.get_source_segment(document, node) or ""
        try:
            inspect_tree(node, EXPRESSION_NODES)
            if isinstance(node.test, ast.Tuple):
                raise UnsupportedSyntax
            code = compile(ast.Module(body=[node], type_ignores=[]), "<assertion>", "exec", optimize=0)
        except (UnsupportedSyntax, SyntaxError, ValueError):
            raise AssertionProblem("unsupported-assertion", index, source) from None
        result.append(Assertion(source, code, node.test))
        calls_in_assertion.append([
            item for item in ast.walk(node.test)
            if isinstance(item, ast.Call) and isinstance(item.func, ast.Name)
        ])

    common = set.intersection(*({call.func.id for call in calls} for calls in calls_in_assertion))
    custom_names = common.difference(PURE_BUILTINS, MODULES, {"print"})
    names = custom_names or common
    if len(names) != 1:
        raise AssertionProblem("unsupported-assertion", 0, result[0].source)
    entry = names.pop()
    arity = None
    for index, calls in enumerate(calls_in_assertion):
        for call in calls:
            if call.func.id != entry:
                continue
            if call.keywords or any(isinstance(arg, ast.Starred) for arg in call.args):
                raise AssertionProblem("unsupported-arguments", index, result[index].source)
            if arity is None:
                arity = len(call.args)
            if arity != len(call.args):
                raise AssertionProblem("unsupported-arguments", index, result[index].source)
    return Problem(entry, arity, tuple(result))


def _entry_call(test, entry):
    return isinstance(test, ast.Call) and isinstance(test.func, ast.Name) and test.func.id == entry


def example_nodes(problem):
    """Yield evaluable argument and expected expressions without invoking the entry point."""
    for assertion in problem.assertions:
        test = assertion.test
        if _entry_call(test, problem.entry):
            yield test.args, ast.Constant(True)
        elif isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not):
            if _entry_call(test.operand, problem.entry):
                yield test.operand.args, ast.Constant(False)
        elif isinstance(test, ast.Compare) and len(test.ops) == 1 and isinstance(test.ops[0], (ast.Eq, ast.Is)):
            left, right = test.left, test.comparators[0]
            if _entry_call(right, problem.entry):
                left, right = right, left
            if _entry_call(left, problem.entry):
                yield left.args, right


def compile_candidate(source, problem):
    try:
        parsed = ast.parse(source)
        definitions = [node for node in parsed.body if isinstance(node, ast.FunctionDef)]
        if (
            len(definitions) != 1 or definitions[0].name != problem.entry
            or any(not isinstance(node, (ast.FunctionDef, ast.Import, ast.ImportFrom)) for node in parsed.body)
        ):
            raise UnsupportedSyntax
        parameters = definitions[0].args
        if (
            len(parameters.posonlyargs) + len(parameters.args) != problem.arity
            or parameters.vararg or parameters.kwonlyargs or parameters.kwarg
        ):
            raise UnsupportedSyntax
        for node in parsed.body:
            inspect_tree(node, CANDIDATE_NODES)
        return compile(parsed, "<candidate>", "exec", optimize=0)
    except (SyntaxError, ValueError, RecursionError):
        raise UnsupportedSyntax from None
