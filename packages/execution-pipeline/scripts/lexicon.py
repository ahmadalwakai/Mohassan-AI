"""CLI: python -I lexicon.py --corpus en=<file> --corpus ar=<file> --out <dir>. See execution_pipeline/lexicon.py."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline import lexicon  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(lexicon.main())
