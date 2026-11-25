"""Classify development cases with the release's original v2 exclusion filter."""

from hashlib import sha256
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
sys.path.insert(0, str(root / "scripts/agent-capability-bench/v2"))
from exclusion import Exclusions, benchmark_texts, source_id_key  # noqa: E402

version = sys.argv[2]
bundle = root / "tests/fixtures/agent-capability-bench"
payload = bundle / ("v2/dev/payload.json" if version == "2" else "development.json")
cases = json.loads(payload.read_bytes())["cases"]
filter_ = Exclusions.load()
results = {}
for case in cases:
    native_id = case["provenance"]["source"]
    if version == "2":
        texts = benchmark_texts(case)
        family = source_id_key(native_id)
    else:
        texts = tuple(text for turn in case["turns"]
                      for text in (turn["text"], *turn.get("fields", {}).values()))
        family = case["id"].rsplit("-", 1)[0]
    results[case["id"]] = {
        "family": sha256(family.encode()).hexdigest(),
        "author": case["provenance"]["author"],
        "excluded": filter_.matches(texts, source_id=native_id),
    }
print(json.dumps(results, separators=(",", ":")))
