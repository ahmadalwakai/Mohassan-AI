"""Where the service keeps its private state on the owner's computer.

The state folder holds the TLS key, the paired phones and the Mohassan gateway
key, so it stays outside the repository. WASLA_STATE_DIR overrides it; the
default is the folder the service has used since build 3, so the paired iPhone
and its pinned certificate keep working after the code moved into Mohassan.
"""
import os
from pathlib import Path

LEGACY_STATE = Path(r"C:\Users\Administrator\Documents\Codex\2026-11-01\local-agent-handoff\work\wasla-state")
STATE_DIR = Path(os.environ.get("WASLA_STATE_DIR") or LEGACY_STATE)
