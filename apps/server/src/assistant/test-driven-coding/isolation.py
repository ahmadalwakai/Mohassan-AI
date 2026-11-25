"""Install the Linux boundary before reading any untrusted Python."""

import ctypes
import errno
import os
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
    if sys.platform != "linux":
        raise IsolationUnavailable
    import resource

    try:
        # These are hard limits, including when the caller is stopped unexpectedly.
        resource.setrlimit(resource.RLIMIT_CPU, (3, 3))
        resource.setrlimit(resource.RLIMIT_AS, (128 * 1024 * 1024,) * 2)
        resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        seccomp = ctypes.CDLL("libseccomp.so.2")
        _load_filter(seccomp)
    except (OSError, ValueError, AttributeError):
        raise IsolationUnavailable from None


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
    equal = 4  # SCMP_CMP_EQ
    context = seccomp.seccomp_init(deny)
    if not context:
        raise IsolationUnavailable

    def rule(name, comparison=None, required=True):
        number = seccomp.seccomp_syscall_resolve_name(name.encode("ascii"))
        if number < 0:
            if required:
                raise IsolationUnavailable
            return
        if seccomp.seccomp_rule_add_array(
            context, allow, number, int(comparison is not None), comparison,
        ) != 0:
            raise IsolationUnavailable

    try:
        # Only the standard streams are inherited from the launcher. The
        # filter grants no filesystem, network or new-process operations.
        rule("read", _Argument(0, equal, 0, 0))
        rule("write", _Argument(0, equal, 1, 0))
        rule("write", _Argument(0, equal, 2, 0))
        for name in (
            "brk", "munmap", "mremap", "mprotect", "madvise", "futex",
            "clock_gettime", "rt_sigaction", "rt_sigprocmask", "rt_sigreturn",
            "sigaltstack", "setitimer", "exit", "exit_group",
        ):
            rule(name)
        # Require anonymous mappings, even if a caller inherited an extra fd.
        masked_equal = 7  # SCMP_CMP_MASKED_EQ
        anonymous_mapping = _Argument(3, masked_equal, 0x20, 0x20)  # MAP_ANONYMOUS
        rule("mmap", anonymous_mapping)
        rule("mmap2", anonymous_mapping, required=False)
        os.closerange(3, os.sysconf("SC_OPEN_MAX"))
        if seccomp.seccomp_load(context) != 0:
            raise IsolationUnavailable
    finally:
        seccomp.seccomp_release(context)
