#!/usr/bin/env python3
"""Generate demo artist avatar PNGs: genre gradient + artist initials.
Usage: gen_avatars.py manifest.json   (manifest: [{file, initials, genre}])
Used for seeded artist profile photos; artists without a photo get a
styled initial avatar rendered by the site instead.
"""
import json, sys
from PIL import Image, ImageDraw, ImageFont

BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

GENRE_COLORS = {
    "R&B":          ((88, 44, 140), (24, 10, 48)),
    "Southern Soul": ((196, 110, 30), (74, 34, 6)),
    "Hip-Hop":      ((16, 122, 110), (5, 40, 44)),
    "Trap":         ((178, 30, 60), (52, 6, 24)),
    "Country":      ((64, 120, 178), (16, 44, 74)),
    "Pop":          ((214, 64, 150), (84, 14, 66)),
}
FALLBACK = ((90, 90, 120), (20, 20, 30))

def gradient(size, top, bottom):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        t = y / size
        for x in range(0, size, 4):
            tt = min(1.0, max(0.0, t * 0.85 + (x / size) * 0.15))
            c = tuple(int(top[i] + (bottom[i] - top[i]) * tt) for i in range(3))
            for dx in range(4):
                if x + dx < size:
                    px[x + dx, y] = c
    return img

def main():
    with open(sys.argv[1]) as f:
        items = json.load(f)
    font = ImageFont.truetype(BOLD, 150)
    for it in items:
        top, bottom = GENRE_COLORS.get(it["genre"], FALLBACK)
        img = gradient(400, top, bottom)
        d = ImageDraw.Draw(img, "RGBA")
        d.ellipse([26, 26, 374, 374], outline=(255, 255, 255, 90), width=4)
        tw = d.textlength(it["initials"], font=font)
        d.text(((400 - tw) / 2, 112), it["initials"], font=font, fill=(255, 255, 255))
        img.save(it["file"])
    print(f"avatars: {len(items)} written")

if __name__ == "__main__":
    main()
