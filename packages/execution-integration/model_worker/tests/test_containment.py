from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest


_PACKAGE_ROOT = Path(__file__).resolve().parents[2]
_WORKER = _PACKAGE_ROOT / "model_worker" / "worker.py"
_IMPORT = f"import sys; sys.path.insert(0, {str(_PACKAGE_ROOT)!r}); from model_worker.containment import contain"


@pytest.mark.skipif(sys.platform != "linux", reason="requires Linux rlimits")
def test_linux_caps_are_applied_before_allocating_model_memory():
    code = f"""\
{_IMPORT}
import os
import resource
contain(128 * 1024**2, 75, 30, os.getppid())
assert resource.getrlimit(resource.RLIMIT_AS) == (128 * 1024**2, 128 * 1024**2)
assert resource.getrlimit(resource.RLIMIT_CPU) == (30, 30)
assert resource.getrlimit(resource.RLIMIT_CORE) == (0, 0)
try:
    bytearray(160 * 1024**2)
except MemoryError:
    print('memory refused')
"""
    result = subprocess.run([sys.executable, "-I", "-B", "-c", code], capture_output=True, timeout=5, check=True)
    assert result.stdout == b"memory refused\n"


@pytest.mark.skipif(sys.platform not in {"linux", "win32"}, reason="requires Linux or Windows containment")
def test_worker_process_dies_when_the_supervisor_exits():
    worker_code = f"""\
{_IMPORT}
import sys
import time
contain(128 * 1024**2, 75, 30, int(sys.argv[1]))
print('contained', flush=True)
time.sleep(60)
"""
    supervisor_code = f"""\
import os
import subprocess
import sys
child = subprocess.Popen([sys.executable, '-I', '-B', '-c', {worker_code!r}, str(os.getpid())], stdout=subprocess.PIPE)
assert child.stdout.readline().strip() == b'contained'
"""
    # The worker inherits stderr, so communicate() waits for it to close its
    # end of the pipe as well as for the supervisor to exit.
    result = subprocess.run([sys.executable, "-I", "-B", "-c", supervisor_code],
                            capture_output=True, timeout=5, check=True)
    assert result.stderr == b""


@pytest.mark.skipif(sys.platform != "win32", reason="requires Windows Job Object APIs")
def test_windows_job_enforces_memory_and_active_process_limits():
    code = f"""\
{_IMPORT}
import os
import subprocess
contain(128 * 1024**2, 75, 30, int(sys.argv[1]))
try:
    bytearray(160 * 1024**2)
except MemoryError:
    print('memory refused')
try:
    result = subprocess.run([sys.executable, '-c', 'print(123)'], capture_output=True, timeout=3)
    assert result.returncode != 0 and not result.stdout
except OSError:
    pass
"""
    result = subprocess.run([sys.executable, "-I", "-B", "-c", code, str(os.getpid())],
                            capture_output=True, timeout=5, check=True)
    assert result.stdout.strip() == b"memory refused"


@pytest.mark.skipif(sys.platform != "linux", reason="requires POSIX FIFO")
def test_config_path_must_be_regular_and_cannot_block_startup(tmp_path):
    path = tmp_path / "nonregular-config"
    os.mkfifo(path)
    result = subprocess.run([sys.executable, "-I", "-B", str(_WORKER), str(path), str(os.getpid())],
                            capture_output=True, timeout=5)
    assert result.returncode == 1
    assert b'"kind":"startup_error","code":"invalid_config"' in result.stdout
