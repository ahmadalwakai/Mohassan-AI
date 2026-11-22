"""Package the owner's original CONNECT logo (Design/connect-logo.jpg, the iOS one) for Android.

Adaptive icon (API 26+): the foreground is the logo's inscribed circle, scaled so the
metal ring stays inside the 66 dp safe zone; the background is the logo's own dark
corner colour (values/colors.xml: ic_launcher_background). Legacy launchers get the
complete square logo (ic_launcher) and its circle (ic_launcher_round). Nothing is
redrawn: only dimensions, cropping to the circle and PNG encoding change.

Run with Python + Pillow from anywhere:
    python apps/android/Tools/render_app_icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "Design" / "connect-logo.jpg"
RES = ROOT / "app" / "src" / "main" / "res"
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
ADAPTIVE_DP, LEGACY_DP = 108, 48
# 72 dp of the 108 dp canvas: the ring (about 86 % of the artwork) ends at 62 dp, inside the safe zone.
FOREGROUND_DP = 72


def circle(image: Image.Image) -> Image.Image:
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, image.width - 1, image.height - 1), fill=255)
    out = image.convert("RGBA")
    out.putalpha(mask)
    return out


def main():
    with Image.open(SOURCE) as source:
        logo = ImageOps.exif_transpose(source).convert("RGB")
    if logo.width != logo.height:
        raise ValueError("The approved logo must be square; do not crop it automatically.")
    corner = logo.getpixel((4, 4))
    print(f"Logo {logo.width} x {logo.height}; corner colour #{corner[0]:02X}{corner[1]:02X}{corner[2]:02X}")
    for name, scale in DENSITIES.items():
        folder = RES / f"mipmap-{name}"
        folder.mkdir(parents=True, exist_ok=True)
        canvas = round(ADAPTIVE_DP * scale)
        size = round(FOREGROUND_DP * scale)
        foreground = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
        art = circle(logo.resize((size, size), Image.Resampling.LANCZOS))
        offset = (canvas - size) // 2
        foreground.paste(art, (offset, offset), art)
        foreground.save(folder / "ic_launcher_foreground.png", format="PNG", optimize=True)
        legacy = round(LEGACY_DP * scale)
        square = logo.resize((legacy, legacy), Image.Resampling.LANCZOS)
        square.save(folder / "ic_launcher.png", format="PNG", optimize=True)
        circle(square).save(folder / "ic_launcher_round.png", format="PNG", optimize=True)
        print(f"{name}: foreground {canvas}px (art {size}px), legacy {legacy}px")


if __name__ == "__main__":
    main()
