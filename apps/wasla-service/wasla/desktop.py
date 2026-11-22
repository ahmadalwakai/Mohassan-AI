"""Bounded desktop operations for an explicitly authorized Wasla session.

This module does not authenticate requests. The service must check the paired
device token, its active desktop lease and the local operator's permission before
calling capture() or input(). No desktop switching or privilege elevation occurs.

Microsoft references: winuser SendInput, MOUSEINPUT, KEYBDINPUT,
OpenInputDesktop; wtsapi32 WTSQuerySessionInformationW. Capture uses Pillow's
documented ImageGrab.grab(all_screens=True, bbox=...).
"""
from __future__ import annotations

import ctypes
from contextlib import contextmanager
import io
import math
import os
import threading
from typing import Any

from PIL import Image, ImageGrab


class DesktopError(RuntimeError):
    """The interactive desktop is unavailable or Windows rejected input."""


DWORD = ctypes.c_uint32
LONG = ctypes.c_int32
WORD = ctypes.c_uint16
ULONG_PTR = ctypes.c_size_t
HANDLE = ctypes.c_void_p


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", LONG), ("dy", LONG), ("mouseData", DWORD),
                ("dwFlags", DWORD), ("time", DWORD), ("dwExtraInfo", ULONG_PTR)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", WORD), ("wScan", WORD), ("dwFlags", DWORD),
                ("time", DWORD), ("dwExtraInfo", ULONG_PTR)]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", DWORD), ("wParamL", WORD), ("wParamH", WORD)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("payload",)
    _fields_ = [("type", DWORD), ("payload", _INPUTUNION)]


class USEROBJECTFLAGS(ctypes.Structure):
    _fields_ = [("fInherit", ctypes.c_int32), ("fReserved", ctypes.c_int32),
                ("dwFlags", DWORD)]


MOUSE_MOVE = 0x0001
MOUSE_ABSOLUTE = 0x8000
MOUSE_VIRTUALDESK = 0x4000
MOUSE_WHEEL = 0x0800
KEY_UP = 0x0002
KEY_UNICODE = 0x0004
KEY_EXTENDED = 0x0001

KEYS: dict[str, tuple[int, bool]] = {
    "enter": (0x0D, False), "tab": (0x09, False),
    "escape": (0x1B, False), "backspace": (0x08, False),
    "delete": (0x2E, True), "space": (0x20, False),
    "left": (0x25, True), "up": (0x26, True),
    "right": (0x27, True), "down": (0x28, True),
    "home": (0x24, True), "end": (0x23, True),
    "page_up": (0x21, True), "page_down": (0x22, True),
}


def validate_command(command: Any) -> dict[str, Any]:
    """Validate before calling any Windows API. Reject bools and non-finite data."""
    if type(command) is not dict:
        raise ValueError("Desktop command must be an object")
    action = command.get("action")
    if type(action) is not str:
        raise ValueError("Desktop action must be a string")
    shapes = {
        "move": {"action", "x", "y"},
        "click": {"action", "button"},
        "scroll": {"action", "dy"},
        "key": {"action", "key"},
        "text": {"action", "text"},
    }
    if action not in shapes or set(command) != shapes[action]:
        raise ValueError("Unsupported desktop action or unexpected fields")
    if action == "move":
        for name in ("x", "y"):
            value = command[name]
            if type(value) not in (int, float) or not 0 <= value <= 1 or not math.isfinite(value):
                raise ValueError("Pointer coordinates must be finite numbers from 0 to 1")
    elif action == "click":
        if type(command["button"]) is not str or command["button"] not in ("left", "right"):
            raise ValueError("Only left and right clicks are supported")
    elif action == "scroll":
        if type(command["dy"]) is not int or not -10 <= command["dy"] <= 10 or command["dy"] == 0:
            raise ValueError("Scroll dy must be a nonzero integer from -10 to 10")
    elif action == "key":
        if type(command["key"]) is not str or command["key"] not in KEYS:
            raise ValueError("Unsupported special key")
    else:
        text = command["text"]
        if type(text) is not str or not 1 <= len(text) <= 2000:
            raise ValueError("Text must contain 1 to 2000 characters")
        if any((ord(c) < 32 and c not in "\r\n\t") or 0xD800 <= ord(c) <= 0xDFFF for c in text):
            raise ValueError("Text contains unsupported control or surrogate characters")
    return dict(command)


