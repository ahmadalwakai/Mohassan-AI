"""Draw a sheet of generated samples so the rendering can be checked by eye.

    python -I scripts/vision/preview.py <out.png> [seed] [count] [--holdout]
"""
from __future__ import annotations

import random
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from render import FontRegistry, render_line  # noqa: E402
from textgen import TextSampler  # noqa: E402


def main() -> None:
    out = Path(sys.argv[1])
    seed = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 7
    count = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3].isdigit() else 24
    holdout = "--holdout" in sys.argv
    rng = random.Random(seed)
    sampler = TextSampler(per_source=20_000)
    registry = FontRegistry()
    print("fonts", len(registry.arabic), "arabic", len(registry.latin), "latin", len(registry.arabic_holdout), len(registry.latin_holdout), "held out")
    rows = []
    while len(rows) < count:
        text, base, kind = sampler.sample(rng)
        result = render_line(text, base, rng, registry, holdout=holdout)
        if result is None:
            print("skip", kind, text)
            continue
        arr, label, meta = result
        rows.append(arr)
        print(f"{kind:9s} {base} {meta['font']:14s} {meta['size']:2d} w={arr.shape[1]:4d} text={text!r} label={label!r}")
    width = max(r.shape[1] for r in rows)
    sheet = np.full((len(rows) * 36, width + 8, 3), 60, dtype=np.uint8)
    for i, row in enumerate(rows):
        sheet[i * 36 + 2:i * 36 + 34, 4:4 + row.shape[1], :] = row[:, :, None]
    scale = 2
    Image.fromarray(sheet).resize((sheet.shape[1] * scale, sheet.shape[0] * scale), Image.Resampling.NEAREST).save(out)
    print("saved", out)


if __name__ == "__main__":
    main()
