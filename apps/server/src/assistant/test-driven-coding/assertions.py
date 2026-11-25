"""Parse example assertions and define the Python subset used by the verifier."""

import ast
import builtins
from copy import deepcopy
from dataclasses import dataclass
from functools import partial
import math
import operator
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
REGEX_FLAGS = ("ASCII", "DOTALL", "IGNORECASE", "MULTILINE", "VERBOSE")
REGEX_FLAG_MASK = sum(int(getattr(re, flag)) for flag in REGEX_FLAGS)
MODULE_MEMBERS = {
    "math": (
        "acos", "asin", "atan", "atan2", "ceil", "comb", "copysign", "cos",
        "degrees", "dist", "e", "exp", "fabs", "factorial", "floor", "fmod",
        "fsum", "gcd", "hypot", "inf", "isclose", "isfinite", "isinf", "isnan",
        "isqrt", "lcm", "log", "log10", "log2", "perm", "pi", "pow", "prod",
        "radians", "remainder", "sin", "sqrt", "tan", "tau", "trunc",
    ),
    "re": REGEX_FLAGS + (
        "compile",
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
MAX_RANGE_LENGTH = 100_000
MAX_COMBINATORIC_INPUT = 10_000
MAX_INTEGER_BITS = 16_384


class UnsupportedSyntax(ValueError):
    pass


def public_name(name):
    return "__" not in name and name not in BLOCKED_NAMES


def inspect_tree(root, supported_nodes, bound_names=None):
    needs_guards = False
    for node in ast.walk(root):
        if not isinstance(node, supported_nodes):
            raise UnsupportedSyntax
        if isinstance(node, ast.Name):
            if not public_name(node.id):
                raise UnsupportedSyntax
            if bound_names is not None and isinstance(node.ctx, ast.Store):
                bound_names.add(node.id)
        elif isinstance(node, ast.arg):
            if not public_name(node.arg):
                raise UnsupportedSyntax
            if bound_names is not None:
                bound_names.add(node.arg)
        elif isinstance(node, ast.Attribute) and (
            node.attr not in PUBLIC_ATTRIBUTES or not isinstance(node.ctx, ast.Load)
        ):
            raise UnsupportedSyntax
        elif isinstance(node, ast.FunctionDef) and (
            not public_name(node.name) or node.decorator_list
        ):
            raise UnsupportedSyntax
        elif isinstance(node, ast.Import) and any(
            alias.name not in MODULES or (alias.asname and not public_name(alias.asname))
            for alias in node.names
        ):
            raise UnsupportedSyntax
        elif isinstance(node, ast.ImportFrom) and (
            node.level or node.module not in MODULES
            or any(
                alias.name not in MODULE_MEMBERS[node.module]
                or (alias.asname and not public_name(alias.asname))
                for alias in node.names
            )
        ):
            raise UnsupportedSyntax
        elif isinstance(node, (ast.Pow, ast.LShift)):
            needs_guards = True
    return needs_guards


class _RangeType(type):
    def __instancecheck__(cls, value):
        return isinstance(value, range)


class _BoundedRange(metaclass=_RangeType):
    count = range.count
    index = range.index

    def __new__(cls, *args):
        values = range(*args)
        try:
            if len(values) <= MAX_RANGE_LENGTH:
                return values
        except OverflowError:
            pass
        raise ValueError("range exceeds verifier bounds")


def _bounded_combinatoric(function, *args):
    if any(value is not None and operator.index(value) > MAX_COMBINATORIC_INPUT for value in args):
        raise ValueError("combinatoric input exceeds verifier bounds")
    return function(*args)


def _bounded_power(base, exp, mod=None):
    if isinstance(base, int) and isinstance(exp, int):
        bits = base.bit_length()
        if mod is None:
            if exp > MAX_INTEGER_BITS // max(bits, 1):
                raise ValueError("power exceeds verifier bounds")
        elif isinstance(mod, int) and (
            bits > MAX_INTEGER_BITS or mod.bit_length() > MAX_INTEGER_BITS
            or not -MAX_INTEGER_BITS <= exp <= MAX_INTEGER_BITS
        ):
            raise ValueError("modular power exceeds verifier bounds")
    return pow(base, exp, mod)


def _bounded_left_shift(value, shift):
    if isinstance(value, int) and isinstance(shift, int) and shift > MAX_INTEGER_BITS - value.bit_length():
        raise ValueError("left shift exceeds verifier bounds")
    return operator.lshift(value, shift)


def _restricted_regex(function, flags_index, /, *args, **kwargs):
    flags = args[flags_index] if len(args) > flags_index else kwargs.get("flags", 0)
    if operator.index(flags) & ~REGEX_FLAG_MASK:
        raise ValueError("unsupported regex flags")
    return function(*args, **kwargs)


SCOPED_MODULES = {
    module: {name: getattr(MODULES[module], name) for name in names}
    for module, names in MODULE_MEMBERS.items()
}
for _name in ("factorial", "comb", "perm"):
    SCOPED_MODULES["math"][_name] = partial(_bounded_combinatoric, getattr(math, _name))
for _flags_index, _names in enumerate((
    ("compile",), ("findall", "finditer", "fullmatch", "match", "search"), ("split",), ("sub", "subn"),
), start=1):
    for _name in _names:
        SCOPED_MODULES["re"][_name] = partial(_restricted_regex, getattr(re, _name), _flags_index)
PURE_BUILTINS.update(pow=_bounded_power, range=_BoundedRange)

GUARDED_OPERATORS = {
    ast.Pow: ("__verifier_power", _bounded_power),
    ast.LShift: ("__verifier_left_shift", _bounded_left_shift),
}
GUARD_BINDINGS = dict(GUARDED_OPERATORS.values())


def _operator_call(helper, left, right):
    return ast.Call(func=ast.Name(id=helper, ctx=ast.Load()), args=[left, right], keywords=[])


class _GuardOperations(ast.NodeTransformer):
    def visit_BinOp(self, node):
        self.generic_visit(node)
        guard = GUARDED_OPERATORS.get(type(node.op))
        if guard is None:
            return node
        helper, _ = guard
        return ast.copy_location(_operator_call(helper, node.left, node.right), node)

    def visit_AugAssign(self, node):
        self.generic_visit(node)
        guard = GUARDED_OPERATORS.get(type(node.op))
        if guard is None:
            return node
        helper, _ = guard
        target = node.target
        if isinstance(target, ast.Name):
            value = _operator_call(helper, ast.Name(id=target.id, ctx=ast.Load()), node.value)
            return ast.copy_location(ast.Assign(targets=[target], value=value), node)

        # An augmented subscript evaluates its receiver and index once, then reads
        # the current value before evaluating the right-hand side.
        receiver = "__verifier_receiver"
        index = "__verifier_index"
        read_target = ast.Subscript(
            value=ast.Name(id=receiver, ctx=ast.Load()), slice=ast.Name(id=index, ctx=ast.Load()), ctx=ast.Load(),
        )
        write_target = ast.Subscript(value=read_target.value, slice=read_target.slice, ctx=ast.Store())
        return [ast.copy_location(statement, node) for statement in (
            ast.Assign(targets=[ast.Name(id=receiver, ctx=ast.Store())], value=target.value),
            ast.Assign(targets=[ast.Name(id=index, ctx=ast.Store())], value=target.slice),
            ast.Assign(targets=[write_target], value=_operator_call(helper, read_target, node.value)),
            ast.Delete(targets=[ast.Name(id=receiver, ctx=ast.Del()), ast.Name(id=index, ctx=ast.Del())]),
        )]


def _compile(tree, filename, mode, needs_guards):
    if needs_guards:
        tree = ast.fix_missing_locations(_GuardOperations().visit(tree))
    return compile(tree, filename, mode, optimize=0)


def compile_expression(node):
    needs_guards = any(isinstance(part, (ast.Pow, ast.LShift)) for part in ast.walk(node))
    expression = ast.fix_missing_locations(ast.Expression(deepcopy(node) if needs_guards else node))
    return _compile(expression, "<example>", "eval", needs_guards)


def python_scope(printer):
    modules = {name: SimpleNamespace(**members) for name, members in SCOPED_MODULES.items()}

    def safe_import(name, globals=None, locals=None, fromlist=(), level=0):
        if level or name not in modules:
            raise ImportError
        return modules[name]

    return {
        "__builtins__": dict(PURE_BUILTINS, __import__=safe_import, print=printer),
        **GUARD_BINDINGS, **modules,
    }


@dataclass(frozen=True)
class Assertion:
    code: object
    test: ast.expr


@dataclass(frozen=True)
class Problem:
    entry: str
    arity: int
    assertions: tuple[Assertion, ...]


class AssertionProblem(ValueError):
    def __init__(self, reason, index=None):
        self.reason = reason
        self.index = index


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
    return _build_problem(parsed.body)


def _build_problem(nodes):
    result = []
    calls_in_assertion = []
    bindings_in_assertion = []
    for index, node in enumerate(nodes):
        bound_names = set()
        try:
            needs_guards = inspect_tree(node, EXPRESSION_NODES, bound_names)
            if isinstance(node.test, ast.Tuple):
                raise UnsupportedSyntax
            tree = ast.Module(body=[deepcopy(node) if needs_guards else node], type_ignores=[])
            code = _compile(tree, "<assertion>", "exec", needs_guards)
        except (UnsupportedSyntax, SyntaxError, ValueError):
            raise AssertionProblem("unsupported-assertion", index) from None
        result.append(Assertion(code, node.test))
        bindings_in_assertion.append(bound_names)
        calls_in_assertion.append([
            item for item in ast.walk(node.test)
            if isinstance(item, ast.Call) and isinstance(item.func, ast.Name)
        ])

    common = set.intersection(*({call.func.id for call in calls} for calls in calls_in_assertion))
    custom_names = common.difference(PURE_BUILTINS, MODULES, {"print"})
    names = custom_names or common
    if len(names) != 1:
        raise AssertionProblem("unsupported-assertion", 0)
    entry = names.pop()
    arity = None
    for index, calls in enumerate(calls_in_assertion):
        if entry in bindings_in_assertion[index]:
            raise AssertionProblem("unsupported-assertion", index)
        for call in calls:
            if call.func.id != entry:
                continue
            if call.keywords or any(isinstance(arg, ast.Starred) for arg in call.args):
                raise AssertionProblem("unsupported-arguments", index)
            if arity is None:
                arity = len(call.args)
            if arity != len(call.args):
                raise AssertionProblem("unsupported-arguments", index)
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
        needs_guards = False
        for node in parsed.body:
            if isinstance(node, (ast.Import, ast.ImportFrom)) and any(
                (alias.asname or alias.name) == problem.entry for alias in node.names
            ):
                raise UnsupportedSyntax
            needs_guards = inspect_tree(node, CANDIDATE_NODES) or needs_guards
        return _compile(parsed, "<candidate>", "exec", needs_guards)
    except (SyntaxError, ValueError, RecursionError):
        raise UnsupportedSyntax from None
