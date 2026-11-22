#!/usr/bin/env python3
"""Label a screenshot with StarCraft II style callouts: a thin green elbow line
from the target to a short label.

usage: annotate.py SRC OUT [--width W] MARK...
MARK is  TEXT@TX,TY@LX,LY  in SRC pixel coordinates: the line starts at the
target (TX,TY), goes sideways a little, up or down to LY, then sideways to the
label at (LX,LY). The label is on the side of LX. The output is resized to
--width (if given) and saved as WebP.
"""
import argparse
import os
from PIL import Image, ImageDraw, ImageFont

GREEN = (88, 226, 104, 255)
TEXT = (236, 242, 236, 255)
PLATE = (10, 20, 12, 222)
SHADOW = (0, 0, 0, 120)
FONT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Michroma-Regular.ttf")
SS = 3  # supersampling


def parse(mark):
    text, t, l = mark.rsplit("@", 2)
    return text, tuple(map(float, t.split(","))), tuple(map(float, l.split(",")))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("src")
    p.add_argument("out")
    p.add_argument("--width", type=int)
    p.add_argument("marks", nargs="*")
    a = p.parse_intermixed_args()

    base = Image.open(a.src).convert("RGBA")
    k = a.width / base.width if a.width else 1
    out_size = (round(base.width * k), round(base.height * k))
    base = base.resize(out_size, Image.LANCZOS)

    unit = min(out_size) / 540 * SS
    line = max(SS, round(2.6 * unit))
    tick = round(16 * unit)
    font = ImageFont.truetype(FONT, round(17 * unit))
    pad_x, pad_y = round(9 * unit), round(7 * unit)

    layer = Image.new("RGBA", (out_size[0] * SS, out_size[1] * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    s = k * SS
    for mark in a.marks:
        text, (tx, ty), (lx, ly) = parse(mark)
        tx, ty, lx, ly = tx * s, ty * s, lx * s, ly * s
        side = 1 if lx >= tx else -1
        knee = tx + side * tick
        pts = [(tx, ty), (knee, ty), (knee, ly), (lx, ly)]
        if abs(ly - ty) < 1:
            pts = [(tx, ty), (lx, ly)]

        x0, y0, x1, y1 = d.textbbox((0, 0), text, font=font, anchor="lm")
        w, h = x1 - x0, y1 - y0
        px = lx if side > 0 else lx - w - 2 * pad_x
        plate = (px, ly - h / 2 - pad_y, px + w + 2 * pad_x, ly + h / 2 + pad_y)

        off = round(1.5 * unit)
        d.line([(x + off, y + off) for x, y in pts], fill=SHADOW, width=line, joint="curve")
        d.rounded_rectangle(tuple(v + off for v in plate), radius=round(4 * unit), fill=SHADOW)
        d.line(pts, fill=GREEN, width=line, joint="curve")
        r = line * 1.6
        d.ellipse((tx - r, ty - r, tx + r, ty + r), fill=GREEN)
        d.rounded_rectangle(plate, radius=round(4 * unit), fill=PLATE, outline=GREEN, width=max(SS, line // 2))
        d.text((plate[0] + pad_x, ly), text, font=font, fill=TEXT, anchor="lm")

    layer = layer.resize(out_size, Image.LANCZOS)
    Image.alpha_composite(base, layer).convert("RGB").save(a.out, "WEBP", quality=88, method=6)


if __name__ == "__main__":
    main()
