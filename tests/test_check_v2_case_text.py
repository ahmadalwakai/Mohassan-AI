from pathlib import Path
import tempfile
import unittest

from scripts.check_v2_case_text import find_new_case_text, git


class CaseTextGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.repo = Path(directory.name)
        git(self.repo, "init", "--quiet")

    def write(self, filename: str, text: str) -> None:
        file = self.repo / filename
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text, encoding="utf-8")

    def baseline(self) -> str:
        git(self.repo, "add", "--all")
        return git(self.repo, "write-tree").decode("ascii").strip()

    def test_detects_both_partitions_in_new_and_modified_source(self) -> None:
        dev = "Synthetic sample for a test.\nIt spans two lines."
        sealed = "Synthetic Arabic sample لغة لاختبار الترميز"
        self.write("code.ts", "// Source already in the repository\n")
        baseline = self.baseline()
        self.write("code.ts", "/* " + dev + " */\n")
        self.write("more.json", '"' + sealed.encode("unicode_escape").decode("ascii") + '"\n')

        hits = find_new_case_text(self.repo, {"dev": {dev}, "sealed": {sealed}}, baseline)

        self.assertEqual([(filename, partition) for filename, partition, _ in hits], [
            ("code.ts", "dev"), ("more.json", "sealed"),
        ])
        self.assertTrue(all(len(digest) == 64 for _, _, digest in hits))

    def test_preserves_existing_occurrences_and_detects_a_new_copy(self) -> None:
        text = "A synthetic shared phrase."
        line = f'const phrase = "{text}";\n'
        self.write("code.ts", line)
        baseline = self.baseline()
        cases = {"dev": {text}}
        self.write("code.ts", "// A new line above the original\n" + line)
        self.assertEqual(find_new_case_text(self.repo, cases, baseline), [])
        self.write("code.ts", "// A new line above the original\n" + line * 2)
        self.assertEqual(len(find_new_case_text(self.repo, cases, baseline)), 1)

    def test_excludes_benchmark_fixtures_and_ignored_generated_files(self) -> None:
        text = "A synthetic phrase for an ignored file."
        self.write(".gitignore", "generated/\n")
        baseline = self.baseline()
        self.write("tests/fixtures/agent-capability-bench/v2/dev/payload.json", text)
        self.write("scripts/agent-capability-bench/read.ts", text)
        self.write("generated/fixture.json", text)
        self.assertEqual(find_new_case_text(self.repo, {"dev": {text}}, baseline), [])


if __name__ == "__main__":
    unittest.main()
