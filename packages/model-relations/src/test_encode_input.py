"""Tests the isolated tokenizer subprocess without weights or network access."""

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parent
sys.path.insert(0, str(SOURCE.parents[1] / "execution-model"))
from execution_model.tokenizer import ByteBPETokenizer


class EncodeInputTest(unittest.TestCase):
    def execute(self, mode, payload):
        return subprocess.run([sys.executable, "-I", "-B", str(SOURCE / "encode-input.py"), mode],
                              input=json.dumps(payload), capture_output=True, text=True, timeout=5, check=False)

    def test_encoding_and_decoding_use_pinned_local_tokenizer(self):
        with tempfile.TemporaryDirectory() as directory:
            tokenizer = ByteBPETokenizer()
            file = Path(directory) / "tokenizer.json"
            tokenizer.save(file)
            request = {"tokenizer": {"path": str(file), "sha256": hashlib.sha256(file.read_bytes()).hexdigest()},
                       "tokenizerId": f"sha256:{tokenizer.identity}"}
            head = self.execute("head", {**request, "text": "Who?", "history": ["Sara"], "candidates": ["yes", "لا"],
                                         "eosTokenId": tokenizer.eos_token_id, "maxTokens": 24})
            self.assertEqual(head.returncode, 0, head.stderr)
            prepared = json.loads(head.stdout)
            self.assertEqual(prepared["candidateIndices"], [0, 1])
            self.assertTrue(all(prepared["inputIds"][index] == tokenizer.eos_token_id
                                for index in prepared["candidatePositions"]))
            encoded = self.execute("ads-encode", {**request, "text": "ABC"})
            self.assertEqual(encoded.returncode, 0, encoded.stderr)
            self.assertEqual(json.loads(encoded.stdout), tokenizer.encode("ABC"))
            decoded = self.execute("ads-decode", {**request, "tokens": json.loads(encoded.stdout)})
            self.assertEqual(decoded.returncode, 0, decoded.stderr)
            self.assertEqual(json.loads(decoded.stdout), "ABC")
            bad = self.execute("ads-encode", {**request, "tokenizerId": "wrong", "text": "ABC"})
            self.assertEqual(bad.returncode, 1)


if __name__ == "__main__":
    unittest.main()
