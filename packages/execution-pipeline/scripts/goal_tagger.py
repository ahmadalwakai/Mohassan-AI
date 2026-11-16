"""CLI: python -I goal_tagger.py <train|answers> ... See execution_pipeline/goal_tagger.py."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline import goal_tagger  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(goal_tagger.main())
