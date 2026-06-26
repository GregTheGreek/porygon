"""Generate a small, self-contained "porygon basics" tileset for legible lowfi map renders.

The emerald tilesets have per-tileset feature gaps (e.g. the General+Petalburg pair that
owns building stamps has no bridge tiles), which forces ugly fallbacks. For recreating an
arbitrary image as a *recognisable* map, it's easier to own a tiny, deliberately simple
tileset whose tiles are unmistakable: grass, water (+ rocky shoreline), bridge, forest,
tall-grass, sand/path, rock, flower, sign, ledge, cliff, building.

This module DRAWS each 16x16 metatile programmatically, then emits a real tileset dir the
existing render pipeline already consumes (``core.tileset.load_tiles``/``load_palettes``/
``decode_metatiles``): ``tiles.png`` (indexed), ``palettes/00.pal`` (JASC), ``metatiles.bin``,
``metatile_attributes.bin``. Collision/elevation for compose come from ``basics_palette()``
(written into each Block), not the attributes file - so attributes stay NORMAL for Phase 1.

Metatile ids are the order of ``_VOCAB`` below; ``basics_palette()`` exposes name -> id +
collision + edges so ``compose_map`` can target ``gTileset_PorygonBasics`` exactly like a
real pair.
"""

from __future__ import annotations

import struct
from pathlib import Path

BASICS_PRIMARY = "gTileset_PorygonBasics"
BASICS_FOLDER = "porygon_basics"

# 16-colour palette; index 0 is transparent (never used for opaque pixels).
PALETTE = [
    (255, 0, 255),    # 0 transparent
    (104, 168, 88),   # 1 grass
    (132, 196, 108),  # 2 grass light
    (64, 120, 200),   # 3 water
    (120, 180, 236),  # 4 water light (wave)
    (150, 108, 70),   # 5 bank / cliff brown
    (40, 104, 48),    # 6 tree dark
    (76, 150, 76),    # 7 tree light
    (220, 200, 150),  # 8 sand / path
    (184, 134, 76),   # 9 wood (bridge)
    (120, 82, 44),    # 10 wood dark (plank line)
    (160, 160, 168),  # 11 rock
    (96, 96, 104),    # 12 rock dark
    (28, 78, 40),     # 13 tall-grass dark
    (228, 112, 148),  # 14 flower / berry
    (74, 66, 58),     # 15 sign / roof / detail
]

# colour-index aliases
_T, GR, GR2, WA, WA2, BK, TR, TR2, SA, WD, WD2, RK, RK2, TG, FL, DK = range(16)

CELL = 16


def _np():
    import numpy as np
    return np


# --- per-metatile drawing (returns a 16x16 array of palette indices) ----

def _grid(fill):
    np = _np()
    return np.full((CELL, CELL), fill, dtype=np.uint8)


def _speckle(a, idx, step=5, off=0):
    """Sparse deterministic dots for texture (no RNG, resume-safe)."""
    for y in range(CELL):
        for x in range(CELL):
            if (x * 3 + y * 7 + off) % step == 0:
                a[y, x] = idx
    return a


def _grass():
    return _speckle(_grid(GR), GR2)


def _tall_grass():
    a = _speckle(_grid(GR), GR2, step=7)
    # little V blades
    for cx, cy in [(3, 11), (8, 6), (12, 12), (6, 13)]:
        for k in range(3):
            if cy - k >= 0:
                a[cy - k, cx - k] = TG
                a[cy - k, cx + k] = TG
    return a


def _water():
    a = _grid(WA)
    for y in range(2, CELL, 5):          # gentle wave lines
        for x in range(CELL):
            if (x + y) % 4 < 2:
                a[y, x] = WA2
    return a


def _water_edge(n=False, e=False, s=False, w=False):
    a = _water()
    b = 4  # bank thickness in px
    if n:
        a[:b, :] = BK
    if s:
        a[-b:, :] = BK
    if w:
        a[:, :b] = BK
    if e:
        a[:, -b:] = BK
    return a


