"""Training and gate handoff for Mohassan's discriminative heads."""

import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]

# The pinned packages are source packages in this checkout, not PyPI distributions.
for _package in ("execution-pipeline", "execution-model"):
    _source = str(REPOSITORY_ROOT / "packages" / _package)
    if _source not in sys.path:
        sys.path.insert(0, _source)
