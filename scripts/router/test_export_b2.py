"""Compare Python exports with the TypeScript router on CPU."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import numpy as np

from export_b2 import CHAR_RANGES, b2_ngram_ids, export_b2
from train import BUCKETS, ROOT, ROUTES, ngram_ids


NODE_LOGITS = """
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadRouterB2Model, routerLogits } from './apps/server/src/assistant/router.ts';
const directory = process.argv[2];
const model = await loadRouterB2Model(directory);
const cases = JSON.parse(await readFile(path.join(directory, 'router-b2-parity.json'), 'utf8'));
console.log(JSON.stringify(cases.map(row => routerLogits(model, row.text))));
"""


class B2ExportTest(unittest.TestCase):
    def test_b0_feature_version_reuses_baseline_ids(self):
        for text in ("", "^$hello world$^", "😀 أهلاً ٢٥\u0085وسهلاً\ufeff"):
            self.assertEqual(b2_ngram_ids(text, BUCKETS, "b0"), ngram_ids(text))

    def assert_parity(self, directory: Path) -> float:
        result = subprocess.run(
            ["node", "--import", "tsx", "--input-type=module", "-", str(directory.resolve())],
            input=NODE_LOGITS, text=True, capture_output=True, check=True, cwd=ROOT, timeout=30,
        )
        rows = json.loads((directory / "router-b2-parity.json").read_text(encoding="utf-8"))
        expected = np.array([row["logits"] for row in rows])
        actual = np.array(json.loads(result.stdout), dtype=np.float64)
        self.assertEqual(actual.shape, expected.shape)
        self.assertTrue(np.isfinite(actual).all())
        max_diff = float(np.max(np.abs(actual - expected)))
        self.assertLess(max_diff, 1e-5)
        return max_diff

    @unittest.skipUnless(shutil.which("node") and (ROOT / "node_modules/tsx").exists(), "requires Node and npm ci")
    def test_typescript_matches_python_for_both_feature_versions(self):
        coefficients = np.random.default_rng(7).normal(size=(128, len(ROUTES)))
        bias = np.linspace(-0.5, 0.5, len(ROUTES))
        with tempfile.TemporaryDirectory() as tmp:
            for version in CHAR_RANGES:
                with self.subTest(version=version):
                    directory = Path(tmp) / version
                    export_b2(directory, coefficients, bias, version)
                    self.assert_parity(directory)

    @unittest.skipUnless(os.environ.get("ROUTER_B2_PARITY_DIR"), "set ROUTER_B2_PARITY_DIR to test a trained export")
    def test_typescript_matches_trained_b2(self):
        difference = self.assert_parity(Path(os.environ["ROUTER_B2_PARITY_DIR"]))
        print(f"Trained B2 Python/TypeScript maximum absolute logit difference: {difference:.9g}")


if __name__ == "__main__":
    unittest.main()
