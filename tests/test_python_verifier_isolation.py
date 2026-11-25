"""Exercise the verifier's Linux boundary with trusted subprocess fixtures."""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
from textwrap import dedent
import unittest


WORKER_DIRECTORY = Path(__file__).resolve().parents[1] / "apps/server/src/assistant/test-driven-coding"


@unittest.skipUnless(sys.platform == "linux", "seccomp is a Linux backend")
class IsolationTests(unittest.TestCase):
    def run_fixture(self, source, *args):
        fixture = "import sys\nsys.path.insert(0, sys.argv[1])\n" + dedent(source)
        return subprocess.run(
            [sys.executable, "-I", "-B", "-S", "-c", fixture, str(WORKER_DIRECTORY), *args],
            env={}, input="", capture_output=True, text=True, timeout=5,
        )

    def assert_unavailable(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(json.loads(result.stdout), {
            "status": "unavailable", "reason": "isolation-unavailable",
        })

    def test_refuses_root_before_loading_seccomp(self):
        self.assert_unavailable(self.run_fixture("""
            from unittest.mock import patch
            import worker

            with patch('isolation.os.geteuid', return_value=0), \\
                 patch('isolation.ctypes.CDLL', side_effect=AssertionError):
                worker.main()
        """))

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "requires an unprivileged user")
    def test_refuses_a_noop_filter(self):
        self.assert_unavailable(self.run_fixture("""
            from unittest.mock import patch
            import worker

            with patch('isolation._load_filter') as load_filter:
                worker.main()
                load_filter.assert_called_once()
        """))

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "requires an unprivileged user")
    def test_limits_descriptors_and_processes_and_denies_file_and_socket_probes(self):
        result = self.run_fixture("""
            import errno
            import os
            import resource
            import socket
            import isolation

            load = isolation._load_filter
            def check_limits(seccomp):
                assert resource.getrlimit(resource.RLIMIT_NPROC) == (0, 0)
                assert resource.getrlimit(resource.RLIMIT_NOFILE) == (3, 3)
                load(seccomp)

            isolation._load_filter = check_limits
            isolation.isolate()
            for operation in (lambda: os.open(os.devnull, os.O_RDONLY), socket.socket):
                try:
                    operation()
                except PermissionError as error:
                    assert error.errno == errno.EPERM
                else:
                    raise SystemExit(3)
            print('denied')
        """)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "denied\n")
        self.assertEqual(result.stderr, "")

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "requires an unprivileged user")
    def test_kills_executable_memory_requests_and_unlisted_syscalls(self):
        for operation in ("mmap", "mprotect", "madvise", "fork"):
            with self.subTest(operation=operation):
                result = self.run_fixture("""
                    import ctypes
                    import mmap
                    import os
                    from isolation import isolate

                    mprotect = ctypes.CDLL(None).mprotect
                    mprotect.argtypes = (ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int)
                    isolate()
                    page = mmap.mmap(-1, mmap.PAGESIZE, flags=mmap.MAP_PRIVATE | mmap.MAP_ANONYMOUS)
                    page.madvise(mmap.MADV_DONTNEED)
                    print('ready', flush=True)
                    if sys.argv[2] == 'mmap':
                        mmap.mmap(-1, mmap.PAGESIZE, flags=mmap.MAP_PRIVATE | mmap.MAP_ANONYMOUS,
                                  prot=mmap.PROT_READ | mmap.PROT_EXEC)
                    elif sys.argv[2] == 'mprotect':
                        mprotect(None, mmap.PAGESIZE, mmap.PROT_READ | mmap.PROT_EXEC)
                    elif sys.argv[2] == 'madvise':
                        page.madvise(mmap.MADV_NORMAL)
                    else:
                        os.fork()
                """, operation)
                self.assertEqual(result.returncode, -signal.SIGSYS, result.stderr)
                self.assertEqual(result.stdout, "ready\n")
                self.assertEqual(result.stderr, "")

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "requires an unprivileged user")
    def test_futex_allows_only_private_wait_and_wake(self):
        result = self.run_fixture("""
            import ctypes
            import errno
            from isolation import isolate

            resolve = ctypes.CDLL('libseccomp.so.2').seccomp_syscall_resolve_name
            resolve.argtypes = (ctypes.c_char_p,)
            futex = resolve(b'futex')
            syscall = ctypes.CDLL(None, use_errno=True).syscall
            word = ctypes.byref(ctypes.c_int(0))
            isolate()
            assert syscall(futex, word, 128, 1, None) == -1  # FUTEX_WAIT_PRIVATE
            assert ctypes.get_errno() == errno.EAGAIN
            assert syscall(futex, word, 129, 1) == 0  # FUTEX_WAKE_PRIVATE
            print('ready', flush=True)
            syscall(futex, word, 1, 1)  # FUTEX_WAKE
        """)
        self.assertEqual(result.returncode, -signal.SIGSYS, result.stderr)
        self.assertEqual(result.stdout, "ready\n")
        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
