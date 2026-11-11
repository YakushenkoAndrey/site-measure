"""Generate app icons (PNG 180/192/512). Requires Pillow: python tools/make_icons.py"""
from pathlib import Path
from PIL import Image, ImageDraw

S = 1024
NAVY = (11, 37, 84)
WHITE = (255, 255, 255)
YELLOW = (255, 200, 0)
INK = (20, 20, 20)

img = Image.new("RGB", (S, S), NAVY)
d = ImageDraw.Draw(img)

# wall outline with a window opening
d.rectangle([150, 200, 874, 700], outline=WHITE, width=44)
d.rectangle([330, 330, 560, 560], outline=WHITE, width=30)

# tape measure: case + blade along the bottom
d.rounded_rectangle([110, 700, 400, 930], radius=50, fill=YELLOW)
d.ellipse([195, 755, 325, 885], fill=INK)
d.ellipse([235, 795, 285, 845], fill=YELLOW)
d.rectangle([380, 800, 900, 880], fill=YELLOW)
for i, x in enumerate(range(430, 900, 46)):
    h = 46 if i % 2 == 0 else 26
    d.rectangle([x, 800, x + 9, 800 + h], fill=INK)
d.rectangle([892, 780, 920, 890], fill=YELLOW)

out = Path(__file__).resolve().parent.parent / "icons"
out.mkdir(exist_ok=True)
for size in (180, 192, 512):
    img.resize((size, size), Image.LANCZOS).save(out / f"icon-{size}.png", optimize=True)
print("icons written to", out)
