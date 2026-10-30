#!/usr/bin/env python3
"""Generate Top 20 PWA icons with PIL — brand wordmark on near-black.

Draws at 4x supersample and downscales. Wordmark: slanted "TOP" in glossy
royal blue + "20" in platinum, with a flame strip under it (matching the
site's wordmark/blaze). Maskable variant keeps the art inside the safe
zone (center 80%) with extra background padding.
"""
import math
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), "..", "public", "icons")
os.makedirs(OUT, exist_ok=True)

BOLD = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
BG_TOP = (16, 16, 19)
BG_BOT = (4, 4, 5)


def vgrad(size, top, bot):
    img = Image.new("RGB", (size, size), top)
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(size - 1, 1)
        c = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3))
        d.line([(0, y), (size, y)], fill=c)
    return img


def text_gradient(draw_img, xy, text, font, stops, stroke_w=0):
    """Draw text filled with a vertical gradient via a mask."""
    mask = Image.new("L", draw_img.size, 0)
    md = ImageDraw.Draw(mask)
    md.text(xy, text, font=font, fill=255, stroke_width=stroke_w)
    grad = Image.new("RGB", draw_img.size)
    gd = ImageDraw.Draw(grad)
    h = draw_img.size[1]
    for y in range(h):
        # position within gradient across full canvas is fine for letters
        t = y / max(h - 1, 1)
        # map through stops
        seg = t * (len(stops) - 1)
        i = min(int(seg), len(stops) - 2)
        f = seg - i
        c = tuple(int(stops[i][k] + (stops[i + 1][k] - stops[i][k]) * f) for k in range(3))
        gd.line([(0, y), (draw_img.size[0], y)], fill=c)
    draw_img.paste(grad, (0, 0), mask)
    return mask


def draw_icon(size, maskable=False):
    S = size * 4  # supersample
    img = vgrad(S, BG_TOP, BG_BOT).convert("RGBA")
    scale = 0.62 if maskable else 0.86  # fraction of canvas the art spans
    art_w = int(S * scale)
    # Wordmark layer, drawn upright then sheared for the italic lean.
    wm = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    fsize = int(art_w * 0.34)
    font = ImageFont.truetype(BOLD, fsize)
    tmp = ImageDraw.Draw(wm)
    w_top = tmp.textlength("TOP", font=font)
    w_20 = tmp.textlength("20", font=font)
    gap = int(fsize * 0.10)
    total = w_top + gap + w_20
    x0 = (S - total) / 2
    y0 = int(S * 0.30)
    # stamped look: dark offset copy underneath
    sh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sd.text((x0, y0 + int(fsize * 0.045)), "TOP", font=font, fill=(0, 0, 0, 190))
    sd.text((x0 + w_top + gap, y0 + int(fsize * 0.045)), "20", font=font, fill=(0, 0, 0, 190))
    wm.alpha_composite(sh)
    blue = [(157, 185, 255), (43, 92, 255), (18, 58, 158), (111, 151, 255)]
    plat = [(255, 255, 255), (232, 235, 241), (174, 181, 194), (244, 246, 250), (195, 201, 212), (255, 255, 255)]
    text_gradient(wm, (x0, y0), "TOP", font, blue)
    text_gradient(wm, (x0 + w_top + gap, y0), "20", font, plat)
    # shear: lean right at top (italic)
    wm = wm.transform((S, S), Image.AFFINE, (1, -0.16, 0.16 * y0, 0, 1, 0), resample=Image.BICUBIC)
    img.alpha_composite(wm)
    # Flame strip under the wordmark, full art width.
    d = ImageDraw.Draw(img, "RGBA")
    fy = y0 + int(fsize * 1.22)
    fx0, fx1 = int((S - art_w) / 2), int((S + art_w) / 2)
    fh = max(int(S * 0.028), 6)
    for x in range(fx0, fx1):
        t = (x - fx0) / max(fx1 - fx0, 1)
        flicker = 0.55 + 0.45 * abs(math.sin(t * 28.0)) * abs(math.sin(t * 7.0 + 1.3))
        hh = int(fh * flicker)
        # red base -> orange -> yellow tip
        d.line([(x, fy), (x, fy - hh)], fill=(255, 45, 0, 255))
        d.line([(x, fy - int(hh * 0.25)), (x, fy - hh)], fill=(255, 90, 0, 255))
        d.line([(x, fy - int(hh * 0.6)), (x, fy - hh)], fill=(255, 179, 0, 235))
    d.line([(fx0, fy + 2), (fx1, fy + 2)], fill=(255, 90, 0, 200))
    img = img.convert("RGB").resize((size, size), Image.LANCZOS)
    return img


FILES = [
    ("icon-192x192.png", 192, False),
    ("icon-512x512.png", 512, False),
    ("icon-maskable-512x512.png", 512, True),
    ("apple-touch-icon.png", 180, False),
]
for name, size, mask in FILES:
    p = os.path.join(OUT, name)
    draw_icon(size, maskable=mask).save(p, "PNG")
    print("wrote", p)
