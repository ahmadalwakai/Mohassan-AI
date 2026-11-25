"""Check source literals and text fields against both capability v2 exclusion partitions.

Run this test in the scratch merge with the v2 contamination audit branch.
"""

from collections import Counter
from pathlib import Path
import re
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_SCRIPTS = ROOT / 'scripts/agent-capability-bench/v2'
BENCHMARK_PATHS = ('scripts/agent-capability-bench/', 'tests/fixtures/agent-capability-bench/')
BENCHMARK_DATA_CARD = 'docs/CAPABILITY-BENCH-V2-DATA.md'
BASELINE = 'c2a0ff765071657cf200b5ee7d12fabaad738c0b'
WAVE_2_BASE = 'ee22b23041284a801f50f5930a875565c6f11785'
WAVE_2_SOURCES = frozenset({
    'apps/server/src/assistant/review/language.ts',
    'packages/scratch-classifiers/data/label-map.json',
    'scripts/conversation-state/decision-eval.ts',
    'tests/conversation-state-decides-chat.test.ts',
    'tests/conversation-state-decisions.test.ts',
})

QUOTED_FIELDS = tuple(re.compile(pattern) for pattern in (
    r"'((?:\\[^\n]|[^'\\\n])*)'",
    r'"((?:\\[^\n]|[^"\\\n])*)"',
    r'`((?:\\[\s\S]|[^`\\])*)`',
    r"'''((?:\\[\s\S]|(?:(?!''')[^\\]))*)'''",
    r'"""((?:\\[\s\S]|(?:(?!""")[^\\]))*)"""',
))

ESCAPE = re.compile(r'\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|x([0-9a-fA-F]{2})|([\\\'"`tnrvfb/]))')
ESCAPED_CHARACTER = {'t': '\t', 'n': '\n', 'r': '\r', 'v': '\v', 'f': '\f', 'b': '\b'}
PARAGRAPH_SEPARATOR = re.compile(r'\n[ \t]*\n')


def decode_literal(value):
    def replace(match):
        *hex_digits, special = match.groups()
        if special:
            return ESCAPED_CHARACTER.get(special, special)
        code_point = int(next(digits for digits in hex_digits if digits), 16)
        return chr(code_point) if code_point <= 0x10FFFF else match[0]

    decoded = ESCAPE.sub(replace, value)
    return decoded.encode('utf-16-le', errors='surrogatepass').decode('utf-16-le', errors='replace')


def matching_fields(text, hashes, digest):
    matches = Counter()
    for line in text.splitlines():
        if line.strip() and (fingerprint := digest(line)) in hashes:
            matches[fingerprint, line] += 1
    for paragraph in PARAGRAPH_SEPARATOR.split(text):
        if '\n' in paragraph.strip() and (fingerprint := digest(paragraph)) in hashes:
            matches[fingerprint, paragraph] += 1

    matched_spans = set()
    for pattern in QUOTED_FIELDS:
        for match in pattern.finditer(text):
            span = match.span(1)
            if not match[1] or span in matched_spans:
                continue
            if (fingerprint := digest(decode_literal(match[1]))) in hashes:
                matched_spans.add(span)
                line_start = text.rfind('\n', 0, match.start()) + 1
                line_end = text.find('\n', match.end())
                context = text[line_start:] if line_end < 0 else text[line_start:line_end]
                matches[fingerprint, context] += 1
    return matches


def repository_files():
    files = subprocess.check_output(
        ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=ROOT,
    )
    for name in sorted(set(files.decode('utf-8').split('\0')) - {''}):
        if name != BENCHMARK_DATA_CARD and not name.startswith(BENCHMARK_PATHS):
            yield name


class CapabilityV2CaseStringsTest(unittest.TestCase):
    def test_scan_counts_new_occurrences_and_decodes_literals(self):
        def digest(text):
            return ' '.join(text.casefold().split())

        example = 'Why did the lantern flicker at noon?'
        hashes = {digest(example)}
        source = r'const query = "\u0057hy did the lantern flicker at noon?";'
        original = matching_fields(source, hashes, digest)
        repeated = matching_fields(f'{source}\n{source}', hashes, digest)
        self.assertEqual(original.total(), 1)
        self.assertEqual((repeated - original).total(), 1)
        self.assertEqual(matching_fields(example.replace('flicker', 'flicker\n'), hashes, digest).total(), 1)
        self.assertFalse(matching_fields('The lantern flickered after noon.', hashes, digest))

    def test_strings_are_absent_from_new_source(self):
        # Use the audit's hashed index to keep the holdout payload closed.
        self.assertTrue((BENCHMARK_SCRIPTS / 'exclusion.py').is_file(), 'Run this test in the v2 audit scratch merge.')
        sys.path.insert(0, str(BENCHMARK_SCRIPTS))
        try:
            from exclusion import Exclusions, text_sha256
        finally:
            sys.path.pop(0)

        exclusion = Exclusions.load()
        for revision in (BASELINE, WAVE_2_BASE):
            subprocess.run(['git', 'cat-file', '-e', f'{revision}^{{commit}}'], cwd=ROOT, capture_output=True, check=True)
        violations = {}
        for name in repository_files():
            path = ROOT / name
            if path.is_symlink() or not path.is_file():
                continue
            try:
                source = path.read_text(encoding='utf-8')
            except UnicodeDecodeError:
                continue
            matches = matching_fields(source, exclusion.text_hashes, text_sha256)
            if not matches:
                continue

            # Familiar utterances already occur in baseline files. Only byte-for-byte
            # matching surrounding source in the same file can account for them.
            revision = WAVE_2_BASE if name in WAVE_2_SOURCES else BASELINE
            old_source = subprocess.run(
                ['git', 'show', f'{revision}:{name}'], cwd=ROOT, capture_output=True, check=False,
            )
            if old_source.returncode == 0:
                baseline = old_source.stdout.decode('utf-8', errors='replace').replace('\r\n', '\n')
                matches -= matching_fields(baseline, exclusion.text_hashes, text_sha256)
            if matches:
                violations[name] = matches.total()

        # Report paths and counts without showing matching holdout text.
        self.assertEqual(violations, {})


if __name__ == '__main__':
    unittest.main()
