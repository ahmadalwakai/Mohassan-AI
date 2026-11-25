"""Check both v2 partitions in a scratch merge with test/v2-contamination-audit.

Run with `python3 -B -m unittest discover -s tests -p test_v2_source_leakage.py -v`.
The check reads the audit's hashed registry and reports only source paths and counts.
"""

from collections import Counter
from collections.abc import Iterator
from pathlib import Path
import re
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
BASE = "f50520112a23632ec4f6e4a121018077d1c422be"
AUDIT = ROOT / "scripts/agent-capability-bench/v2"
if not (AUDIT / "exclusion.py").is_file():
    raise RuntimeError("Run the source leakage check in a scratch merge with test/v2-contamination-audit.")
sys.path.insert(0, str(AUDIT))
from exclusion import Exclusions, text_sha256


BENCHMARK_PREFIXES = (
    "docs/CAPABILITY-BENCH-",
    "scripts/agent-capability-bench/",
    "tests/fixtures/agent-capability-bench/",
)
SOURCE_LINE_PREFIX = re.compile(r"^\s*(?://+|/\*+|\*|#|>+|[-+])\s*")
QUOTED = re.compile(
    r'''"((?:\\[^\r\n]|[^"\\\r\n])*)"'''
    r"|(?<!\w)'((?:\\[^\r\n]|[^'\\\r\n])*)'"
    r"|`((?:\\[\s\S]|[^`\\])*)`"
)
ESCAPE = re.compile(
    r'''\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([\\'"`nrt]))'''
)
ESCAPED_CHARACTERS = {"n": "\n", "r": "\r", "t": "\t"}


def decode_literal_fragment(match: re.Match[str]) -> str:
    braced, unicode, byte, character = match.groups()
    codepoint = braced or unicode or byte
    if codepoint is None:
        return ESCAPED_CHARACTERS.get(character, character)
    value = int(codepoint, 16)
    return chr(value) if value <= 0x10FFFF else match[0]


def decode_literal(value: str) -> str:
    decoded = ESCAPE.sub(decode_literal_fragment, value)
    # An escaped JS/JSON surrogate pair represents one Unicode character.
    return decoded.encode("utf-16", errors="surrogatepass").decode("utf-16", errors="replace")


def source_spans(text: str) -> Iterator[set[str]]:
    """Yield full source lines, comment lines, and string literal contents."""
    for line in text.splitlines():
        yield {line, SOURCE_LINE_PREFIX.sub("", line)}
    for quote in QUOTED.finditer(text):
        value = next(group for group in quote.groups() if group is not None)
        yield {value, decode_literal(value)}


def matching_digests(data: bytes, exclusions: Exclusions) -> Counter[str]:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return Counter()

    matches = Counter()
    for variants in source_spans(text):
        digests = {text_sha256(value) for value in variants if value.strip()}
        matches.update(digests & exclusions.text_hashes)
    return matches


def git(*args: str, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, check=check)


class SourceLeakageTest(unittest.TestCase):
    def test_finds_plain_and_escaped_source_strings(self):
        sample = "Orbit above a violet orchard."
        digest = text_sha256(sample)
        exclusions = Exclusions(frozenset(), frozenset({digest}))
        data = b'// ORBIT ABOVE A VIOLET ORCHARD.\nconst sample = "Orbit above a violet \\u006frchard.";'
        self.assertEqual(matching_digests(data, exclusions), Counter({digest: 2}))

    def test_source_tree_adds_no_case_strings(self):
        exclusions = Exclusions.load()
        git("cat-file", "-e", f"{BASE}^{{commit}}")
        paths = git("ls-files", "-z", "--cached", "--others", "--exclude-standard").stdout
        hits = {}
        for name in sorted(set(paths.decode("utf-8").split("\0")) - {""}):
            source = ROOT / name
            if name.startswith(BENCHMARK_PREFIXES) or source.is_symlink() or not source.is_file():
                continue
            current = matching_digests(source.read_bytes(), exclusions)
            if not current:
                continue
            # Preserve incidental overlap already present in the pinned PR #40 base.
            original = git("show", f"{BASE}:{name}", check=False)
            inherited = matching_digests(original.stdout, exclusions) if original.returncode == 0 else Counter()
            introduced = current - inherited
            if introduced:
                hits[name] = introduced.total()
        self.assertEqual(hits, {}, "New v2 case-string matches by source path and occurrence count")
