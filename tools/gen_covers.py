#!/usr/bin/env python3
"""Generate demo cover PNGs: gradient + song title + artist name.
Usage: gen_covers.py manifest.json   (manifest: [{file,title,artist,genre}])
"""
import json, sys, textwrap
from PIL import Image, ImageDraw, ImageFont

BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

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
        # slight diagonal feel by mixing in x influence
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
    title_font = ImageFont.truetype(BOLD, 52)
    artist_font = ImageFont.truetype(REG, 34)
    tag_font = ImageFont.truetype(BOLD, 24)
    for it in items:
        top, bottom = GENRE_COLORS.get(it["genre"], FALLBACK)
        img = gradient(600, top, bottom)
        d = ImageDraw.Draw(img, "RGBA")
        # genre tag
        d.rectangle([28, 26, 28 + 8 + d.textlength(it["genre"].upper(), font=tag_font) + 8, 66],
                    fill=(0, 0, 0, 110))
        d.text((36, 32), it["genre"].upper(), font=tag_font, fill=(255, 205, 84))
        # bottom band
        d.rectangle([0, 392, 600, 600], fill=(0, 0, 0, 130))
        y = 412
        for line in textwrap.wrap(it["title"], width=16)[:3]:
            d.text((36, y), line, font=title_font, fill=(255, 255, 255))
            y += 60
        d.text((36, 556), it["artist"], font=artist_font, fill=(255, 205, 84))
        img.save(it["file"])
    print(f"covers: {len(items)} written")

if __name__ == "__main__":
    main()
