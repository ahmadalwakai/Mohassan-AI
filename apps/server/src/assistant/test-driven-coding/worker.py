"""One isolated request for Python synthesis or fresh assertion verification."""

import ast
from contextlib import contextmanager, redirect_stderr, redirect_stdout
import json
import os.path
import signal
import sys
import warnings

# Isolated mode removes the script directory from Python's module search.
# Add only the directory of this trusted, packaged worker and its siblings.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from assertions import (
    AssertionProblem, UnsupportedSyntax, compile_candidate, compile_expression, example_nodes,
    parse_assertions, python_scope,
)
from isolation import IsolationUnavailable, isolate
from synthesis import synthesize


MAX_INPUT_BYTES = 64 * 1024
MAX_CANDIDATE_BYTES = 8192
MAX_OUTPUT_BYTES = 8192
CANDIDATE_SECONDS = 0.075
_deadline_armed = False


class TimeLimit(Exception):
    pass


class OutputLimit(Exception):
    pass


def _timed_out(_number, _frame):
    if _deadline_armed:
        raise TimeLimit


@contextmanager
def _attempt_deadline():
    global _deadline_armed
    _deadline_armed = True
    try:
        signal.setitimer(signal.ITIMER_REAL, CANDIDATE_SECONDS)
        yield
    finally:
        _deadline_armed = False
        signal.setitimer(signal.ITIMER_REAL, 0)


class _OutputBudget:
    remaining = MAX_OUTPUT_BYTES

    def write(self, value):
        size = len(value)
        if size > self.remaining or (size := len(value.encode("utf-8"))) > self.remaining:
            raise OutputLimit
        self.remaining -= size

    def flush(self):
        pass

    def print(self, *values, **kwargs):
        print(*values, file=self, **kwargs)


def _failed(reason, index=None, tried=None):
    result = {"status": "failed", "reason": reason}
    if index is not None:
        result["assertionIndex"] = index
    if tried is not None:
        result["tried"] = tried
    return result


def _verify(source, problem):
    if not isinstance(source, str) or len(source.encode("utf-8")) > MAX_CANDIDATE_BYTES:
        return _failed("unsupported-candidate")
    output = _OutputBudget()
    candidate_scope = python_scope(output.print)
    assertion_scope = python_scope(output.print)
    index = 0
    calls = 0

    def call_candidate(*args, **kwargs):
        nonlocal calls
        calls += 1
        return candidate(*args, **kwargs)

    try:
        with _attempt_deadline():
            exec(compile_candidate(source, problem), candidate_scope)
            candidate = candidate_scope[problem.entry]
            assertion_scope[problem.entry] = call_candidate
            for index, assertion in enumerate(problem.assertions):
                previous_calls = calls
                exec(assertion.code, assertion_scope)
                if calls == previous_calls:
                    raise AssertionError
        return {"status": "passed"}
    except UnsupportedSyntax:
        return _failed("unsupported-candidate")
    except AssertionError:
        reason = "assertion-failed"
    except TimeLimit:
        reason = "time-limit"
    except OutputLimit:
        reason = "output-limit"
    except MemoryError:
        reason = "memory-limit"
    except Exception:
        reason = "assertion-error"
    return _failed(reason, index)


def _sample_value(value, depth=0):
    if depth > 24:
        return False
    value_type = type(value)
    if value_type in (str, bytes):
        return len(value) <= 8192
    if value is None or value_type in (bool, int, float, complex):
        return True
    if value_type is dict:
        return len(value) <= 2048 and all(
            _sample_value(key, depth + 1) and _sample_value(item, depth + 1)
            for key, item in value.items()
        )
    if value_type in (list, tuple, set, frozenset):
        return len(value) <= 2048 and all(_sample_value(item, depth + 1) for item in value)
    return False


def _examples(problem, on_timeout):
    def evaluate(node):
        if any(isinstance(part, ast.Name) and part.id == problem.entry for part in ast.walk(node)):
            raise ValueError
        scope = python_scope(_OutputBudget().print)
        result = eval(compile_expression(node), scope)
        if not _sample_value(result):
            raise ValueError
        return result

    for inputs, expected in example_nodes(problem):
        try:
            with _attempt_deadline():
                example = (tuple(evaluate(node) for node in inputs), evaluate(expected))
        except TimeLimit:
            on_timeout()
            continue
        except Exception:
            # Non-literal test forms still run in the final verifier.
            continue
        yield example


def _solve(description, problem):
    limits = {}

    def example_timeout():
        limits["exampleTimeout"] = True

    def search_limit(reason):
        limits["searchLimit"] = reason

    examples = tuple(_examples(problem, example_timeout))
    if not examples:
        return {**_failed("no-supported-examples", tried=0), **limits}

    tried = 0
    verified_source = None
    best_failure = None

    def verify(source):
        nonlocal tried, verified_source, best_failure
        tried += 1
        result = _verify(source, problem)
        if result["status"] == "passed":
            verified_source = source
            return True
        if best_failure is None or result.get("assertionIndex", -1) > best_failure.get("assertionIndex", -1):
            best_failure = result
        return False

    candidate = synthesize(problem.entry, description, examples, verify, on_limit=search_limit)
    if candidate is not None and candidate == verified_source:
        return {"status": "passed", "source": verified_source, "tried": tried}
    if best_failure is not None:
        return {**best_failure, "tried": tried, **limits}
    return {**_failed("no-candidate-passed", tried=tried), **limits}


def _request():
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        return _failed("invalid-request")
    try:
        payload = json.loads(raw)
    except (ValueError, RecursionError):
        return _failed("invalid-request")
    if not isinstance(payload, dict) or payload.get("mode") not in ("solve", "verify"):
        return _failed("invalid-request")
    try:
        problem = parse_assertions(payload.get("assertions"))
    except AssertionProblem as error:
        return _failed(error.reason, error.index)
    if payload["mode"] == "verify":
        return _verify(payload.get("source"), problem)
    description = payload.get("description")
    if not isinstance(description, str):
        return _failed("invalid-request")
    return _solve(description, problem)


class _Sink:
    def write(self, value):
        return len(value)

    def flush(self):
        pass


def _run():
    try:
        isolate()
    except IsolationUnavailable:
        return {"status": "unavailable", "reason": "isolation-unavailable"}
    signal.signal(signal.SIGALRM, _timed_out)
    try:
        return _request()
    except MemoryError:
        return _failed("memory-limit")
    except (UnicodeError, RecursionError):
        return _failed("invalid-request")


def main():
    output = sys.stdout
    sink = _Sink()
    try:
        with redirect_stdout(sink), redirect_stderr(sink), warnings.catch_warnings():
            warnings.simplefilter("ignore")
            result = _run()
        response = json.dumps(result, ensure_ascii=True, separators=(",", ":"))
    except BaseException:
        response = '{"status":"failed","reason":"internal-error"}'
    output.write(response + "\n")


if __name__ == "__main__":
    main()
