"""Draw random lines of a shard into one sheet and print their labels, to check crops against labels by eye.

    python -I scripts/vision/show_shard.py artifacts/vision-real-v1/data real-train out.png [count] [seed]
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

import numpy as np
from PIL import Image

HEIGHT = 32


def main() -> None:
    directory, name, out = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
    count = int(sys.argv[4]) if len(sys.argv) > 4 else 24
    rng = random.Random(int(sys.argv[5]) if len(sys.argv) > 5 else 3)
    meta = json.loads((directory / f"{name}.json").read_text(encoding="utf-8"))
    data = np.memmap(directory / f"{name}.u8", dtype=np.uint8, mode="r")
    lines = rng.sample(meta["lines"], min(count, len(meta["lines"])))
    width = max(line["w"] for line in lines)
    sheet = np.full((len(lines) * (HEIGHT + 4), width + 8), 60, dtype=np.uint8)
    for row, line in enumerate(lines):
        pixels = np.asarray(data[line["o"]:line["o"] + HEIGHT * line["w"]]).reshape(HEIGHT, line["w"])
        sheet[row * (HEIGHT + 4) + 2:row * (HEIGHT + 4) + 2 + HEIGHT, 4:4 + line["w"]] = pixels
        print(f"{row:2d} {line['f'][:22]:22s} {line.get('v', ''):18s} visual={line['l']!r}  logical={line['t']!r}")
    Image.fromarray(sheet).resize((sheet.shape[1] * 2, sheet.shape[0] * 2), Image.Resampling.NEAREST).save(out)
    print("saved", out)


if __name__ == "__main__":
    main()
