"""OS resource limits for the inference-only worker, installed before importing torch."""
from __future__ import annotations

import ctypes
import os
import signal
import sys
import threading


def contain(memory_bytes: int, cpu_rate_percent: int, cpu_time_seconds: int, parent_pid: int) -> None:
    if sys.platform == "win32":
        _windows_job(memory_bytes, cpu_rate_percent, parent_pid)
    elif sys.platform == "linux":
        _linux_limits(memory_bytes, cpu_time_seconds, parent_pid)
    else:
        raise OSError("unsupported model worker platform")


def _linux_limits(memory_bytes: int, cpu_time_seconds: int, parent_pid: int) -> None:
    import resource

    # PR_SET_PDEATHSIG has a race if the parent exits during installation.
    # Checking the expected parent after prctl closes that window.
    prctl = ctypes.CDLL(None, use_errno=True).prctl
    prctl.argtypes = [ctypes.c_int, *([ctypes.c_ulong] * 4)]
    prctl.restype = ctypes.c_int
    if prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != parent_pid:
        raise OSError("parent death signal unavailable")
    if prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        raise OSError("privilege restriction unavailable")

    for resource_id, limit in (
        (resource.RLIMIT_AS, memory_bytes),
        (resource.RLIMIT_CPU, cpu_time_seconds),
        (resource.RLIMIT_CORE, 0),
    ):
        soft, hard = resource.getrlimit(resource_id)
        effective = min([limit, *[value for value in (soft, hard) if value != resource.RLIM_INFINITY]])
        resource.setrlimit(resource_id, (effective, effective))


def _windows_job(memory_bytes: int, cpu_rate_percent: int, parent_pid: int) -> None:
    from ctypes import wintypes as win

    class BasicLimits(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", win.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", win.DWORD),
            ("Affinity", ctypes.c_size_t), ("PriorityClass", win.DWORD), ("SchedulingClass", win.DWORD),
        ]

    class IOCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
        )]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", BasicLimits), ("IoInfo", IOCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    class CPURate(ctypes.Structure):
        _fields_ = [("ControlFlags", win.DWORD), ("CpuRate", win.DWORD)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, win.LPCWSTR]
    kernel.CreateJobObjectW.restype = win.HANDLE
    kernel.SetInformationJobObject.argtypes = [win.HANDLE, ctypes.c_int, ctypes.c_void_p, win.DWORD]
    kernel.SetInformationJobObject.restype = win.BOOL
    kernel.GetCurrentProcess.argtypes = []
    kernel.GetCurrentProcess.restype = win.HANDLE
    kernel.AssignProcessToJobObject.argtypes = [win.HANDLE, win.HANDLE]
    kernel.AssignProcessToJobObject.restype = win.BOOL
    kernel.OpenProcess.argtypes = [win.DWORD, win.BOOL, win.DWORD]
    kernel.OpenProcess.restype = win.HANDLE
    kernel.WaitForMultipleObjects.argtypes = [win.DWORD, ctypes.POINTER(win.HANDLE), win.BOOL, win.DWORD]
    kernel.WaitForMultipleObjects.restype = win.DWORD
    kernel.CloseHandle.argtypes = [win.HANDLE]
    kernel.CloseHandle.restype = win.BOOL

    # CPython's Windows venv redirector can appear between Node and the worker.
    # Monitor it too so terminating the spawned child also terminates the job.
    parents = []
    job = None
    try:
        for pid in {parent_pid, os.getppid()}:
            parent = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
            if not parent:
                raise ctypes.WinError(ctypes.get_last_error())
            parents.append(parent)
        handles = (win.HANDLE * len(parents))(*parents)
        if kernel.WaitForMultipleObjects(len(handles), handles, False, 0) != 258:  # WAIT_TIMEOUT
            raise OSError("parent process unavailable")
        job = kernel.CreateJobObjectW(None, None)  # unnamed and non-inheritable
        if not job:
            raise ctypes.WinError(ctypes.get_last_error())

        limits = ExtendedLimits()
        active_process, job_memory, kill_on_close = 0x0008, 0x0200, 0x2000
        limits.BasicLimitInformation.LimitFlags = active_process | job_memory | kill_on_close
        limits.BasicLimitInformation.ActiveProcessLimit = 1
        limits.JobMemoryLimit = memory_bytes
        cpu = CPURate(0x01 | 0x04, cpu_rate_percent * 100)  # ENABLE | HARD_CAP
        if not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not kernel.SetInformationJobObject(job, 15, ctypes.byref(cpu), ctypes.sizeof(cpu)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
            raise ctypes.WinError(ctypes.get_last_error())

        def watch_parent() -> None:
            kernel.WaitForMultipleObjects(len(handles), handles, False, 0xFFFFFFFF)  # INFINITE
            # This worker owns the only handle. Closing it terminates the job.
            kernel.CloseHandle(job)
            os._exit(1)

        threading.Thread(target=watch_parent, daemon=True, name="model-worker-parent").start()
    except BaseException:
        for parent in parents:
            kernel.CloseHandle(parent)
        if job:
            kernel.CloseHandle(job)
        raise
