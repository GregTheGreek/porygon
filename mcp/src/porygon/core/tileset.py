"""Render existing pokeemerald metatiles to images, and match image cells to them.

This is the half of "recreate a map from an image using EXISTING assets" that
``image_to_map`` (Phase 3) never needed: ``image_to_map`` *generates* a new tileset,
whereas here we *reuse* an in-project tileset, so we must turn its metatiles back into
16x16 RGBA images and find the visually-closest one for each source cell.

Tileset on-disk format (data/tilesets/{primary,secondary}/<folder>/):
  - tiles.png        4bpp paletted PNG, 8x8 tiles, 16 per row (kept in mode 'P' so the
                     raw 0..15 colour indices survive - the .pal files are the source of
                     truth, not the PNG's embedded palette).
  - metatiles.bin    NUM_TILES_PER_METATILE consecutive u16 tile-entries per metatile.
  - palettes/NN.pal  JASC-PAL, 16 RGB triples; files are GLOBALLY numbered (primary owns
                     slots 0..NUM_PALS_IN_PRIMARY-1, secondary owns the rest).

GBA metatile tile-entry (u16):
  bits 0-9   (0x03FF)  tile index   bit 10 (0x0400) hflip
  bit  11    (0x0800)  vflip         bits 12-15 (0xF000) palette number
Tiles are 4 per 2x2 layer; layers composite bottom->top; palette index 0 = transparent.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


class TilesetError(Exception):
    pass


def _pil():
    try:
        from PIL import Image
        return Image
    except ImportError as e:  # pragma: no cover
        raise TilesetError("Pillow not installed - run `uv sync --extra imaging`") from e


def _np():
    try:
        import numpy as np
        return np
    except ImportError as e:  # pragma: no cover
        raise TilesetError("numpy not installed - run `uv sync --extra imaging`") from e


CELL = 16          # metatile size in px
TILE = 8           # 8x8 tile
TILE_ENTRY_INDEX = 0x03FF
TILE_ENTRY_HFLIP = 0x0400
TILE_ENTRY_VFLIP = 0x0800
TILE_ENTRY_PAL = 0xF000
TILE_ENTRY_PAL_SHIFT = 12


def label_to_folder(label: str) -> str:
    """gTileset_PetalburgGym -> petalburg_gym (matches Porymap's folder convention)."""
    camel = label[len("gTileset_"):] if label.startswith("gTileset_") else label
    return re.sub(r"(?<!^)(?=[A-Z])", "_", camel).lower()


# --- loaders ------------------------------------------------------------

def load_palettes(tileset_path) -> dict[int, list[tuple[int, int, int]]]:
    """Parse palettes/NN.pal into {global_slot -> [16 RGB triples]}."""
    pal_dir = Path(tileset_path) / "palettes"
    out: dict[int, list[tuple[int, int, int]]] = {}
    if not pal_dir.is_dir():
        return out
    for pal in sorted(pal_dir.glob("*.pal")):
        try:
            slot = int(pal.stem)
        except ValueError:
            continue
        lines = pal.read_text().splitlines()
        # JASC header: "JASC-PAL", "0100", "<count>", then count "R G B" lines.
        colors: list[tuple[int, int, int]] = []
        for line in lines[3:]:
            parts = line.split()
            if len(parts) >= 3:
                colors.append((int(parts[0]), int(parts[1]), int(parts[2])))
        if colors:
            out[slot] = colors
    return out


def load_tiles(tileset_path):
    """Open tiles.png in mode 'P' (preserve raw colour indices)."""
    Image = _pil()
    path = Path(tileset_path) / "tiles.png"
    if not path.exists():
        raise TilesetError(f"no tiles.png in {tileset_path}")
    img = Image.open(path)
    # Keep paletted indices; convert only away from RGB/L if PIL opened it oddly.
    if img.mode != "P":
        img = img.convert("P")
    return img


def decode_metatiles(tileset_path, tiles_per_metatile: int) -> list[list[int]]:
    """Read metatiles.bin into a list of metatiles, each a list of u16 tile-entries."""
    raw = (Path(tileset_path) / "metatiles.bin").read_bytes()
    stride = tiles_per_metatile * 2
    if len(raw) % stride:
        raise TilesetError(
            f"metatiles.bin size {len(raw)} not a multiple of {stride} "
            f"({tiles_per_metatile} tiles/metatile)"
        )
    metatiles = []
    for base in range(0, len(raw), stride):
        entries = [
            int.from_bytes(raw[base + i: base + i + 2], "little")
            for i in range(0, stride, 2)
        ]
        metatiles.append(entries)
    return metatiles


# --- rendering ----------------------------------------------------------

def _apply_palette(tile_p, palette):
    """8x8 mode-'P' tile + 16-colour palette -> 8x8 RGBA (index 0 transparent)."""
    np = _np()
    Image = _pil()
    idx = np.asarray(tile_p, dtype=np.uint8)
    lut = np.array(palette, dtype=np.uint8)
    if len(lut) < 16:  # pad short palettes so clipping can't IndexError
        lut = np.vstack([lut, np.zeros((16 - len(lut), 3), dtype=np.uint8)])
    safe = np.clip(idx, 0, len(lut) - 1)
    rgb = lut[safe]
    alpha = np.where(idx == 0, 0, 255).astype(np.uint8)
    rgba = np.dstack([rgb, alpha])
    return Image.fromarray(rgba, "RGBA")


def is_blank_metatile(entries) -> bool:
    """True if every tile-entry is index 0 + palette 0 (fully transparent metatile)."""
    return all((e & TILE_ENTRY_INDEX) == 0 and (e & TILE_ENTRY_PAL) == 0 for e in entries)


def render_metatile(entries, tiles_per_metatile, tiles_primary, pals_primary,
                    num_tiles_in_primary, num_pals_in_primary,
                    tiles_secondary=None, pals_secondary=None):
    """Composite one metatile's tile-entries into a 16x16 RGBA image."""
    Image = _pil()
    out = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    n_layers = tiles_per_metatile // 4
    for layer in range(n_layers):
        for sub in range(4):
            entry = entries[layer * 4 + sub]
            ti = entry & TILE_ENTRY_INDEX
            hflip = bool(entry & TILE_ENTRY_HFLIP)
            vflip = bool(entry & TILE_ENTRY_VFLIP)
            pal_num = (entry & TILE_ENTRY_PAL) >> TILE_ENTRY_PAL_SHIFT

            if ti < num_tiles_in_primary or tiles_secondary is None:
                src, idx = tiles_primary, ti
            else:
                src, idx = tiles_secondary, ti - num_tiles_in_primary
            cols = max(src.width // TILE, 1)
            tx, ty = (idx % cols) * TILE, (idx // cols) * TILE
            if ty + TILE > src.height:  # tile index past the sheet -> leave transparent
                continue
            tile = src.crop((tx, ty, tx + TILE, ty + TILE))
            if hflip:
                tile = tile.transpose(Image.FLIP_LEFT_RIGHT)
            if vflip:
                tile = tile.transpose(Image.FLIP_TOP_BOTTOM)

            pals = pals_primary if (pal_num < num_pals_in_primary or not pals_secondary) else pals_secondary
            palette = pals.get(pal_num) or pals_primary.get(0) or [(0, 0, 0)] * 16
            rgba = _apply_palette(tile, palette)
            out.alpha_composite(rgba, (sub % 2 * TILE, sub // 2 * TILE))
    return out


# --- perceptual feature + matching --------------------------------------

def _srgb_to_lab(rgb):
    """(...,3) sRGB in 0..1 -> CIE-Lab (D65). Vectorised numpy."""
    np = _np()
    rgb = np.asarray(rgb, dtype=np.float64)
    lin = np.where(rgb > 0.04045, ((rgb + 0.055) / 1.055) ** 2.4, rgb / 12.92)
    m = np.array([
        [0.4124, 0.3576, 0.1805],
        [0.2126, 0.7152, 0.0722],
        [0.0193, 0.1192, 0.9505],
    ])
    xyz = lin @ m.T
    white = np.array([0.95047, 1.0, 1.08883])
    xyz = xyz / white
    eps = 216 / 24389
    kappa = 24389 / 27
    f = np.where(xyz > eps, np.cbrt(xyz), (kappa * xyz + 16) / 116)
    L = 116 * f[..., 1] - 16
    a = 500 * (f[..., 0] - f[..., 1])
    b = 200 * (f[..., 1] - f[..., 2])
    return np.stack([L, a, b], axis=-1)


def feature_vector(img_rgba):
    """16x16 RGBA -> 48-d Lab feature (4x4 area-average over a neutral-gray backing)."""
    np = _np()
    Image = _pil()
    if img_rgba.size != (CELL, CELL):
        img_rgba = img_rgba.convert("RGBA").resize((CELL, CELL))
    bg = Image.new("RGBA", img_rgba.size, (128, 128, 128, 255))
    flat = Image.alpha_composite(bg, img_rgba.convert("RGBA")).convert("RGB")
    small = flat.resize((4, 4), Image.BOX)
    arr = np.asarray(small, dtype=np.float64) / 255.0
    lab = _srgb_to_lab(arr.reshape(-1, 3))
    return lab.reshape(-1)


@dataclass
class MetatileAtlas:
    """Rendered metatiles of a tileset (or primary+secondary pair) + match features."""

    ids: list[int]                       # global metatile id per candidate
    images: list                         # 16x16 RGBA, parallel to ids
    features: object = None              # (M, 48) numpy array, parallel to ids
    flagged_animated: list[int] = field(default_factory=list)
    _by_id: dict = field(default_factory=dict)

    def __post_init__(self):
        self._by_id = {mid: img for mid, img in zip(self.ids, self.images)}

    def image_for(self, metatile_id: int):
        return self._by_id.get(metatile_id)

    def match(self, cell_rgba) -> tuple[int, float]:
        """Return (global_metatile_id, distance) of the nearest candidate."""
        np = _np()
        feat = feature_vector(cell_rgba)
        diff = self.features - feat
        dists = np.sqrt(np.einsum("ij,ij->i", diff, diff))
        i = int(np.argmin(dists))
        return self.ids[i], float(dists[i])


def render_tileset(project, primary_label: str, secondary_label: Optional[str] = None,
                   exclude_ids: Optional[set] = None) -> MetatileAtlas:
    """Render every (non-blank) metatile in primary + optional secondary into an atlas.

    Global metatile ids: primary 0..N-1, secondary starts at NUM_METATILES_IN_PRIMARY.
    """
    np = _np()
    tpm = project.tiles_per_metatile()
    num_tiles_primary = project.num_tiles_in_primary()
    num_pals_primary = project.num_pals_in_primary()
    base_secondary = project.num_metatiles_in_primary()
    exclude_ids = exclude_ids or set()

    primary_dir, _ = project.find_tileset_dir(label_to_folder(primary_label))
    tiles_primary = load_tiles(primary_dir)
    pals_primary = load_palettes(primary_dir)

    tiles_secondary = pals_secondary = None
    if secondary_label:
        secondary_dir, _ = project.find_tileset_dir(label_to_folder(secondary_label))
        tiles_secondary = load_tiles(secondary_dir)
        pals_secondary = load_palettes(secondary_dir)

    ids: list[int] = []
    images: list = []

    def _add(metatiles, base):
        for local_id, entries in enumerate(metatiles):
            gid = base + local_id
            if gid in exclude_ids or is_blank_metatile(entries):
                continue
            img = render_metatile(
                entries, tpm, tiles_primary, pals_primary,
                num_tiles_primary, num_pals_primary, tiles_secondary, pals_secondary,
            )
            ids.append(gid)
            images.append(img)

    _add(decode_metatiles(primary_dir, tpm), 0)
    if secondary_label:
        _add(decode_metatiles(secondary_dir, tpm), base_secondary)

    if not images:
        raise TilesetError(f"tileset {primary_label!r} rendered no usable metatiles")

    features = np.stack([feature_vector(im) for im in images])
    return MetatileAtlas(ids=ids, images=images, features=features)


def render_atlas_sheet(atlas: MetatileAtlas, cols: int = 16):
    """Lay every rendered metatile into one PNG so a human/LLM can preview a tileset."""
    Image = _pil()
    n = len(atlas.images)
    rows = (n + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * CELL, max(rows, 1) * CELL), (255, 0, 255, 255))
    for i, img in enumerate(atlas.images):
        r, c = divmod(i, cols)
        sheet.alpha_composite(img.convert("RGBA"), (c * CELL, r * CELL))
    return sheet
