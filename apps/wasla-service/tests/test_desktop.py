"""No real screenshot or input calls: all native operations are injected fakes."""
import ctypes
from contextlib import nullcontext
import io
import unittest

from PIL import Image

from wasla.desktop import (DesktopError, INPUT, KEY_UP, KEY_UNICODE, MOUSE_ABSOLUTE,
                           MOUSE_VIRTUALDESK, WindowsDesktop, _NativeWindows,
                           _keyboard, _mouse)


class FakeNative:
    def __init__(self):
        self.available = True
        self.local_modifiers = False
        self.events = []
        self.checks = 0
        self.dims = {"width": 1920, "height": 1080, "virtual_x": -1920,
                     "virtual_y": 0, "virtual_width": 3840, "virtual_height": 1080}

    def dpi_scope(self):
        return nullcontext()

    def assert_available(self):
        self.checks += 1
        if not self.available:
            raise DesktopError("locked")

    def assert_no_local_modifiers(self):
        if self.local_modifiers:
            raise DesktopError("local input active")

    def dimensions(self):
        return self.dims

    def send(self, events):
        self.events.extend(events)


class DesktopTests(unittest.TestCase):
    def setUp(self):
        self.native = FakeNative()
        self.grab_calls = []

        def grab(**kw):
            self.grab_calls.append(kw)
            return Image.new("RGB", (1920, 1080), "navy")

        self.desktop = WindowsDesktop(_native=self.native, _grab=grab)

    def test_input_structure_uses_pointer_alignment(self):
        self.assertEqual(ctypes.sizeof(INPUT), 40 if ctypes.sizeof(ctypes.c_void_p) == 8 else 28)

    def test_rejects_malformed_commands_without_touching_windows(self):
        malformed = [None, [], {"action": []}, {"action": "run", "cmd": "calc"},
                     {"action": "move", "x": True, "y": 0},
                     {"action": "move", "x": float("nan"), "y": 0},
                     {"action": "move", "x": float("inf"), "y": 0},
                     {"action": "move", "x": 10 ** 1000, "y": 0},
                     {"action": "move", "x": -0.1, "y": 0},
                     {"action": "move", "x": 1.1, "y": 0},
                     {"action": "move", "x": 0, "y": 0, "extra": 1},
                     {"action": "click", "button": "middle"},
                     {"action": "scroll", "dy": True},
                     {"action": "scroll", "dy": 11},
                     {"action": "scroll", "dy": 1.0},
                     {"action": "scroll", "dy": 0},
                     {"action": "key", "key": "win+r"},
                     {"action": "text", "text": ""},
                     {"action": "text", "text": "a" * 2001},
                     {"action": "text", "text": "\0"},
                     {"action": "text", "text": "\ud800"}]
        for command in malformed:
            with self.subTest(command=command), self.assertRaises(ValueError):
                self.desktop.input(command)
        self.assertEqual(self.native.checks, 0)
        self.assertEqual(self.native.events, [])

    def test_info_identifies_source_and_bounded_frame_dimensions(self):
        info = self.desktop.info()
        self.assertEqual((info["width"], info["height"]), (1920, 1080))
        self.assertEqual((info["frame_width"], info["frame_height"]), (1280, 720))
        self.assertEqual(info["monitor"], "primary")

    def test_capture_crops_primary_and_returns_bounded_jpeg(self):
        jpeg = self.desktop.capture()
        with Image.open(io.BytesIO(jpeg)) as image:
            self.assertEqual(image.format, "JPEG")
            self.assertEqual(image.size, (1280, 720))
        self.assertEqual(self.grab_calls[0]["bbox"], (0, 0, 1920, 1080))
        self.assertTrue(self.grab_calls[0]["all_screens"])
        self.assertEqual(self.native.checks, 2)

    def test_capture_drops_frame_when_session_locks_during_capture(self):
        def grab(**_):
            self.native.available = False
            return Image.new("RGB", (1920, 1080))
        desktop = WindowsDesktop(_native=self.native, _grab=grab)
        with self.assertRaises(DesktopError):
            desktop.capture()

    def test_capture_rejects_monitor_change(self):
        desktop = WindowsDesktop(_native=self.native, _grab=lambda **_: Image.new("RGB", (1600, 900)))
        with self.assertRaises(DesktopError):
            desktop.capture()

    def test_noninteractive_session_fails_closed(self):
        self.native.available = False
        for operation in (self.desktop.info, self.desktop.capture,
                          lambda: self.desktop.input({"action": "click", "button": "left"})):
            with self.assertRaises(DesktopError):
                operation()
        self.assertEqual(self.native.events, [])
        self.assertEqual(self.grab_calls, [])

    def test_local_modifiers_prevent_input(self):
        self.native.local_modifiers = True
        with self.assertRaises(DesktopError):
            self.desktop.input({"action": "text", "text": "hello"})
        self.assertEqual(self.native.events, [])

    def test_primary_coordinates_account_for_negative_virtual_origin(self):
        self.desktop.input({"action": "move", "x": 0, "y": 0})
        first = self.native.events[-1]
        self.assertEqual(first.mi.dx, round(1920 * 65535 / 3839))
        self.assertEqual(first.mi.dy, 0)
        self.assertTrue(first.mi.dwFlags & MOUSE_ABSOLUTE)
        self.assertTrue(first.mi.dwFlags & MOUSE_VIRTUALDESK)
        self.desktop.input({"action": "move", "x": 1, "y": 1})
        last = self.native.events[-1]
        self.assertEqual((last.mi.dx, last.mi.dy), (65535, 65535))

    def test_click_has_paired_release(self):
        self.desktop.input({"action": "click", "button": "right"})
        self.assertEqual([e.mi.dwFlags for e in self.native.events], [8, 16])

    def test_negative_wheel_detents_use_signed_dword(self):
        self.desktop.input({"action": "scroll", "dy": -2})
        self.assertEqual(ctypes.c_int32(self.native.events[0].mi.mouseData).value, -240)

    def test_navigation_key_has_extended_flag_and_release(self):
        self.desktop.input({"action": "key", "key": "left"})
        self.assertEqual([e.ki.dwFlags for e in self.native.events], [1, 3])
        self.assertTrue(all(e.ki.wVk == 0x25 for e in self.native.events))

    def test_arabic_and_emoji_are_utf16_units_with_paired_release(self):
        text = "مرحبا🌅"
        self.desktop.input({"action": "text", "text": text})
        events = self.native.events
        encoded = text.encode("utf-16-le")
        units = [int.from_bytes(encoded[i:i+2], "little") for i in range(0, len(encoded), 2)]
        self.assertEqual([e.ki.wScan for e in events[::2]], units)
        for down, up in zip(events[::2], events[1::2]):
            self.assertEqual(down.ki.wVk, 0)
            self.assertEqual(down.ki.dwFlags, KEY_UNICODE)
            self.assertEqual(up.ki.dwFlags, KEY_UNICODE | KEY_UP)

    def test_newline_and_tab_are_explicit_paired_keys(self):
        self.desktop.input({"action": "text", "text": "\r\n\t"})
        self.assertEqual([e.ki.wVk for e in self.native.events], [13, 13, 9, 9])
        self.assertEqual([e.ki.dwFlags for e in self.native.events], [0, 2, 0, 2])

    def test_partial_native_insertion_attempts_only_releases_and_reports_failure(self):
        calls = []

        class FakeUser32:
            def SendInput(self, count, array, size):
                calls.append((count, list(array), size))
                return 1 if len(calls) == 1 else count

        native = _NativeWindows.__new__(_NativeWindows)
        native.user32 = FakeUser32()
        events = [_keyboard(13), _keyboard(13, flags=KEY_UP), _mouse(2), _mouse(4)]
        with self.assertRaises(DesktopError):
            native.send(events)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1][0], 2)
        self.assertEqual(calls[1][1][0].ki.dwFlags, KEY_UP)
        self.assertEqual(calls[1][1][1].mi.dwFlags, 4)
        self.assertEqual(calls[0][2], ctypes.sizeof(INPUT))

    def test_zero_native_insertion_is_not_reported_as_success(self):
        class FakeUser32:
            def SendInput(self, *_):
                return 0

        native = _NativeWindows.__new__(_NativeWindows)
        native.user32 = FakeUser32()
        with self.assertRaises(DesktopError):
            native.send([_mouse(1, 4, 5)])


if __name__ == "__main__":
    unittest.main()
