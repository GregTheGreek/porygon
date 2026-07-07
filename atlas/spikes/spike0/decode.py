#!/usr/bin/env python3
"""Decode pokeemerald metatiles.bin + metatile_attributes.bin (Spike 0 verification)."""
import struct
import sys

LAYER = {0: "NORMAL(mid+top)", 1: "COVERED(bot+mid)", 2: "SPLIT(bot+top)", 3: "3?"}
# 8 tile slots per metatile = 2x2 bottom-of-pair, arranged as
# [bottom-layer NW,NE,SW,SE] then [top-of-pair layer NW,NE,SW,SE] in emerald 2-layer render.
SLOT = ["L0.NW", "L0.NE", "L0.SW", "L0.SE", "L1.NW", "L1.NE", "L1.SW", "L1.SE"]


def decode(bindir):
    with open(bindir + "/metatiles.bin", "rb") as f:
        mt = f.read()
    with open(bindir + "/metatile_attributes.bin", "rb") as f:
        attr = f.read()
    n = len(mt) // 16
    print("metatiles.bin=%d bytes -> %d metatiles" % (len(mt), n))
    print("metatile_attributes.bin=%d bytes\n" % len(attr))
    for m in range(n):
        a = struct.unpack_from("<H", attr, m * 2)[0]
        behavior = a & 0x00FF
        layer = (a >> 12) & 0xF
        print("metatile %d  attr=0x%04X  behavior=0x%02X  layerType=%d %s"
              % (m, a, behavior, layer, LAYER.get(layer, "?")))
        for t in range(8):
            v = struct.unpack_from("<H", mt, (m * 8 + t) * 2)[0]
            tid = v & 0x03FF
            hf = (v >> 10) & 1
            vf = (v >> 11) & 1
            pal = (v >> 12) & 0xF
            flags = ("H" if hf else "-") + ("V" if vf else "-")
            print("    %-5s raw=0x%04X tile=%4d pal=%2d flip=%s"
                  % (SLOT[t], v, tid, pal, flags))
        print()


if __name__ == "__main__":
    decode(sys.argv[1])
