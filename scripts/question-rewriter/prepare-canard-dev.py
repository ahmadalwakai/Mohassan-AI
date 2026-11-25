"""Retain the documented entry point for preparing the official CANARD dev split."""

from pathlib import Path
import runpy
import sys

if __name__ == "__main__":
    sys.argv.extend(("--split", "dev"))
    runpy.run_path(str(Path(__file__).with_name("prepare-canard.py")), run_name="__main__")
