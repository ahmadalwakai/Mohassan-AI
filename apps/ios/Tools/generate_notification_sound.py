#!/usr/bin/env python3
"""Generate the two-note Mohassan completion chime as a mono LPCM CAF."""

import argparse
import math
from pathlib import Path
import struct


SAMPLE_RATE = 24_000
NOTES = (
    (0.0, 0.38, 587.33, 0.25),
    (0.16, 0.53, 783.99, 0.27),
)
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "Wasla" / "mohassan-done.caf"


def sample_at(time):
    value = 0.0
    for start, duration, frequency, volume in NOTES:
        elapsed = time - start
        if 0 <= elapsed < duration:
            envelope = min(1, elapsed / 0.018, (duration - elapsed) / 0.060)
            phase = math.tau * frequency * elapsed
            partials = math.sin(phase) + 0.12 * math.sin(2 * phase)
            value += volume * envelope * math.exp(-5 * elapsed) * partials
    return round(value * 32_767)


def caf_chunk(name, contents):
    return struct.pack(">4sQ", name, len(contents)) + contents


def generate_sound():
    duration = max(start + length for start, length, _, _ in NOTES) + 0.03
    frames = b"".join(
        struct.pack(">h", sample_at(frame / SAMPLE_RATE))
        for frame in range(round(duration * SAMPLE_RATE))
    )

    # Signed 16-bit big-endian LPCM, one frame per packet, one channel.
    description = struct.pack(">d4sIIIII", SAMPLE_RATE, b"lpcm", 0, 2, 1, 1, 16)
    return (
        struct.pack(">4sHH", b"caff", 1, 0)
        + caf_chunk(b"desc", description)
        + caf_chunk(b"data", struct.pack(">I", 0) + frames)
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", nargs="?", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    args.output.write_bytes(generate_sound())


if __name__ == "__main__":
    main()
