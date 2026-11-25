"""Focused tests for the character MinHash audit and its case accounting."""

import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/agent-capability-bench/v2"))
from contamination import TextIndex, audit, gram_overlap, minhash_bands, shingles


def case(case_id, source_id, text):
    return {"id": case_id, "provenance": {"source": source_id}, "turns": [{"text": text}]}


def row(role, texts, source_id=None, source_ids=()):
    return {
        "branch": 57, "source": "fixture", "split": role, "upstream_split": "test", "role": role,
        "texts": texts, "source_id": source_id, "source_ids": source_ids,
    }


class OverlapTest(unittest.TestCase):
    def test_threshold_and_shared_band(self):
        original = shingles("abcdefghijkl")
        boundary = shingles("abcdefghijklmn")
        below = shingles("abcdefghijklmno")
        self.assertEqual(gram_overlap(original, boundary), (8, 10))
        self.assertEqual(gram_overlap(original, below), (8, 11))
        self.assertEqual(shingles("abcd"), set())
        self.assertTrue(set(minhash_bands(original)) & set(minhash_bands(boundary)))
        self.assertEqual(minhash_bands(original), minhash_bands(shingles("abcdefghijkl")))

    def test_prefix_index_finds_nonidentical_matches_only(self):
        benchmark = {"sealed": [case("s", "fixture:s", "abcdefghijkl")]}
        index = TextIndex(benchmark)
        self.assertEqual(index.near("abcdefghijklmn"), ({("sealed", "s")}, 1, 0))
        self.assertEqual(index.near("abcdefghijklmno"), (set(), 0, 0))
        self.assertEqual(index.near("abcdefghijkl"), (set(), 0, 0))
        self.assertEqual(index.near("abcd"), (set(), 0, 0))

    def test_exact_fallback_recovers_a_missed_minhash_pair(self):
        index = TextIndex({"dev": [case("d", "fixture:d", "abcdefghijkl")]})
        with patch("contamination.minhash_bands", side_effect=[((0, 0, 0, 0),), ((1, 1, 1, 1),)]):
            self.assertEqual(index.near("abcdefghijklmn"), ({("dev", "d")}, 0, 1))

    def test_count_cases_once_and_exclude_fit_plus_selection_only(self):
        benchmark = {
            "sealed": [case("s1", "fixture:s1", "abcdefghijkl"), case("s2", "fixture:s2", "sealed evaluation only")],
            "dev": [case("d", "massive:ar-SA:87", "مثال مختلف")],
        }
        rows = [
            row("fit", [" ＡＢＣＤＥＦＧＨＩＪＫＬ ", "abcdefghijklmn"], "fixture:s1"),
            row("fit", ["abcdefghijkl"], "fixture:s1"),
            row("selection", ["different locale"], "fixture:unused", ["massive:en-US:87"]),
            row("evaluation", ["sealed evaluation only"]),
        ]
        with TemporaryDirectory() as directory:
            path = Path(directory) / "rows.jsonl"
            path.write_text("\n".join(json.dumps(item) for item in rows), encoding="utf-8")
            result = audit(benchmark, [path])
        self.assertEqual(result["byBranch"]["57"]["trainingRows"], 3)
        self.assertEqual(result["byBranch"]["57"]["sealed"], {"exact": 1, "near": 1, "id": 1, "any": 1})
        self.assertEqual(result["byBranch"]["57"]["dev"], {"exact": 0, "near": 0, "id": 1, "any": 1})
        self.assertEqual(result["byRole"][0]["role"], "evaluation")
        self.assertEqual(result["byRole"][0]["sealed"]["any"], 1)
        self.assertEqual(result["sealedExcludedCaseIds"], {"57": ["s1"]})
        self.assertEqual(result["sealedFitExcludedCaseIds"], {"57": ["s1"]})


if __name__ == "__main__":
    unittest.main()
