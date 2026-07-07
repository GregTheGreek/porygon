#!/usr/bin/env python3
"""Emit deliberately-broken Porytiles layer PNGs for Spike 0 error-surface capture."""
import sys, os
from mkpng import write_rgba_png, T

case = sys.argv[1]
outdir = sys.argv[2]
os.makedirs(outdir, exist_ok=True)


def solid(w, h, fn):
    return [fn(x, y) for y in range(h) for x in range(w)]


if case == "toomanycolors":
    # 16x16, one metatile. NW 8x8 tile gets 17 distinct opaque colors.
    W, H = 16, 16
    pal = [(10 * i + 5, 20 * i % 250 + 3, (30 * i + 7) % 250, 255) for i in range(17)]
    def top(x, y):
        if x < 8 and y < 8:
            return pal[(y * 8 + x) % 17]  # cycles through 17 colors in 64 px
        return T
    write_rgba_png(outdir + "/top.png", W, H, solid(W, H, top))
    write_rgba_png(outdir + "/middle.png", W, H, solid(W, H, lambda x, y: T))
    write_rgba_png(outdir + "/bottom.png", W, H, solid(W, H, lambda x, y: T))

elif case == "palbudget":
    # 8 metatiles in a row (128x16). Each metatile's tiles use a disjoint 15-color set,
    # forcing 8 distinct palettes > 7 secondary budget.
    W, H = 128, 16
    def mk(x, y):
        m = x // 16               # metatile index 0..7
        local = (y % 15)          # 15 distinct colors per metatile column band
        base = m * 15 + 1
        c = base + local
        return ((c * 7) % 250 + 3, (c * 13) % 250 + 2, (c * 29) % 250 + 1, 255)
    write_rgba_png(outdir + "/top.png", W, H, solid(W, H, lambda x, y: T))
    write_rgba_png(outdir + "/middle.png", W, H, solid(W, H, mk))
    write_rgba_png(outdir + "/bottom.png", W, H, solid(W, H, lambda x, y: T))

elif case == "baddims":
    # 30x48: width not a multiple of 16.
    W, H = 30, 48
    g = (60, 120, 80, 255)
    write_rgba_png(outdir + "/top.png", W, H, solid(W, H, lambda x, y: T))
    write_rgba_png(outdir + "/middle.png", W, H, solid(W, H, lambda x, y: g))
    write_rgba_png(outdir + "/bottom.png", W, H, solid(W, H, lambda x, y: T))

elif case == "triple":
    # 16x16 single metatile with pixels on ALL THREE layers -> 3 depth planes.
    W, H = 16, 16
    a = (200, 60, 60, 255)
    b = (60, 200, 60, 255)
    c = (60, 60, 200, 255)
    write_rgba_png(outdir + "/bottom.png", W, H, solid(W, H, lambda x, y: a))
    write_rgba_png(outdir + "/middle.png", W, H, solid(W, H, lambda x, y: b))
    write_rgba_png(outdir + "/top.png", W, H, solid(W, H, lambda x, y: c))

else:
    print("unknown case", case); sys.exit(2)

print("emitted", case, "to", outdir)
