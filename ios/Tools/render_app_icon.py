"""Rasterize the code-native link geometry in Design/app-icon.svg.

Run with Python + Pillow. The shipped PNG is already generated; this tool is not
part of the Xcode build. Geometry is supersampled and saved as opaque RGB.
"""
from pathlib import Path
import math
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SCALE = 3
SIZE = 1024
BACKGROUND = (23, 61, 43)
IVORY = (240, 246, 222)
MINT = (169, 221, 185)


def cubic(start, one, two, end):
    points = []
    for i in range(1, 81):
        t = i / 80
        u = 1 - t
        points.append((u**3*start[0] + 3*u*u*t*one[0] + 3*u*t*t*two[0] + t**3*end[0],
                       u**3*start[1] + 3*u*u*t*one[1] + 3*u*t*t*two[1] + t**3*end[1]))
    return points


def capsule(top):
    first = (512, top)
    result = [first]
    result += cubic(first, (594, top), (660, top+66), (660, top+148))
    result.append((660, top+296))
    result += cubic(result[-1], (660, top+378), (594, top+444), (512, top+444))
    result += cubic(result[-1], (430, top+444), (364, top+378), (364, top+296))
    result.append((364, top+148))
    result += cubic(result[-1], (364, top+66), (430, top), first)
    return result


def transformed(points):
    angle = math.radians(42)
    co, si = math.cos(angle), math.sin(angle)
    return [((512 + (x-512)*co - (y-512)*si)*SCALE,
             (512 + (x-512)*si + (y-512)*co)*SCALE) for x, y in points]


def stroke(draw, points, color, caps=False):
    points = transformed(points)
    width = 64*SCALE
    draw.line(points, fill=color, width=width)
    # Overlapping round joins avoid raster cracks in Pillow's wide curved lines.
    radius = width/2
    for x, y in points:
        draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill=color)


image = Image.new("RGB", (SIZE*SCALE, SIZE*SCALE), BACKGROUND)
draw = ImageDraw.Draw(image)
stroke(draw, capsule(420), IVORY)
stroke(draw, capsule(160), MINT)
stroke(draw, [(512, 420)] + cubic((512, 420), (594, 420), (660, 486), (660, 568)), IVORY, caps=True)
image = image.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
destination = ROOT / "Wasla/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"
destination.parent.mkdir(parents=True, exist_ok=True)
image.save(destination, optimize=True)
print(f"Created {destination.name}: {image.width} x {image.height}, {image.mode}, no alpha")
