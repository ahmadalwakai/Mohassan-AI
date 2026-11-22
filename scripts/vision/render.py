"""Render one text line into a 32-pixel-high grayscale image with realistic degradations.

Arabic is shaped into presentation forms and ordered visually with the same rules
the server uses in reverse, so the label stays the characters as drawn left to right.
"""
from __future__ import annotations

import glob
import io
import os
import random
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from charset import classify, to_visual

HEIGHT = 32
MAX_WIDTH = 1024
FONT_DIR = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"

ARABIC_FONTS = ["arial.ttf", "arialbd.ttf", "calibri.ttf", "calibrib.ttf", "calibril.ttf", "cour.ttf", "courbd.ttf", "majalla.ttf",
                "majallab.ttf", "micross.ttf", "segoeui.ttf", "segoeuib.ttf", "segoeuil.ttf", "segoeuisl.ttf", "seguisb.ttf", "simpbdo.ttf",
                "simpfxo.ttf", "simpo.ttf", "tahoma.ttf", "tahomabd.ttf", "times.ttf", "timesbd.ttf", "tradbdo.ttf", "trado.ttf",
                "andlso.ttf", "arabtype.ttf", "aldhabi.ttf", "msuighur.ttf", "msuighub.ttf"]
LATIN_FONTS = ["arial.ttf", "arialbd.ttf", "arialbi.ttf", "ariali.ttf", "ariblk.ttf", "bahnschrift.ttf", "calibri.ttf", "calibrib.ttf",
               "calibrii.ttf", "calibril.ttf", "calibriz.ttf", "cambria.ttc", "cambriab.ttf", "cambriai.ttf", "Candara.ttf", "Candarab.ttf",
               "Candarai.ttf", "comic.ttf", "comicbd.ttf", "consola.ttf", "consolab.ttf", "consolai.ttf", "constan.ttf", "constanb.ttf",
               "corbel.ttf", "corbelb.ttf", "corbeli.ttf", "cour.ttf", "courbd.ttf", "couri.ttf", "ebrima.ttf", "ebrimabd.ttf", "framd.ttf",
               "gadugi.ttf", "gadugib.ttf", "georgia.ttf", "georgiab.ttf", "georgiai.ttf", "impact.ttf", "l_10646.ttf", "lucon.ttf",
               "malgun.ttf", "malgunbd.ttf", "micross.ttf", "pala.ttf", "palab.ttf", "palai.ttf", "segoeui.ttf", "segoeuib.ttf", "segoeuii.ttf",
               "segoeuil.ttf", "segoeuisl.ttf", "segoeuiz.ttf", "seguibl.ttf", "seguili.ttf", "seguisb.ttf", "seguisbi.ttf", "segoepr.ttf",
               "segoesc.ttf", "sylfaen.ttf", "tahoma.ttf", "tahomabd.ttf", "times.ttf", "timesbd.ttf", "timesbi.ttf", "timesi.ttf",
               "trebuc.ttf", "trebucbd.ttf", "trebucit.ttf", "verdana.ttf", "verdanab.ttf", "verdanai.ttf", "Inkfree.ttf", "Gabriola.ttf",
               "LeelawUI.ttf", "LeelaUIb.ttf", "msyh.ttc", "msjh.ttc", "simsun.ttc", "YuGothR.ttc", "YuGothB.ttc"]
# Never seen in training; they measure how the model generalises to new typefaces.
HELD_OUT_ARABIC = {"andlso.ttf", "calibril.ttf", "tradbdo.ttf"}
HELD_OUT_LATIN = {"georgia.ttf", "georgiab.ttf", "georgiai.ttf", "trebuc.ttf", "trebucbd.ttf", "trebucit.ttf", "corbel.ttf", "corbelb.ttf", "corbeli.ttf"}
# Decorative or script faces: kept rare so the model still meets them.
RARE = {"aldhabi.ttf", "msuighur.ttf", "msuighub.ttf", "segoepr.ttf", "segoesc.ttf", "Inkfree.ttf", "Gabriola.ttf", "impact.ttf", "comic.ttf", "comicbd.ttf"}

try:
    import arabic_reshaper
    _RESHAPER = arabic_reshaper.ArabicReshaper(configuration={"delete_harakat": True, "support_ligatures": True, "delete_tatweel": True})
except ImportError:  # pragma: no cover - the generator needs it, the tests may not
    _RESHAPER = None


