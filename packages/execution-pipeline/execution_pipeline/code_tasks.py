"""Synthetic bilingual, bounded TypeScript tasks for the local scratch model.

This module creates training targets; it is never an inference fallback. Model
answers must be executed separately by scripts/code-training/verify.ts inside the
existing AppContainer sandbox. Python oracles below compute expected behavior
without interpreting target source. Held-out sets use unseen function names and,
for code_unseen, request phrasings excluded from training. They test new instances
of known task families, not arbitrary programming ability.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import string
from pathlib import Path
from typing import Any

VERSION = "bilingual-typescript-functions-v1"
FAMILIES = ("add", "multiply", "clamp", "normalize", "array_sum", "count_above", "fallback", "offset")
IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,47}\Z")
SPLIT_OFFSET = {"train": 0, "validation": 10000, "code_test": 20000, "code_unseen": 30000}
IDENTIFIER_STYLES = ("sequential-v1", "diverse-v2")
REQUESTS = {
    "en": {
        "implement": ("Write the TypeScript function {name}: {description}",
                      "Implement {name} in TypeScript. {description}",
                      "Create an exported function named {name}. {description}",
                      "I need a TypeScript function {name}. {description}"),
        "repair": ("Fix this TypeScript function {name}. {description}",
                   "Repair the function {name} using the failing test. {description}",
                   "Correct the bug in {name}. {description}",
                   "Make {name} satisfy its contract and regression tests. {description}"),
        "unseen_implement": ("Could you code {name} for me? Here is the required behavior: {description}",
                             "Please supply the implementation of {name}, with this behavior: {description}"),
        "unseen_repair": ("The attached implementation of {name} is wrong; please correct it. {description}",
                          "Help me debug {name} so the following requirement holds: {description}"),
    },
    "ar": {
        "implement": ("اكتب دالة TypeScript باسم {name}: {description}",
                      "نفذ الدالة {name} بلغة TypeScript. {description}",
                      "أنشئ دالة مصدرة اسمها {name}. {description}",
                      "أحتاج دالة TypeScript باسم {name}. {description}"),
        "repair": ("أصلح دالة TypeScript هذه باسم {name}. {description}",
                   "صحح الدالة {name} باستخدام الاختبار الفاشل. {description}",
                   "عالج الخطأ في الدالة {name}. {description}",
                   "اجعل الدالة {name} تحقق المواصفات والاختبارات. {description}"),
        "unseen_implement": ("هل يمكنك برمجة {name}؟ السلوك المطلوب هو: {description}",
                             "من فضلك جهز تنفيذ {name} حسب التالي: {description}"),
        "unseen_repair": ("التنفيذ المرفق للدالة {name} خاطئ؛ أرجو تصحيحه. {description}",
                          "ساعدني في تصحيح {name} حتى تحقق هذا الشرط: {description}"),
    },
}


def _compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def specification(family: str, parameters: dict[str, int]) -> dict[str, str]:
    """Explicit typed contract and training target expression; no model invocation."""
    if family == "add":
        return {"arguments": "a: number, b: number", "returns": "number", "expression": "a + b", "bug": "a - b",
                "en": "Return the sum of a and b.", "ar": "أعد مجموع a و b."}
    if family == "multiply":
        return {"arguments": "a: number, b: number", "returns": "number", "expression": "a * b", "bug": "a + b",
                "en": "Return the product of a and b.", "ar": "أعد حاصل ضرب a في b."}
    if family == "clamp":
        low, high = parameters["minimum"], parameters["maximum"]
        if not -50 <= low < high <= 50:
            raise ValueError("Invalid clamp bounds")
        return {"arguments": "value: number", "returns": "number",
                "expression": f"Math.max({low}, Math.min({high}, value))", "bug": f"Math.min({low}, Math.max({high}, value))",
                "en": f"Clamp value to the inclusive interval [{low}, {high}].",
                "ar": f"احصر value داخل المجال من {low} إلى {high} شاملا الحدين."}
    if family == "normalize":
        return {"arguments": "value: string", "returns": "string", "expression": "value.trim().toLowerCase()", "bug": "value.trim()",
                "en": "Remove surrounding whitespace and convert the string to lowercase.",
                "ar": "احذف المسافات من بداية النص ونهايته وحول الحروف إلى صغيرة."}
    if family == "array_sum":
        return {"arguments": "values: number[]", "returns": "number",
                "expression": "values.reduce((total, value) => total + value, 0)",
                "bug": "values.reduce((total, value) => total + value, 1)",
                "en": "Return the sum of all array elements; an empty array returns zero.",
                "ar": "أعد مجموع عناصر المصفوفة؛ المصفوفة الفارغة تعيد صفرا."}
    if family == "count_above":
        threshold = parameters["threshold"]
        return {"arguments": "values: number[]", "returns": "number",
                "expression": f"values.filter(value => value > {threshold}).length",
                "bug": f"values.filter(value => value >= {threshold}).length",
                "en": f"Count array values strictly greater than {threshold}; exclude values equal to it.",
                "ar": f"احسب عدد عناصر المصفوفة الأكبر من {threshold} حصرا؛ لا تحسب المساوية له."}
    if family == "fallback":
        default = parameters["default"]
        return {"arguments": "value: number | null | undefined", "returns": "number",
                "expression": f"value ?? {default}", "bug": f"value || {default}",
                "en": f"Return {default} only for null or undefined; otherwise preserve value, including zero.",
                "ar": f"أعد {default} فقط إذا كانت value هي null أو undefined؛ وإلا أعدها كما هي حتى لو كانت صفرا."}
    if family == "offset":
        amount = parameters["amount"]
        return {"arguments": "value: number | null | undefined", "returns": "number",
                "expression": f"value == null ? 0 : value + {amount}", "bug": f"value == null ? 0 : value - {amount}",
                "en": f"Return zero for null or undefined; otherwise add {amount} to value.",
                "ar": f"أعد صفرا إذا كانت value هي null أو undefined؛ وإلا أضف {amount} إلى value."}
    raise ValueError("Unsupported code family")


def source(function_name: str, spec: dict[str, str], *, buggy: bool = False) -> str:
    if not IDENTIFIER.fullmatch(function_name):
        raise ValueError("Invalid function name")
    expression = spec["bug"] if buggy else spec["expression"]
    return f"export function {function_name}({spec['arguments']}): {spec['returns']} {{\n  return {expression};\n}}"


def expected(family: str, args: list[Any], parameters: dict[str, int]) -> Any:
    """Independent behavioral oracle, expressed in Python operations, not TS source."""
    value = args[0] if args else None
    if family == "add":
        return args[0] + args[1]
    if family == "multiply":
        return args[0] * args[1]
    if family == "clamp":
        if value < parameters["minimum"]:
            return parameters["minimum"]
        if value > parameters["maximum"]:
            return parameters["maximum"]
        return value
    if family == "normalize":
        return value.strip().lower()
    if family == "array_sum":
        return sum(value)
    if family == "count_above":
        return sum(1 for item in value if item > parameters["threshold"])
    if family == "fallback":
        return parameters["default"] if value is None else value
    if family == "offset":
        return 0 if value is None else value + parameters["amount"]
    raise ValueError("Unsupported code family")


def probes(family: str, parameters: dict[str, int], *, seed: int = 0) -> list[dict[str, Any]]:
    rng = random.Random(seed)
    if family in {"add", "multiply"}:
        arguments = [[0, 0], [2, 3], [-4, 7], [0, 9], [-8, -2], [1.5, -2.25]]
        arguments += [[rng.randint(-500, 500), rng.randint(-500, 500)] for _ in range(4)]
    elif family == "clamp":
        lo, hi = parameters["minimum"], parameters["maximum"]
        arguments = [[v] for v in (lo - 100, lo - 1, lo, (lo + hi) / 2, hi, hi + 1, hi + 100)]
    elif family == "normalize":
        arguments = [[v] for v in ("", "  HELLO  ", " MixED Case ", "\tAlpha BETA\n", "   ", " مرحبا  ", "a B")]
    elif family == "array_sum":
        arguments = [[v] for v in ([], [0], [3], [1, 2, 3], [-4, 3], [1.5, -2.25, 4.75], [100, -100, 7])]
    elif family == "count_above":
        t = parameters["threshold"]
        arguments = [[v] for v in ([], [t], [t - 1], [t + 1], [t, t, t + 1], [t + 0.5, t - 0.5], [t + 3, t + 9, t - 2])]
    elif family in {"fallback", "offset"}:
        # Calling with no arguments tests undefined without string sentinels.
        arguments = [[], [None], [0], [-9], [13], [2.5], [-0.5]]
    else:
        raise ValueError("Unsupported code family")
    return [{"args": args, "expected": expected(family, args, parameters)} for args in arguments]


def _failure(family: str, parameters: dict[str, int]) -> dict[str, Any]:
    """Concrete bug witness, independently computed from the defective operation."""
    if family == "add":
        args, observed = [2, 3], -1
    elif family == "multiply":
        args, observed = [2, 3], 5
    elif family == "clamp":
        args, observed = [parameters["maximum"] + 1], parameters["minimum"]
    elif family == "normalize":
        args, observed = ["  HELLO  "], "HELLO"
    elif family == "array_sum":
        args, observed = [[]], 1
    elif family == "count_above":
        args, observed = [[parameters["threshold"]]], 1
    elif family == "fallback":
        args, observed = [0], parameters["default"]
    elif family == "offset":
        args, observed = [2], 2 - parameters["amount"]
    else:
        raise ValueError("Unsupported code family")
    correct = expected(family, args, parameters)
    if observed == correct:
        raise ValueError("Repair witness does not fail")
    return {"args": args, "observed": observed, "expected": correct}


def render_prompt(given: dict[str, Any]) -> str:
    """Shared inference/training renderer. Probes and target source are not appended."""
    prompt = f"Code task:\nRequest: {given['message']}\nSignature: {given['signature']}\nReturn only the complete exported TypeScript function.\n"
    if given["mode"] == "repair":
        prompt += f"Broken:\n{given['failed_candidate']}\nFailing test: {_compact(given['failure_evidence'])}\n"
    return prompt + "Output:\n"


def make_record(family: str, function_name: str, parameters: dict[str, int], *, language: str = "en",
                mode: str = "implement", variant: int = 0, split: str = "train", seed: int = 0) -> dict[str, Any]:
    if language not in {"ar", "en"} or mode not in {"implement", "repair"} or split not in SPLIT_OFFSET:
        raise ValueError("Invalid language, mode or split")
    spec = specification(family, parameters)
    key = ("unseen_" if split == "code_unseen" else "") + mode
    templates = REQUESTS[language][key]
    message = templates[variant % len(templates)].format(name=function_name, description=spec[language])
    given = {"message": message, "family": family, "functionName": function_name, "parameters": parameters,
             "language": language, "mode": mode,
             "signature": f"{function_name}({spec['arguments']}): {spec['returns']}",
             "probes": probes(family, parameters, seed=seed)}
    if mode == "repair":
        given.update(failed_candidate=source(function_name, spec, buggy=True), failure_evidence=_failure(family, parameters))
    target = source(function_name, spec)
    identity = hashlib.sha256(_compact([VERSION, split, given]).encode()).hexdigest()[:20]
    return {"id": f"code-{identity}", "split": split, "language": language, "family": family,
            "source": VERSION, "capability": f"code.{mode}.v1", "input": given,
            "output": target, "prompt": render_prompt(given), "target": target}


def identifier_partition(name: str) -> str:
    """Stable name-only partition, independent of task family and generation seed."""
    bucket = int(hashlib.sha256(("code-identifiers-v2:" + name).encode()).hexdigest()[:8], 16) % 100
    return "train" if bucket < 80 else "validation" if bucket < 90 else "code_test" if bucket < 95 else "code_unseen"


def diverse_identifiers(split: str, count: int, *, seed: int = 1729) -> list[tuple[str, str]]:
    """Match identifier-style distributions across disjoint deterministic partitions.

    Names have no task-family argument. The same candidate stream feeds every
    split; a stable SHA-256 partition selects membership rather than a split-
    specific prefix, suffix length or numeric range.
    """
    if split not in SPLIT_OFFSET or not 1 <= count <= 100000:
        raise ValueError("Invalid identifier split or count")
    rng = random.Random(seed)
    first = ("calculate", "combine", "resolve", "adjust", "inspect", "handle", "evaluate", "process",
             "build", "read", "make", "convert", "map", "check", "find", "get", "set")
    second = ("value", "data", "result", "input", "item", "task", "entry", "output", "list", "key", "amount", "number")
    categories = ("camel_case", "underscore", "alphanumeric", "short")
    found: list[tuple[str, str]] = []
    used: set[str] = set()
    while len(found) < count:
        category = rng.choice(categories)
        digits = rng.randrange(6)
        suffix = "" if not digits else str(rng.randrange(0 if digits == 1 else 10 ** (digits - 1), 10 ** digits))
        if category == "camel_case":
            name = rng.choice(first) + rng.choice(second).title() + rng.choice(("", "", "Now", "Next")) + suffix
        elif category == "underscore":
            name = rng.choice(("", "", "fn_")) + rng.choice(first) + "_" + rng.choice(second) + suffix
        elif category == "alphanumeric":
            stem = "".join(rng.choice(string.ascii_lowercase) for _ in range(rng.randint(1, 4)))
            tail = "".join(rng.choice(string.ascii_letters) for _ in range(rng.randint(1, 4)))
            name = stem + str(rng.randrange(100)) + tail + suffix
        else:
            name = "".join(rng.choice(string.ascii_lowercase) for _ in range(rng.randint(2, 8))) + suffix
        if name in used or identifier_partition(name) != split:
            continue
        used.add(name)
        found.append((name, category))
    return found


def _vary_parameter_names(record: dict[str, Any], *, seed: int) -> None:
    """Rename bound parameters consistently without changing positional probes."""
    given = record["input"]
    rng = random.Random(int(hashlib.sha256(f"parameter-names-v2:{seed}:{given['functionName']}".encode()).hexdigest(), 16))
    if given["family"] in {"add", "multiply"}:
        left, right = rng.choice((("a", "b"), ("left", "right"), ("x", "y"), ("first", "second")))
        mapping = {"a": left, "b": right}
    elif given["family"] in {"array_sum", "count_above"}:
        mapping = {"values": rng.choice(("values", "items", "numbers", "list"))}
    else:
        mapping = {"value": rng.choice(("value", "input", "item", "n"))}
    pattern = re.compile(r"\b(" + "|".join(re.escape(name) for name in mapping) + r")\b")
    rename = lambda text: pattern.sub(lambda match: mapping[match[0]], text)
    description = specification(given["family"], given["parameters"])[given["language"]]
    # Rename operands in the specification, not the English article "a" in
    # request wording such as "I need a TypeScript function".
    given["message"] = given["message"].replace(description, rename(description))
    given["signature"] = rename(given["signature"])
    if "failed_candidate" in given:
        given["failed_candidate"] = rename(given["failed_candidate"])
    record["target"] = rename(record["target"])
    record["output"] = record["target"]
    record["prompt"] = render_prompt(given)
    record["parameter_names"] = mapping


def generate_records(split: str, count: int, *, seed: int = 1729,
                     identifier_style: str = "sequential-v1") -> list[dict[str, Any]]:
    if split not in SPLIT_OFFSET or not 1 <= count <= 100000:
        raise ValueError("Invalid split or count")
    if identifier_style not in IDENTIFIER_STYLES:
        raise ValueError("Invalid identifier style")
    rng = random.Random(seed + SPLIT_OFFSET[split])
    diverse = diverse_identifiers(split, count, seed=seed) if identifier_style == "diverse-v2" else None
    records = []
    for index in range(count):
        family = FAMILIES[index % len(FAMILIES)]
        language = ("en", "ar")[(index // 8) % 2]
        mode = ("implement", "repair")[(index // 16) % 2]
        low = rng.randint(-15, 5)
        parameters = {"minimum": low, "maximum": low + rng.randint(1, 25), "threshold": rng.randint(-9, 9),
                      "default": rng.choice([n for n in range(-9, 10) if n]), "amount": rng.choice([n for n in range(-9, 10) if n])}
        # Names are disjoint across splits, while familiar syntax is shared.
        function_name = diverse[index][0] if diverse is not None else f"compute{SPLIT_OFFSET[split] + index // 32}"
        record = make_record(family, function_name, parameters, language=language, mode=mode,
                             variant=index // 32, split=split, seed=seed + index)
        if diverse is not None:
            _vary_parameter_names(record, seed=seed)
            record["source"] = VERSION + ":diverse-identifiers-v2"
            record["id"] = "code-v2-" + hashlib.sha256(_compact([VERSION, "diverse-v2", split, record["input"]]).encode()).hexdigest()[:20]
            record["identifier_style"] = identifier_style
            record["identifier_category"] = diverse[index][1]
            record["evaluation_scope"] = "development_only" if split in {"code_test", "code_unseen"} else split
        records.append(record)
    return records


def candidate_job(records: list[dict[str, Any]], *, answers: dict[str, str] | None = None,
                  buggy: bool = False) -> dict[str, Any]:
    """Package model answers or trusted target/bug fixtures for sandbox verification."""
    candidates = []
    for record in records:
        given = record["input"]
        if answers is not None:
            content = answers.get(record["id"], "")
        elif buggy:
            content = source(given["functionName"], specification(given["family"], given["parameters"]), buggy=True)
        else:
            content = record["target"]
        candidates.append({"id": record["id"], "content": content, "functionName": given["functionName"], "signature": given["signature"],
                           "probes": given["probes"], "language": record["language"], "family": record["family"],
                           "mode": given["mode"]})
    return {"version": VERSION, "candidates": candidates}


def write_dataset(directory: Path, *, train: int = 6000, validation: int = 240, test: int = 320,
                  unseen: int = 160, seed: int = 1729, identifier_style: str = "sequential-v1") -> dict[str, Any]:
    if identifier_style not in IDENTIFIER_STYLES:
        raise ValueError("Invalid identifier style")
    directory.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, Any] = {"version": VERSION, "seed": seed, "source": "locally authored synthetic contracts; no external model or data",
                               "limitations": "Known bounded TypeScript families only; unseen names and phrasings do not measure arbitrary programming.", "files": {}}
    if identifier_style == "diverse-v2":
        manifest.update(identifier_style=identifier_style,
                        identifier_partition="SHA-256(name): train 80%, validation 10%, development code_test/code_unseen 5% each",
                        evaluation_scope="development_only; original final held-out sets remain frozen")
    all_ids: set[str] = set()
    for split, count in (("train", train), ("validation", validation), ("code_test", test), ("code_unseen", unseen)):
        if count == 0 and split in {"code_test", "code_unseen"}:
            continue
        records = generate_records(split, count, seed=seed, identifier_style=identifier_style)
        ids = {record["id"] for record in records}
        if len(ids) != count or ids & all_ids:
            raise ValueError("Duplicate examples across splits")
        all_ids.update(ids)
        content = "\n".join(_compact(record) for record in records) + "\n"
        (directory / f"{split}.jsonl").write_text(content, encoding="utf-8")
        manifest["files"][split] = {"count": count, "sha256": hashlib.sha256(content.encode()).hexdigest(),
                                    "ar": sum(row["language"] == "ar" for row in records),
                                    "en": sum(row["language"] == "en" for row in records)}
    (directory / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--train", type=int, default=6000)
    parser.add_argument("--validation", type=int, default=240)
    parser.add_argument("--test", type=int, default=320)
    parser.add_argument("--unseen", type=int, default=160)
    parser.add_argument("--seed", type=int, default=1729)
    parser.add_argument("--identifier-style", choices=IDENTIFIER_STYLES, default="sequential-v1")
    args = parser.parse_args()
    print(json.dumps(write_dataset(args.output, train=args.train, validation=args.validation, test=args.test,
                                   unseen=args.unseen, seed=args.seed, identifier_style=args.identifier_style), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
