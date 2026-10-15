"""Draws the app icon (a three-track timeline with a red playhead cutting through it) and writes every size Android needs
into resources/android/. Run: python3 resources/make-icons.py   (needs Pillow). The PNGs are committed, so you only run this if you change the design."""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'android')
BG = (14, 17, 21, 255)          # #0e1115, same as the app background
RED = (255, 93, 82, 255)        # playhead
TRACKS = [((91, 156, 255, 255), 40, [(29, 56), (64, 80)]),   # blue
          ((255, 111, 168, 255), 54, [(40, 56), (64, 76)]),  # pink
          ((67, 201, 139, 255), 68, [(33, 56), (64, 74)])]   # green
SS = 4  # supersampling for clean edges

def motif(d, s, scale=1.0):
    """Draw the timeline on ImageDraw d. Coordinates are on a 108-unit canvas, s = pixels per unit, scale grows it around the centre."""
    c = 54
    f = lambda v: (c + (v - c) * scale) * s
    for col, y, segs in TRACKS:
        for x0, x1 in segs:
            d.rounded_rectangle([f(x0), f(y - 4.5), f(x1), f(y + 4.5)], radius=3 * scale * s, fill=col)
    d.rounded_rectangle([f(58.25), f(26), f(61.75), f(82)], radius=1.75 * scale * s, fill=RED)
    d.rounded_rectangle([f(54.5), f(24), f(65.5), f(32)], radius=2.5 * scale * s, fill=RED)

def foreground(px):
    im = Image.new('RGBA', (px * SS, px * SS), (0, 0, 0, 0))
    motif(ImageDraw.Draw(im), px * SS / 108)
    return im.resize((px, px), Image.LANCZOS)

def legacy(px, round_):
    big = px * SS
    im = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if round_: d.ellipse([0, 0, big - 1, big - 1], fill=BG)
    else: d.rounded_rectangle([0, 0, big - 1, big - 1], radius=big * 0.2, fill=BG)
    motif(d, big / 108, scale=1.3)
    return im.resize((px, px), Image.LANCZOS)

FG = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}
LG = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
for dens in FG:
    folder = os.path.join(OUT, 'mipmap-' + dens)
    os.makedirs(folder, exist_ok=True)
    foreground(FG[dens]).save(os.path.join(folder, 'ic_launcher_foreground.png'))
    legacy(LG[dens], False).save(os.path.join(folder, 'ic_launcher.png'))
    legacy(LG[dens], True).save(os.path.join(folder, 'ic_launcher_round.png'))

vals = os.path.join(OUT, 'values')
os.makedirs(vals, exist_ok=True)
with open(os.path.join(vals, 'ic_launcher_background.xml'), 'w') as fh:
    fh.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0E1115</color>\n</resources>\n')

# Play Store style 512 preview (not needed for sideloading, handy for a WhatsApp/website logo)
big = Image.new('RGBA', (512 * SS, 512 * SS), BG)
motif(ImageDraw.Draw(big), 512 * SS / 108, scale=1.0)
big.resize((512, 512), Image.LANCZOS).convert('RGB').save(os.path.join(os.path.dirname(OUT), 'icon-512.png'))
print('icons written')