def _mouse(flags: int, x: int = 0, y: int = 0, data: int = 0) -> INPUT:
    return INPUT(type=0, mi=MOUSEINPUT(x, y, data & 0xFFFFFFFF, flags, 0, 0))


def _keyboard(vk: int, scan: int = 0, flags: int = 0) -> INPUT:
    return INPUT(type=1, ki=KEYBDINPUT(vk, scan, flags, 0, 0))


class _NativeWindows:
    """Thin Win32 wrapper; injectable in tests so no real input is produced."""
    _dpi_lock = threading.Lock()
    _dpi_attempted = False

    def __init__(self):
        if os.name != "nt":
            raise DesktopError("Desktop control requires Windows")
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.wts = ctypes.WinDLL("wtsapi32", use_last_error=True)
        self._bind()
        # May already be configured by the host; thread scope below guarantees
        # physical-pixel coordinates for every worker independently.
        with self._dpi_lock:
            if not self.__class__._dpi_attempted:
                self.user32.SetProcessDpiAwarenessContext(HANDLE(-4))
                self.__class__._dpi_attempted = True

    def _bind(self):
        signatures = [
            (self.user32.GetSystemMetrics, [ctypes.c_int], ctypes.c_int),
            (self.user32.SendInput, [ctypes.c_uint, ctypes.POINTER(INPUT), ctypes.c_int], ctypes.c_uint),
            (self.user32.OpenInputDesktop, [DWORD, ctypes.c_int32, DWORD], HANDLE),
            (self.user32.CloseDesktop, [HANDLE], ctypes.c_int32),
            (self.user32.GetProcessWindowStation, [], HANDLE),
            (self.user32.GetThreadDesktop, [DWORD], HANDLE),
            (self.user32.GetUserObjectInformationW,
             [HANDLE, ctypes.c_int, ctypes.c_void_p, DWORD, ctypes.POINTER(DWORD)], ctypes.c_int32),
            (self.user32.SetProcessDpiAwarenessContext, [HANDLE], ctypes.c_int32),
            (self.user32.SetThreadDpiAwarenessContext, [HANDLE], HANDLE),
            (self.user32.GetAsyncKeyState, [ctypes.c_int], ctypes.c_int16),
            (self.kernel32.GetCurrentThreadId, [], DWORD),
            (self.wts.WTSQuerySessionInformationW,
             [HANDLE, DWORD, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(DWORD)], ctypes.c_int32),
            (self.wts.WTSFreeMemory, [ctypes.c_void_p], None),
        ]
        for function, args, result in signatures:
            function.argtypes, function.restype = args, result

    @contextmanager
    def dpi_scope(self):
        previous = self.user32.SetThreadDpiAwarenessContext(HANDLE(-4))
        if not previous:
            raise DesktopError("Cannot establish DPI-aware desktop coordinates")
        try:
            yield
        finally:
            self.user32.SetThreadDpiAwarenessContext(previous)

    def _name(self, handle) -> str:
        if not handle:
            raise DesktopError("Interactive desktop handle is unavailable")
        needed = DWORD()
        buffer = ctypes.create_unicode_buffer(256)
        if not self.user32.GetUserObjectInformationW(handle, 2, buffer, ctypes.sizeof(buffer), ctypes.byref(needed)):
            raise DesktopError("Cannot verify the interactive desktop")
        return buffer.value

    def assert_available(self):
        buffer, size = ctypes.c_void_p(), DWORD()
        # WTS_CURRENT_SESSION (DWORD -1); WTSConnectState=8; WTSActive=0.
        if not self.wts.WTSQuerySessionInformationW(None, 0xFFFFFFFF, 8, ctypes.byref(buffer), ctypes.byref(size)):
            raise DesktopError("Cannot verify the Windows session")
        try:
            if not buffer.value or size.value < ctypes.sizeof(DWORD) or ctypes.cast(buffer, ctypes.POINTER(DWORD)).contents.value != 0:
                raise DesktopError("Windows session is not interactive and active")
        finally:
            if buffer.value:
                self.wts.WTSFreeMemory(buffer)
        station = self.user32.GetProcessWindowStation()
        if self._name(station).casefold() != "winsta0":
            raise DesktopError("Desktop service must run in the signed-in user's session")
        flags, needed = USEROBJECTFLAGS(), DWORD()
        if not self.user32.GetUserObjectInformationW(station, 1, ctypes.byref(flags), ctypes.sizeof(flags), ctypes.byref(needed)) or not flags.dwFlags & 1:
            raise DesktopError("Window station is not visible")
        thread_desktop = self.user32.GetThreadDesktop(self.kernel32.GetCurrentThreadId())
        if self._name(thread_desktop).casefold() != "default":
            raise DesktopError("Desktop worker is not on the normal user desktop")
        # DESKTOP_READOBJECTS only. Never request switch/write rights.
        desktop = self.user32.OpenInputDesktop(0, False, 0x0001)
        if not desktop:
            raise DesktopError("Unlock Windows and close secure prompts before using remote control")
        try:
            if self._name(desktop).casefold() != "default":
                raise DesktopError("Locked or secure desktops cannot be shared or controlled")
        finally:
            self.user32.CloseDesktop(desktop)

    def assert_no_local_modifiers(self):
        # Avoid interpreting a remote click/key while a local modifier or mouse
        # button is held. Do not release keys belonging to the local user.
        for key in (0x01, 0x02, 0x04, 0x10, 0x11, 0x12, 0x5B, 0x5C):
            if self.user32.GetAsyncKeyState(key) & 0x8000:
                raise DesktopError("Release local mouse buttons and modifier keys before remote input")

    def dimensions(self) -> dict[str, int]:
        values = dict(zip(("width", "height", "virtual_x", "virtual_y", "virtual_width", "virtual_height"),
                          (self.user32.GetSystemMetrics(i) for i in (0, 1, 76, 77, 78, 79))))
        if values["width"] < 2 or values["height"] < 2 or values["virtual_width"] < 2 or values["virtual_height"] < 2:
            raise DesktopError("Windows did not report a usable primary monitor")
        return values

    def send(self, events: list[INPUT]) -> None:
        if not events:
            return
        array = (INPUT * len(events))(*events)
        count = self.user32.SendInput(len(array), array, ctypes.sizeof(INPUT))
        if count != len(array):
            # A partial insertion may contain a down without its matching up.
            # Best-effort release only the keys/buttons from this operation.
            releases = [e for e in events if (e.type == 1 and e.ki.dwFlags & KEY_UP)
                        or (e.type == 0 and e.mi.dwFlags in (0x0004, 0x0010))]
            if releases:
                cleanup = (INPUT * len(releases))(*releases)
                self.user32.SendInput(len(cleanup), cleanup, ctypes.sizeof(INPUT))
            raise DesktopError("Windows rejected some input; elevated or secure windows may block control")