def _tree():
    a = _grid(TR)
    # canopy bumps that tile seamlessly + a dark gutter at right/bottom for separation
    for y in range(CELL):
        for x in range(CELL):
            if (x * 2 + y) % 5 == 0:
                a[y, x] = TR2
    a[:, -1] = DK
    a[-1, :] = DK
    return a


def _sand():
    return _speckle(_grid(SA), DK, step=11)


def _path():
    return _speckle(_grid(SA), WD2, step=13)


def _bridge_h():
    a = _grid(WD)
    for x in range(0, CELL, 4):           # vertical plank seams
        a[:, x] = WD2
    a[0, :] = WD2                          # rails
    a[-1, :] = WD2
    return a


def _bridge_v():
    a = _grid(WD)
    for y in range(0, CELL, 4):
        a[y, :] = WD2
    a[:, 0] = WD2
    a[:, -1] = WD2
    return a


def _rock():
    a = _grid(WA2)                         # rock sits in water by default (source use)
    np = _np()
    yy, xx = np.ogrid[:CELL, :CELL]
    mask = (xx - 8) ** 2 + (yy - 9) ** 2 <= 36
    a[mask] = RK
    a[(xx - 8) ** 2 + (yy - 10) ** 2 <= 16] = RK2
    a[(xx - 6) ** 2 + (yy - 7) ** 2 <= 4] = RK  # highlight-ish
    return a


def _flower():
    a = _grass()
    for cx, cy in [(4, 4), (11, 6), (7, 12), (13, 12)]:
        a[cy, cx] = FL
        a[cy - 1, cx] = FL
        a[cy + 1, cx] = FL
        a[cy, cx - 1] = FL
        a[cy, cx + 1] = FL
    return a


def _sign():
    a = _grass()
    a[2:8, 6:11] = WD                       # board
    a[2:8, 6:11][::2] = WD2
    a[8:14, 7:9] = WD2                      # post
    return a


def _ledge():
    a = _grass()
    a[-3:, :] = DK                          # drop shadow at the bottom = one-way cue
    a[-4, :] = GR2
    return a


def _cliff():
    a = _grid(RK)
    for y in range(CELL):
        for x in range(CELL):
            if (x + y * 2) % 6 == 0:
                a[y, x] = RK2
    a[:3, :] = BK                           # lit top edge
    return a


def _building():
    a = _grid(RK)                           # walls
    a[:5, :] = DK                           # roof
    a[5, :] = BK
    a[10:, 6:10] = DK                       # door
    a[8, 3:6] = WA2                         # window
    a[8, 10:13] = WA2
    return a


# --- vocabulary: ordered; metatile id == index --------------------------
# Each entry: (name, draw_fn, collision, {extra: edges/elevation})
_VOCAB = [
    ("grass", _grass, 0, {}),
    ("grass_light", lambda: _speckle(_grid(GR2), GR), 0, {}),
    ("tall_grass", _tall_grass, 0, {}),
    ("sand", _sand, 0, {}),
    ("path", _path, 0, {}),
    ("flower", _flower, 0, {}),
    ("bridge_h", _bridge_h, 0, {}),
    ("bridge_v", _bridge_v, 0, {}),
    ("sign", _sign, 1, {}),
    ("ledge", _ledge, 0, {}),
    ("rock", _rock, 1, {}),
    ("building", _building, 1, {}),
    ("tree", _tree, 1, {}),
    ("cliff", _cliff, 1, {}),
    # water fill + 8 shoreline variants (rocky bank), consumed via `edges`
    ("water", _water, 1, {}),
    ("water_n", lambda: _water_edge(n=True), 1, {}),
    ("water_s", lambda: _water_edge(s=True), 1, {}),
    ("water_w", lambda: _water_edge(w=True), 1, {}),
    ("water_e", lambda: _water_edge(e=True), 1, {}),
    ("water_nw", lambda: _water_edge(n=True, w=True), 1, {}),
    ("water_ne", lambda: _water_edge(n=True, e=True), 1, {}),
    ("water_sw", lambda: _water_edge(s=True, w=True), 1, {}),
    ("water_se", lambda: _water_edge(s=True, e=True), 1, {}),
]

_ID = {name: i for i, (name, *_2) in enumerate(_VOCAB)}


