"""Training and gate handoff for Mohassan's discriminative heads."""

import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]

# Import the pinned source packages and capability exclusion library from this checkout.
for _directory in (
    "packages/execution-pipeline", "packages/execution-model", "scripts/agent-capability-bench/v2",
):
    _source = str(REPOSITORY_ROOT / _directory)
    if _source not in sys.path:
        sys.path.insert(0, _source)
