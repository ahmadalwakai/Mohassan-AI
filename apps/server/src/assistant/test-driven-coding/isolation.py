"""Install the Linux boundary before reading any untrusted Python."""

import ctypes
import errno
import mmap
import os
import socket
import sys


class IsolationUnavailable(Exception):
    pass


class _Argument(ctypes.Structure):
    _fields_ = (
        ("index", ctypes.c_uint),
        ("comparison", ctypes.c_int),
        ("value", ctypes.c_uint64),
        ("unused", ctypes.c_uint64),
    )


def isolate():
    if sys.platform != "linux" or os.geteuid() == 0:
        raise IsolationUnavailable
    import resource

    try:
        # These are hard limits, including when the caller is stopped unexpectedly.
        resource.setrlimit(resource.RLIMIT_CPU, (3, 3))
        resource.setrlimit(resource.RLIMIT_AS, (128 * 1024 * 1024,) * 2)
        resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))
        seccomp = ctypes.CDLL("libseccomp.so.2")
        libc = ctypes.CDLL(None, use_errno=True)
        open_file = libc.open
        create_socket = libc.socket
        os.closerange(3, os.sysconf("SC_OPEN_MAX"))
        resource.setrlimit(resource.RLIMIT_NOFILE, (3, 3))
        _load_filter(seccomp)
        _check_filter(open_file, create_socket)
    except (OSError, ValueError, AttributeError):
        raise IsolationUnavailable from None


def _check_filter(open_file, create_socket):
    # Use raw descriptors so a broken filter cannot kill the worker during
    # Python socket setup or cleanup before it can return unavailable.
    if open_file(b"/dev/null", os.O_RDONLY | os.O_CLOEXEC) != -1 or ctypes.get_errno() != errno.EPERM:
        raise IsolationUnavailable
    if create_socket(socket.AF_INET, socket.SOCK_STREAM, 0) != -1 or ctypes.get_errno() != errno.EPERM:
        raise IsolationUnavailable


def _load_filter(seccomp):
    seccomp.seccomp_init.argtypes = [ctypes.c_uint32]
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    seccomp.seccomp_syscall_resolve_name.restype = ctypes.c_int
    seccomp.seccomp_rule_add_array.argtypes = [
        ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint,
        ctypes.POINTER(_Argument),
    ]
    seccomp.seccomp_rule_add_array.restype = ctypes.c_int
    seccomp.seccomp_load.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_load.restype = ctypes.c_int
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_release.restype = None

    allow = 0x7FFF0000  # SCMP_ACT_ALLOW
    deny = 0x00050000 | errno.EPERM  # SCMP_ACT_ERRNO(EPERM)
    kill_process = 0x80000000  # SCMP_ACT_KILL_PROCESS
    equal = 4  # SCMP_CMP_EQ
    masked_equal = 7  # SCMP_CMP_MASKED_EQ
    context = seccomp.seccomp_init(kill_process)
    if not context:
        raise IsolationUnavailable

    def rule(name, *comparisons, action=allow, required=True):
        number = seccomp.seccomp_syscall_resolve_name(name.encode("ascii"))
        if number < 0:
            if required:
                raise IsolationUnavailable
            return
        arguments = (_Argument * len(comparisons))(*comparisons) if comparisons else None
        if seccomp.seccomp_rule_add_array(
            context, action, number, len(comparisons), arguments,
        ) != 0:
            raise IsolationUnavailable

    try:
        # The self-check must see permission errors for the two probes.
        rule("openat", action=deny)
        rule("open", action=deny, required=False)
        rule("openat2", action=deny, required=False)
        rule("socket", action=deny)

        # Only the standard streams are inherited from the launcher.
        rule("read", _Argument(0, equal, 0, 0))
        rule("write", _Argument(0, equal, 1, 0))
        rule("write", _Argument(0, equal, 2, 0))
        for name in (
            "brk", "munmap", "mremap",
            "clock_gettime", "rt_sigaction", "rt_sigprocmask", "rt_sigreturn",
            "sigaltstack", "setitimer", "exit", "exit_group",
        ):
            rule(name)
        no_exec = _Argument(2, masked_equal, mmap.PROT_EXEC, 0)
        # Require anonymous mappings, even if a caller inherited an extra fd.
        anonymous = _Argument(3, masked_equal, mmap.MAP_ANONYMOUS, mmap.MAP_ANONYMOUS)
        rule("mmap", no_exec, anonymous)
        rule("mmap2", no_exec, anonymous, required=False)
        rule("mprotect", no_exec)
        rule("futex", _Argument(1, equal, 128, 0))  # FUTEX_WAIT_PRIVATE
        rule("futex", _Argument(1, equal, 129, 0))  # FUTEX_WAKE_PRIVATE
        rule("madvise", _Argument(2, equal, mmap.MADV_DONTNEED, 0))  # libc allocator
        if seccomp.seccomp_load(context) != 0:
            raise IsolationUnavailable
    finally:
        seccomp.seccomp_release(context)
