"""Integrate the repository's local model and training packages."""
from pathlib import Path
import sys

_PACKAGES_ROOT = Path(__file__).resolve().parents[2]
for _package in ("execution-pipeline", "execution-model"):
    _path = str(_PACKAGES_ROOT / _package)
    if _path not in sys.path:
        sys.path.insert(0, _path)
