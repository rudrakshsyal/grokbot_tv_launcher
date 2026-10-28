#!/usr/bin/env python3
"""Generate icon.png (512x512): ambient gradient + frosted glass card + 2x2 tile glyph."""
from PIL import Image, ImageDraw, ImageFilter, ImageChops
import pathlib
S = 4; W = 512 * S
def radial(size, center, radius, color, alpha):
    layer = Image.new("RGBA", (size, size), color + (0,))
    m = Image.new("L", (size, size), 0); d = ImageDraw.Draw(m)
    cx, cy = center; d.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=alpha)
    layer.putalpha(m.filter(ImageFilter.GaussianBlur(radius * 0.45))); return layer
# background vertical gradient
bg = Image.new("RGBA", (W, W))
top, bot = (24, 28, 58), (6, 7, 14)
px = ImageDraw.Draw(bg)
for y in range(W):
    t = y / (W - 1); px.line([(0, y), (W, y)], fill=tuple(int(top[i] * (1 - t) + bot[i] * t) for i in range(3)) + (255,))
for c, r, col, a in [((int(W*.22), int(W*.18)), int(W*.55), (110, 80, 255), 200),
                     ((int(W*.85), int(W*.35)), int(W*.5), (20, 170, 210), 170),
                     ((int(W*.5), int(W*1.0)), int(W*.6), (210, 50, 150), 150)]:
    bg = Image.alpha_composite(bg, radial(W, c, r, col, a))
# glass card
x0, y0, x1, y1 = int(W*.17), int(W*.17), int(W*.83), int(W*.83); rad = int(W*.15)
mask = Image.new("L", (W, W), 0); ImageDraw.Draw(mask).rounded_rectangle((x0, y0, x1, y1), rad, fill=255)
blurred = bg.filter(ImageFilter.GaussianBlur(W * 0.04))
frost = Image.new("RGBA", (W, W), (255, 255, 255, 0))
fd = ImageDraw.Draw(frost)
for y in range(y0, y1):  # top-to-bottom white wash
    t = (y - y0) / (y1 - y0); fd.line([(x0, y), (x1, y)], fill=(255, 255, 255, int(70 * (1 - t) + 18 * t)))
card = Image.alpha_composite(blurred, frost); card.putalpha(mask)
# drop shadow
sh = Image.new("RGBA", (W, W), (0, 0, 0, 0)); ImageDraw.Draw(sh).rounded_rectangle((x0, y0 + W*.03, x1, y1 + W*.03), rad, fill=(0, 0, 0, 140))
bg = Image.alpha_composite(bg, sh.filter(ImageFilter.GaussianBlur(W * .03)))
bg = Image.alpha_composite(bg, card)
# specular edge (bright top-left, fading)
edge = Image.new("L", (W, W), 0); ed = ImageDraw.Draw(edge)
ed.rounded_rectangle((x0, y0, x1, y1), rad, outline=255, width=int(3.5 * S))
grad = Image.new("L", (W, W)); gd = ImageDraw.Draw(grad)
for i in range(W):
    gd.line([(i, 0), (0, i)], fill=int(255 * max(0.18, 1 - i / (W * 1.1))))
    gd.line([(W - 1, i), (i, W - 1)], fill=int(255 * max(0.18, 1 - i / (W * 1.1))))
edge = ImageChops.multiply(edge, grad.transpose(Image.FLIP_LEFT_RIGHT).transpose(Image.FLIP_LEFT_RIGHT))
spec = Image.new("RGBA", (W, W), (255, 255, 255, 0)); spec.putalpha(edge)
bg = Image.alpha_composite(bg, spec)
# 2x2 tile glyph
g = Image.new("RGBA", (W, W), (0, 0, 0, 0)); gdw = ImageDraw.Draw(g)
cs, gap = int(W*.15), int(W*.045); cx, cy = W // 2, W // 2
cells = [(cx - gap/2 - cs, cy - gap/2 - cs), (cx + gap/2, cy - gap/2 - cs), (cx - gap/2 - cs, cy + gap/2), (cx + gap/2, cy + gap/2)]
for k, (gx, gy) in enumerate(cells):
    gdw.rounded_rectangle((gx, gy, gx + cs, gy + cs), int(cs * .3), fill=(255, 255, 255, 250 if k == 0 else 150))
glow = g.filter(ImageFilter.GaussianBlur(W * .02)); bg = Image.alpha_composite(bg, glow); bg = Image.alpha_composite(bg, g)
out = pathlib.Path(__file__).resolve().parent.parent / "icon.png"
bg.convert("RGB").resize((512, 512), Image.LANCZOS).save(out, optimize=True)
print("wrote", out)