class WindowsDesktop:
    """Primary-monitor JPEG capture and bounded stateless input operations.

    ``scroll.dy`` is wheel detents (positive = up). ``move`` coordinates refer
    to the primary-monitor image, not the full virtual desktop. ``capture``
    preserves aspect ratio and returns JPEG bytes; no files are written.
    """
    def __init__(self, *, _native=None, _grab=None):
        self._native = _native if _native is not None else _NativeWindows()
        self._grab = _grab if _grab is not None else ImageGrab.grab
        self._lock = threading.Lock()

    def info(self) -> dict[str, Any]:
        with self._lock, self._native.dpi_scope():
            self._native.assert_available()
            dims = self._native.dimensions()
            width, height = dims["width"], dims["height"]
            factor = min(1.0, 1280 / max(width, height))
            return {"width": width, "height": height, "monitor": "primary",
                    "frame_width": max(1, round(width * factor)),
                    "frame_height": max(1, round(height * factor)),
                    "format": "jpeg", "max_edge": 1280,
                    "virtual": {"x": dims["virtual_x"], "y": dims["virtual_y"],
                                "width": dims["virtual_width"], "height": dims["virtual_height"]},
                    "keys": list(KEYS)}

    def capture(self) -> bytes:
        with self._lock, self._native.dpi_scope():
            self._native.assert_available()
            dims = self._native.dimensions()
            image = self._grab(bbox=(0, 0, dims["width"], dims["height"]),
                               include_layered_windows=True, all_screens=True)
            # Never return a captured frame after the session locks or switches.
            self._native.assert_available()
            if image.size != (dims["width"], dims["height"]):
                raise DesktopError("Monitor dimensions changed; request a fresh frame")
            image = image.convert("RGB")
            image.thumbnail((1280, 1280), Image.Resampling.LANCZOS)
            output = io.BytesIO()
            image.save(output, format="JPEG", quality=72, optimize=False)
            return output.getvalue()

    def input(self, command: dict[str, Any]) -> dict[str, Any]:
        command = validate_command(command)
        with self._lock, self._native.dpi_scope():
            self._native.assert_available()
            self._native.assert_no_local_modifiers()
            action = command["action"]
            events: list[INPUT] = []
            if action == "move":
                dims = self._native.dimensions()
                px = round(command["x"] * (dims["width"] - 1))
                py = round(command["y"] * (dims["height"] - 1))
                nx = round((px - dims["virtual_x"]) * 65535 / (dims["virtual_width"] - 1))
                ny = round((py - dims["virtual_y"]) * 65535 / (dims["virtual_height"] - 1))
                if not 0 <= nx <= 65535 or not 0 <= ny <= 65535:
                    raise DesktopError("Primary monitor is outside reported virtual desktop bounds")
                events.append(_mouse(MOUSE_MOVE | MOUSE_ABSOLUTE | MOUSE_VIRTUALDESK, nx, ny))
            elif action == "click":
                down, up = (0x0002, 0x0004) if command["button"] == "left" else (0x0008, 0x0010)
                events.extend((_mouse(down), _mouse(up)))
            elif action == "scroll":
                events.append(_mouse(MOUSE_WHEEL, data=command["dy"] * 120))
            elif action == "key":
                vk, extended = KEYS[command["key"]]
                flags = KEY_EXTENDED if extended else 0
                events.extend((_keyboard(vk, flags=flags), _keyboard(vk, flags=flags | KEY_UP)))
            else:
                text = command["text"].replace("\r\n", "\n").replace("\r", "\n")
                # UTF-16 surrogate pairs are sent as ordered code units, as
                # required by Windows for characters above U+FFFF.
                for character in text:
                    if character in "\n\t":
                        vk = 0x0D if character == "\n" else 0x09
                        events.extend((_keyboard(vk), _keyboard(vk, flags=KEY_UP)))
                    else:
                        encoded = character.encode("utf-16-le")
                        for i in range(0, len(encoded), 2):
                            unit = int.from_bytes(encoded[i:i+2], "little")
                            events.extend((_keyboard(0, unit, KEY_UNICODE),
                                           _keyboard(0, unit, KEY_UNICODE | KEY_UP)))
            self._native.send(events)
            return {"ok": True, "action": action}
