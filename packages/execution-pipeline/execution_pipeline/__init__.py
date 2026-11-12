"""Cross-phase integration for the Mohassan execution model.

Phases 2 (model), 3 (training) and 4 (evaluation) were delivered as isolated
packages with injected seams and no code joining them. This package is that
join: it owns no architecture, optimizer or metric of its own.

Importing it only extends ``sys.path`` with the sibling phase packages. It loads
no weights, opens no files and starts no process.
"""
from __future__ import annotations

import sys
from pathlib import Path

__version__ = "0.1.0"

PACKAGES_ROOT = Path(__file__).resolve().parents[2]
REPOSITORY_ROOT = PACKAGES_ROOT.parent

for _name in ("execution-model", "execution-training", "execution-evaluation"):
    _path = str(PACKAGES_ROOT / _name)
    if _path not in sys.path:
        sys.path.insert(0, _path)
