"""Package the user's original CONNECT logo for the iOS asset catalog.

Only the required dimensions and PNG encoding change. The square artwork is
kept complete, with no crop, generated details, corner mask, or added border.
Run with Python + Pillow; the generated asset is committed for cloud builds.
"""
from pathlib import Path

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "Design/connect-logo.jpg"
DESTINATION = ROOT / "Wasla/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"


def main():
    with Image.open(SOURCE) as source:
        logo = ImageOps.exif_transpose(source)
        if logo.width != logo.height:
            raise ValueError("The approved logo must be square; do not crop it automatically.")
        icon = logo.convert("RGB").resize((1024, 1024), Image.Resampling.LANCZOS)
        DESTINATION.parent.mkdir(parents=True, exist_ok=True)
        icon.save(DESTINATION, format="PNG", optimize=True)
    print(f"Packaged {DESTINATION.name}: 1024 x 1024, opaque RGB, complete original logo")


if __name__ == "__main__":
    main()
