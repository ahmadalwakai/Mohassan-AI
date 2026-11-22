"""Drive the app on an emulator or phone from the command line, by what is on screen.

Compose publishes its text and content descriptions to the accessibility tree, which
`uiautomator dump` reads, so a test can tap «ربط الكمبيوتر» instead of guessing pixels.

    python apps/android/Tools/adb_ui.py list [substring]      nodes with text or description (and bounds)
    python apps/android/Tools/adb_ui.py tap <text> [n]        tap the n-th node whose text or description is, or contains, it
    python apps/android/Tools/adb_ui.py tapxy <x> <y>
    python apps/android/Tools/adb_ui.py edit [n]              focus the n-th text field and clear it
    python apps/android/Tools/adb_ui.py fill <n> <text>       clear the n-th field, type ASCII text in short bursts, read it back
    python apps/android/Tools/adb_ui.py type <text>           ASCII only: adb's `input text` cannot type Arabic
    python apps/android/Tools/adb_ui.py key <keyevent>        e.g. 66 (Enter), 4 (Back), 111 (Escape)
    python apps/android/Tools/adb_ui.py hidekb                Back only while the keyboard is up
    python apps/android/Tools/adb_ui.py focus                 the window in front
    python apps/android/Tools/adb_ui.py backother             Back only while another app's window is in front
    python apps/android/Tools/adb_ui.py swipe <x1> <y1> <x2> <y2> [ms]
    python apps/android/Tools/adb_ui.py scrolldown
    python apps/android/Tools/adb_ui.py shot <file.png>
    python apps/android/Tools/adb_ui.py wait <seconds>

ANDROID_SERIAL picks the device (default emulator-5554). Exit code 1 when a node is not found.
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")

SERIAL = os.environ.get("ANDROID_SERIAL", "emulator-5554")
ADB = os.environ.get("ADB", "adb")
APP = "com.ahmadalwakai.wasla/"


def adb(*args: str, binary: bool = False, timeout: float = 60) -> bytes | str:
    try:
        result = subprocess.run([ADB, "-s", SERIAL, *args], capture_output=True, check=False, timeout=timeout)
    except subprocess.TimeoutExpired:
        return b"" if binary else ""
    if result.returncode != 0 and not binary:
        sys.stderr.write(result.stderr.decode("utf-8", "replace"))
    return result.stdout if binary else result.stdout.decode("utf-8", "replace")


def current_focus() -> str:
    text = adb("shell", "dumpsys", "window")
    marker = "mCurrentFocus="
    if marker not in text:
        return "?"
    return text.split(marker, 1)[1].splitlines()[0].strip()


def keyboard_shown() -> bool:
    return "mInputShown=true" in adb("shell", "dumpsys", "input_method")


def hide_keyboard() -> None:
    """Back closes only the keyboard while it is up; it is never sent otherwise."""
    if keyboard_shown():
        adb("shell", "input", "keyevent", "4")
        time.sleep(0.6)


def bounds(value: str) -> tuple[int, int, int, int]:
    left, top, right, bottom = [int(part) for part in value.replace("][", ",").strip("[]").split(",")]
    return left, top, right, bottom


def dump() -> list[dict]:
    for attempt in range(4):
        # A blinking cursor keeps the UI "busy" for uiautomator; the dump is bounded and retried without the keyboard.
        adb("shell", "rm", "-f", "/sdcard/ui.xml")
        adb("shell", "uiautomator", "dump", "/sdcard/ui.xml", timeout=25)
        raw = adb("exec-out", "cat", "/sdcard/ui.xml", binary=True)
        if not raw.strip():
            hide_keyboard()
            continue
        try:
            root = ET.fromstring(raw.decode("utf-8", "replace"))
            break
        except ET.ParseError:
            time.sleep(0.8)
    else:
        raise SystemExit("could not read the UI tree")
    out = []
    for node in root.iter("node"):
        text, desc = node.get("text") or "", node.get("content-desc") or ""
        editable = (node.get("class") or "").endswith("EditText")
        if not text and not desc and not editable:
            continue
        out.append({"text": text, "desc": desc, "class": (node.get("class") or "").split(".")[-1], "bounds": bounds(node.get("bounds")), "clickable": node.get("clickable")})
    return out


def find(substring: str, index: int = 0) -> dict:
    nodes = dump()
    # An exact text or description wins over a line that merely mentions the words («التالي» the button, not a note about it).
    matches = [node for node in nodes if node["text"] == substring or node["desc"] == substring] or \
        [node for node in nodes if substring in node["text"] or substring in node["desc"]]
    if len(matches) <= index:
        raise SystemExit(f"not on screen: {substring!r} (found {len(matches)})")
    return matches[index]


def tap(node: dict) -> None:
    left, top, right, bottom = node["bounds"]
    adb("shell", "input", "tap", str((left + right) // 2), str((top + bottom) // 2))


def escape(text: str) -> str:
    out = []
    for char in text:
        if char == " ":
            out.append("%s")
        elif char in "\\\"'`$&|;<>()*?[]{}~#!":
            out.append("\\" + char)
        else:
            out.append(char)
    return "".join(out)


def fields() -> list[dict]:
    return [node for node in dump() if node["class"] == "EditText"]


def edit(index: int) -> None:
    """Focus the n-th text field and clear it (select all, delete)."""
    found = fields()
    if len(found) <= index:
        raise SystemExit(f"no text field #{index} (found {len(found)})")
    tap(found[index])
    time.sleep(1.2)
    adb("shell", "input", "keycombination", "113", "29")
    time.sleep(0.3)
    adb("shell", "input", "keyevent", "67")
    time.sleep(0.3)
    print(f"editing field #{index} at {found[index]['bounds']}")


def fill(index: int, text: str) -> int:
    if any(ord(char) > 126 for char in text):
        raise SystemExit("adb can only type ASCII")
    for attempt in range(3):
        edit(index)
        # `input text` drops characters in long bursts on emulators; short chunks arrive whole.
        for start in range(0, len(text), 8):
            adb("shell", "input", "text", escape(text[start:start + 8]))
            time.sleep(0.25)
        time.sleep(0.8)
        found = fields()
        got = found[index]["text"] if len(found) > index else None
        print(f"field #{index} now {got!r}")
        if got == text:
            return 0
    return 1


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    command, rest = argv[0], argv[1:]
    if command == "list":
        needle = rest[0] if rest else ""
        for node in dump():
            if needle in node["text"] or needle in node["desc"]:
                label = node["text"] or f"<{node['desc']}>"
                print(f"{node['bounds']}  {node['class']:<12} {label}")
        return 0
    if command == "tap":
        node = find(rest[0], int(rest[1]) if len(rest) > 1 else 0)
        tap(node)
        print(f"tapped {node['text'] or node['desc']!r} at {node['bounds']}")
        return 0
    if command == "tapxy":
        adb("shell", "input", "tap", rest[0], rest[1])
        return 0
    if command == "edit":
        edit(int(rest[0]) if rest else 0)
        return 0
    if command == "fill":
        return fill(int(rest[0]), " ".join(rest[1:]))
    if command == "type":
        text = " ".join(rest)
        if any(ord(char) > 126 for char in text):
            raise SystemExit("adb can only type ASCII")
        adb("shell", "input", "text", escape(text))
        return 0
    if command == "key":
        adb("shell", "input", "keyevent", rest[0])
        return 0
    if command == "hidekb":
        hide_keyboard()
        return 0
    if command == "focus":
        print(current_focus())
        return 0
    if command == "backother":
        # Back only while another app's window (share sheet, browser tab) is in front; never closes this app.
        focus = current_focus()
        if APP in focus:
            print("app in front; not pressing back")
            return 1
        adb("shell", "input", "keyevent", "4")
        print(f"back from {focus}")
        return 0
    if command == "swipe":
        adb("shell", "input", "swipe", rest[0], rest[1], rest[2], rest[3], rest[4] if len(rest) > 4 else "300")
        return 0
    if command == "scrolldown":
        adb("shell", "input", "swipe", "540", "1900", "540", "500", "700")
        time.sleep(0.8)
        return 0
    if command == "shot":
        data = adb("exec-out", "screencap", "-p", binary=True)
        with open(rest[0], "wb") as handle:
            handle.write(data)
        print(f"{rest[0]}: {len(data)} bytes")
        return 0
    if command == "wait":
        time.sleep(float(rest[0]))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
