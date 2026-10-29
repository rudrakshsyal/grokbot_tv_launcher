# Phone remote app icon (relay/icons/icon-{180,192,512}.png): dark glass background, soft blue-violet orb inside a
# thin D-pad ring. iOS rounds the corners itself, so the image is a full square.  python3 tools/make-remote-icon.py
import os
from PIL import Image, ImageDraw, ImageFilter
S = 1024
out = os.path.join(os.path.dirname(__file__), '..', 'relay', 'icons')
bg = Image.new('RGB', (S, S), (7, 8, 13))
# subtle vertical sheen
sheen = Image.new('L', (1, S)); sheen.putdata([int(28 * (1 - y / S) ** 2) for y in range(S)])
bg = Image.composite(Image.new('RGB', (S, S), (40, 46, 78)), bg, sheen.resize((S, S)))
c = S // 2
glow = Image.new('L', (S, S), 0); ImageDraw.Draw(glow).ellipse([c - 300, c - 300, c + 300, c + 300], fill=150)
bg = Image.composite(Image.new('RGB', (S, S), (92, 104, 255)), bg, glow.filter(ImageFilter.GaussianBlur(120)))
# D-pad ring (thin, translucent white)
ring = Image.new('L', (S, S), 0); d = ImageDraw.Draw(ring)
d.ellipse([c - 330, c - 330, c + 330, c + 330], outline=90, width=14)
for a in [(c, c - 268), (c, c + 268), (c - 268, c), (c + 268, c)]:
    d.ellipse([a[0] - 14, a[1] - 14, a[0] + 14, a[1] + 14], fill=120)
bg = Image.composite(Image.new('RGB', (S, S), (235, 238, 255)), bg, ring.filter(ImageFilter.GaussianBlur(1.2)))
# orb: radial gradient, highlight top-left
R = 190
orb = Image.new('RGB', (2 * R, 2 * R)); px = orb.load()
for y in range(2 * R):
    for x in range(2 * R):
        dx, dy = (x - R * 0.7) / (2 * R), (y - R * 0.6) / (2 * R)
        t = min(1, (dx * dx + dy * dy) ** 0.5 * 1.6)
        a, b = (178, 196, 255), (70, 62, 210)
        px[x, y] = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))
m = Image.new('L', (2 * R, 2 * R), 0); ImageDraw.Draw(m).ellipse([0, 0, 2 * R - 1, 2 * R - 1], fill=255)
bg.paste(orb, (c - R, c - R), m.filter(ImageFilter.GaussianBlur(1)))
hl = Image.new('L', (S, S), 0); ImageDraw.Draw(hl).ellipse([c - 120, c - 160, c + 20, c - 80], fill=110)
bg = Image.composite(Image.new('RGB', (S, S), (255, 255, 255)), bg, hl.filter(ImageFilter.GaussianBlur(28)))
for n in (180, 192, 512):
    bg.resize((n, n), Image.LANCZOS).save(os.path.join(out, 'icon-%d.png' % n), optimize=True)
print('icons ->', os.path.abspath(out))