def has_arabic(text: str) -> bool:
    return any(classify(c) == "R" for c in text)


@lru_cache(maxsize=None)
def _font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size, layout_engine=ImageFont.Layout.BASIC)


@lru_cache(maxsize=None)
def _notdef(path: str) -> bytes:
    mask = _font(path, 40).getmask("\uffff")
    return bytes(mask) + bytes(mask.size)


@lru_cache(maxsize=None)
def supports(path: str, char: str) -> bool:
    if char == " ":
        return True
    try:
        mask = _font(path, 40).getmask(char)
    except Exception:
        return False
    if mask.getbbox() is None:
        return char in " \u00a0"
    return bytes(mask) + bytes(mask.size) != _notdef(path)


class FontRegistry:
    def __init__(self, font_dir: Path = FONT_DIR) -> None:
        present = {os.path.basename(p).lower(): p for p in glob.glob(str(font_dir / "*.tt[fc]"))}
        pick = lambda names: [present[n.lower()] for n in names if n.lower() in present]
        self.arabic = pick([n for n in ARABIC_FONTS if n not in HELD_OUT_ARABIC])
        self.latin = pick([n for n in LATIN_FONTS if n not in HELD_OUT_LATIN])
        self.arabic_holdout = pick(sorted(HELD_OUT_ARABIC))
        self.latin_holdout = pick(sorted(HELD_OUT_LATIN))
        # Arabic fonts must draw presentation forms, which basic layout needs.
        self.arabic = [p for p in self.arabic if supports(p, "\ufe91") and supports(p, "\ufefb")]
        self.arabic_holdout = [p for p in self.arabic_holdout if supports(p, "\ufe91") and supports(p, "\ufefb")]
        if not self.arabic or not self.latin:
            raise RuntimeError("fonts missing")

    def choose(self, rng: random.Random, arabic: bool, holdout: bool) -> str:
        pool = (self.arabic_holdout if arabic else self.latin_holdout) if holdout else (self.arabic if arabic else self.latin)
        for _ in range(8):
            path = rng.choice(pool)
            if os.path.basename(path) in RARE and rng.random() < 0.7:
                continue
            return path
        return rng.choice(pool)


def shape(text: str) -> str:
    """Presentation-form glyphs in logical order; Latin and digits untouched."""
    if _RESHAPER is None or not has_arabic(text):
        return text
    return _RESHAPER.reshape(text)


def _background(rng: random.Random, size: tuple[int, int], bg: int) -> Image.Image:
    width, height = size
    roll = rng.random()
    if roll < 0.7:
        return Image.new("L", size, bg)
    if roll < 0.9:
        other = max(0, min(255, bg + rng.randint(-40, 40)))
        ramp = np.linspace(bg, other, width if rng.random() < 0.7 else height, dtype=np.float32)
        arr = np.tile(ramp, (height, 1)) if ramp.size == width else np.tile(ramp[:, None], (1, width))
        return Image.fromarray(arr.astype(np.uint8), "L")
    noise = np.clip(np.random.default_rng(rng.randrange(1 << 30)).normal(bg, rng.uniform(2, 10), (height, width)), 0, 255)
    return Image.fromarray(noise.astype(np.uint8), "L")


