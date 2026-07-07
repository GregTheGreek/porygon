#!/usr/bin/env python3
"""Minimal stdlib RGBA PNG encoder + tree layer generator for Spike 0.

No third-party deps (Pillow unavailable). Emits 8-bit RGBA non-interlaced PNGs.
"""
import zlib
import struct
import sys
import os


def write_rgba_png(path, width, height, pixels):
    """pixels: list of (r,g,b,a) length width*height, row-major top-to-bottom."""
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))

    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0 (None) per scanline
        for x in range(width):
            r, g, b, a = pixels[y * width + x]
            raw += bytes((r, g, b, a))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8-bit, color type 6 (RGBA)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", ihdr)
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


# ---- colors (RGBA) ----
T        = (0, 0, 0, 0)          # transparent
LEAF_TOP = (72, 160, 88, 255)    # above-player canopy leaves (top layer)
LEAF_HI  = (120, 200, 120, 255)  # canopy highlight
LEAF_BACK= (40, 96, 56, 255)     # below-player canopy backing (middle layer)
TRUNK    = (120, 80, 44, 255)    # trunk
TRUNK_DK = (80, 52, 28, 255)     # trunk shading

W, H = 32, 48  # 2 metatiles wide x 3 tall


def blank():
    return [T] * (W * H)


def in_canopy(x, y):
    # rounded blob over the top 32x32, trim the 4 corners
    if y >= 32:
        return False
    cx, cy = 16, 16
    # simple diamond-ish mask, trim corners
    if (x < 3 and y < 3) or (x > 28 and y < 3):
        return False
    if (x < 3 and y > 28) or (x > 28 and y > 28):
        return False
    return True


def trunk_cols(x):
    return 12 <= x < 20  # 8px-wide trunk centered


def gen_top():
    px = blank()
    for y in range(H):
        for x in range(W):
            if in_canopy(x, y):
                # a little highlight band near the top
                px[y * W + x] = LEAF_HI if (y < 10 and 10 <= x < 22) else LEAF_TOP
    return px


def gen_middle():
    px = blank()
    for y in range(H):
        for x in range(W):
            if in_canopy(x, y):
                px[y * W + x] = LEAF_BACK          # below-player backing for canopy
            elif y >= 32 and trunk_cols(x):
                px[y * W + x] = TRUNK              # trunk (below player)
    return px


def gen_bottom():
    px = blank()
    for y in range(H):
        for x in range(W):
            if y >= 32 and trunk_cols(x):
                px[y * W + x] = TRUNK_DK           # trunk base (below player)
    return px


if __name__ == "__main__":
    outdir = sys.argv[1]
    os.makedirs(outdir, exist_ok=True)
    write_rgba_png(os.path.join(outdir, "top.png"), W, H, gen_top())
    write_rgba_png(os.path.join(outdir, "middle.png"), W, H, gen_middle())
    write_rgba_png(os.path.join(outdir, "bottom.png"), W, H, gen_bottom())
    print("wrote top/middle/bottom.png (%dx%d) to %s" % (W, H, outdir))