def basics_palette() -> dict:
    """Terrain palette for the basics tileset (name -> metatile id + collision + edges).

    Same shape as a ``data/terrain.json`` pair entry, so ``compose_map`` treats
    ``gTileset_PorygonBasics`` exactly like a real tileset pair.
    """
    pal: dict = {}
    for name, _fn, coll, extra in _VOCAB:
        entry = {"metatile_id": _ID[name], "collision": coll, "elevation": 3}
        entry.update(extra)
        pal[name] = entry
    # water autotiles its rocky shoreline via the standard edge keys
    pal["water"]["edges"] = {
        "fill": _ID["water"],
        "N": _ID["water_n"], "S": _ID["water_s"], "W": _ID["water_w"], "E": _ID["water_e"],
        "NW": _ID["water_nw"], "NE": _ID["water_ne"], "SW": _ID["water_sw"], "SE": _ID["water_se"],
    }
    return pal


# --- tileset emission ---------------------------------------------------

def _slice_tiles(meta):
    """A 16x16 index array -> four 8x8 tiles in (TL, TR, BL, BR) order."""
    return [meta[0:8, 0:8], meta[0:8, 8:16], meta[8:16, 0:8], meta[8:16, 8:16]]


def generate_basics_tileset(project, force: bool = False) -> dict:
    """Write the basics tileset into the project as a primary tileset. Returns its info."""
    np = _np()
    from PIL import Image

    out_dir = project.root / "data" / "tilesets" / "primary" / BASICS_FOLDER
    if out_dir.exists() and not force and (out_dir / "metatiles.bin").exists():
        return {"folder": BASICS_FOLDER, "label": BASICS_PRIMARY, "metatiles": len(_VOCAB),
                "path": str(out_dir), "regenerated": False}
    (out_dir / "palettes").mkdir(parents=True, exist_ok=True)

    # tile 0 is the transparent/blank tile (convention); content tiles dedupe after it.
    blank = np.zeros((8, 8), dtype=np.uint8)
    tiles: list = [blank]
    tile_index: dict[bytes, int] = {blank.tobytes(): 0}
    meta_entries: list[list[int]] = []

    for _name, fn, _coll, _extra in _VOCAB:
        meta = np.asarray(fn(), dtype=np.uint8)
        entries = []
        for t in _slice_tiles(meta):
            key = t.tobytes()
            idx = tile_index.get(key)
            if idx is None:
                idx = len(tiles)
                tiles.append(t)
                tile_index[key] = idx
            entries.append(idx)               # bottom layer (TL,TR,BL,BR)
        entries += [0, 0, 0, 0]               # transparent top layer
        meta_entries.append(entries)

    # tiles.png: 16 tiles/row, indexed mode 'P'
    cols = 16
    rows = (len(tiles) + cols - 1) // cols
    sheet = np.zeros((rows * 8, cols * 8), dtype=np.uint8)
    for i, t in enumerate(tiles):
        r, c = divmod(i, cols)
        sheet[r * 8:r * 8 + 8, c * 8:c * 8 + 8] = t
    img = Image.fromarray(sheet, mode="P")
    flat = []
    for rgb in PALETTE:
        flat += list(rgb)
    flat += [0, 0, 0] * (256 - len(PALETTE))
    img.putpalette(flat)
    img.save(out_dir / "tiles.png")

    # palettes/00.pal (JASC)
    lines = ["JASC-PAL", "0100", "16"] + [f"{r} {g} {b}" for r, g, b in PALETTE]
    (out_dir / "palettes" / "00.pal").write_text("\n".join(lines) + "\n")

    # metatiles.bin (8 u16 per metatile) + metatile_attributes.bin (NORMAL=0)
    mt = bytearray()
    for entries in meta_entries:
        for e in entries:
            mt += struct.pack("<H", e)
    (out_dir / "metatiles.bin").write_bytes(bytes(mt))
    (out_dir / "metatile_attributes.bin").write_bytes(b"\x00\x00" * len(meta_entries))

    return {"folder": BASICS_FOLDER, "label": BASICS_PRIMARY, "metatiles": len(_VOCAB),
            "tiles": len(tiles), "path": str(out_dir), "regenerated": True}
