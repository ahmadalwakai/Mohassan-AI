"""Run the explicit-contract local code CLI without installing the package."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline.ask_code import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