def render_line(text: str, base: str, rng: random.Random, registry: FontRegistry, holdout: bool = False, augment: bool = True):
    """Return (uint8 array HEIGHT x W, visual label, meta) or None when the text cannot be drawn."""
    arabic = has_arabic(text)
    glyphs = to_visual(shape(text), base)
    label = to_visual(text, base)
    path = None
    for _ in range(4):
        candidate = registry.choose(rng, arabic, holdout)
        if all(supports(candidate, c) for c in set(glyphs)):
            path = candidate
            break
    if path is None:
        return None
    size = rng.choice([rng.randint(14, 22), rng.randint(20, 40), rng.randint(36, 64)])
    font = _font(path, size)
    probe = ImageDraw.Draw(Image.new("L", (1, 1)))
    left, top, right, bottom = probe.textbbox((0, 0), glyphs, font=font)
    text_w, text_h = max(1, right - left), max(1, bottom - top)
    if text_w / text_h * HEIGHT > MAX_WIDTH * 1.15:
        return None
    dark_on_light = rng.random() < 0.72
    if dark_on_light:
        bg = rng.randint(170, 255)
        fg = rng.randint(0, max(0, bg - (25 if rng.random() < 0.1 else 70)))
    else:
        bg = rng.randint(0, 90)
        fg = rng.randint(min(255, bg + (25 if rng.random() < 0.1 else 70)), 255)
    pad_x = rng.randint(2, 14) if augment else 4
    pad_top = rng.randint(1, 8) if augment else 3
    pad_bottom = rng.randint(1, 8) if augment else 3
    width, height = text_w + 2 * pad_x, text_h + pad_top + pad_bottom
    image = _background(rng, (width, height), bg) if augment else Image.new("L", (width, height), bg)
    draw = ImageDraw.Draw(image)
    if augment and rng.random() < 0.10:
        # A sliver of a neighbouring line, as crops of dense text show.
        other = _font(path, size)
        y = -rng.randint(int(text_h * 0.6), text_h) if rng.random() < 0.5 else height - rng.randint(0, int(text_h * 0.35))
        draw.text((rng.randint(-20, 20) + pad_x, y), glyphs[::-1][: max(3, len(glyphs) // 2)], font=other, fill=fg)
    draw.text((pad_x - left, pad_top - top), glyphs, font=font, fill=fg)
    if augment and rng.random() < 0.08:
        y = pad_top - top + bottom - rng.randint(0, 2)
        draw.line([(pad_x, y), (pad_x + text_w, y)], fill=fg, width=max(1, size // 18))
    if augment and rng.random() < 0.10:
        y = rng.choice([0, height - 1])
        draw.line([(0, y), (width, y)], fill=rng.randint(0, 255), width=1)
    meta = {"font": os.path.basename(path), "size": size, "dark_on_light": dark_on_light}
    if augment:
        image = _degrade(image, rng, bg)
    arr = _to_height(image, rng if augment else None)
    if arr is None:
        return None
    return arr, label, meta


def _degrade(image: Image.Image, rng: random.Random, bg: int) -> Image.Image:
    width, height = image.size
    if rng.random() < 0.4:
        factor = rng.uniform(0.7, 1.3)
        image = image.resize((max(8, int(width * factor)), height), Image.Resampling.BILINEAR)
    if rng.random() < 0.25:
        angle = rng.uniform(-1.5, 1.5)
        image = image.rotate(angle, resample=Image.Resampling.BILINEAR, expand=False, fillcolor=bg)
    if rng.random() < 0.15:
        shear = rng.uniform(-0.12, 0.12)
        image = image.transform(image.size, Image.Transform.AFFINE, (1, shear, -shear * image.size[1] / 2, 0, 1, 0), resample=Image.Resampling.BILINEAR, fillcolor=bg)
    if rng.random() < 0.25:
        small = max(10, int(image.size[1] * rng.uniform(0.35, 0.8)))
        image = image.resize((max(8, int(image.size[0] * small / image.size[1])), small), Image.Resampling.BILINEAR)
    if rng.random() < 0.35:
        image = image.filter(ImageFilter.GaussianBlur(rng.uniform(0.3, 1.2)))
    if rng.random() < 0.3:
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=rng.randint(20, 85))
        image = Image.open(io.BytesIO(buffer.getvalue())).convert("L")
    arr = np.asarray(image, dtype=np.float32)
    if rng.random() < 0.4:
        arr = arr + np.random.default_rng(rng.randrange(1 << 30)).normal(0, rng.uniform(2, 14), arr.shape)
    if rng.random() < 0.5:
        contrast, brightness = rng.uniform(0.6, 1.2), rng.uniform(-30, 30)
        arr = (arr - 128) * contrast + 128 + brightness
    if rng.random() < 0.1:
        gamma = rng.uniform(0.6, 1.6)
        arr = 255 * np.power(np.clip(arr, 0, 255) / 255, gamma)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "L")


def _to_height(image: Image.Image, rng: random.Random | None):
    width, height = image.size
    new_w = int(round(width * HEIGHT / height))
    if new_w < 8 or new_w > MAX_WIDTH:
        return None
    resample = Image.Resampling.LANCZOS if rng is None or rng.random() < 0.6 else Image.Resampling.BILINEAR
    return np.asarray(image.resize((new_w, HEIGHT), resample), dtype=np.uint8)


def to_model_input(arr: np.ndarray) -> np.ndarray:
    """Pixels to the model's input scale, shared with the TypeScript reader."""
    return (arr.astype(np.float32) / 255.0 - 0.5) / 0.5
