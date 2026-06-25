"""Maps from images: image -> (Porytiles tileset + map.bin layout), reviewable in Porymap.

Division of labor: porygon cuts the image into 16x16 cells, dedups them into unique
metatiles, lays them into a Porytiles source sheet, and records each map cell's
unique-metatile index = the map.bin placement. Porytiles compiles that sheet into
tiles.png/metatiles.bin/palettes (tile dedup + palette packing).

MVP: best for tile-aligned / pixel-art images; collision is a coarse suggestion the
human confirms in Porymap. Complex images make Porytiles error on palette overflow,
which is surfaced verbatim.
"""

from __future__ import annotations

import hashlib
import re
import shutil
import subprocess
from pathlib import Path
from typing import Optional

from porygon.core.blockdata import Block, Blockdata, encode_blocks

CELL = 16            # metatile size in pixels
SHEET_COLS = 8       # 128px source sheet width / 16px = 8 metatiles per row
TRANSPARENT = (255, 0, 255, 255)  # Porytiles' default extrinsic transparency (magenta)
PRIMARY_METATILE_LIMIT = 512
ELEVATION_DEFAULT = 3


class ImagingError(Exception):
    pass


def _pil():
    try:
        from PIL import Image
        return Image
    except ImportError as e:  # pragma: no cover
        raise ImagingError("Pillow not installed - run `uv sync --extra imaging`") from e


# --- naming helpers (must match Porymap's label<->folder convention) ----

def _camel(name: str) -> str:
    parts = re.split(r"[^A-Za-z0-9]+", name)
    return "".join(p[:1].upper() + p[1:] for p in parts if p)


def _snake(camel: str) -> str:
    s = re.sub(r"(?<!^)(?=[A-Z])", "_", camel)
    return s.lower()


def names_for(name: str) -> dict:
    camel = _camel(name)
    snake = _snake(camel)
    return {
        "tileset_label": f"gTileset_{camel}",
        "tileset_folder": snake,
        "layout_id": f"LAYOUT_{snake.upper()}",
        "layout_name": f"{camel}_Layout",
        "layout_folder": camel,
    }


# --- image -> cells -----------------------------------------------------

def validate_image(path) -> dict:
    Image = _pil()
    with Image.open(path) as img:
        w, h = img.size
    if w % CELL or h % CELL:
        raise ImagingError(f"image is {w}x{h}; both dimensions must be a multiple of {CELL}px")
    return {"width": w, "height": h, "cells_x": w // CELL, "cells_y": h // CELL}


def dedup_cells(path):
    """Return (unique_cells: list[Image RGBA], placement: list[list[int]])."""
    Image = _pil()
    with Image.open(path) as im:
        img = im.convert("RGBA")
    w, h = img.size
    cx, cy = w // CELL, h // CELL
    unique = []
    index: dict[str, int] = {}
    placement: list[list[int]] = []
    for r in range(cy):
        row = []
        for c in range(cx):
            cell = img.crop((c * CELL, r * CELL, c * CELL + CELL, r * CELL + CELL))
            key = hashlib.sha1(cell.tobytes()).hexdigest()
            if key not in index:
                index[key] = len(unique)
                unique.append(cell)
            row.append(index[key])
        placement.append(row)
    return unique, placement


def build_porytiles_source(unique_cells, src_dir, dual_layer: bool) -> Path:
    """Write a Porytiles source folder; metatile i == source sheet position i."""
    Image = _pil()
    src = Path(src_dir)
    src.mkdir(parents=True, exist_ok=True)
    n = max(len(unique_cells), 1)
    rows = (n + SHEET_COLS - 1) // SHEET_COLS
    sheet = (SHEET_COLS * CELL, rows * CELL)
    bottom = Image.new("RGBA", sheet, TRANSPARENT)
    for i, cell in enumerate(unique_cells):
        r, c = divmod(i, SHEET_COLS)
        bottom.paste(cell, (c * CELL, r * CELL))
    bottom.save(src / "bottom.png")
    # Porytiles expects all three layer PNGs present even in dual-layer mode
    # (the -dual-layer flag controls compilation, not which files must exist).
    blank = Image.new("RGBA", sheet, TRANSPARENT)
    blank.save(src / "middle.png")
    blank.save(src / "top.png")
    return src


# --- Porytiles wrapper --------------------------------------------------

# We target the `compile-primary` interface. Porytiles v1.0.0+ ships that as the
# `porytiles-legacy` binary (the modern `porytiles` switched to a project-managed
# CLI); brew installs both. Prefer legacy; fall back to `porytiles` for older installs.
_PORYTILES_BINARIES = ("porytiles-legacy", "porytiles")


def porytiles_path() -> Optional[str]:
    for name in _PORYTILES_BINARIES:
        found = shutil.which(name)
        if found:
            return found
    return None


def porytiles_status(project=None) -> dict:
    binary = porytiles_path()
    version = None
    if binary:
        try:
            r = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=10)
            version = (r.stdout or r.stderr).strip().splitlines()[0] if (r.stdout or r.stderr) else None
        except (OSError, subprocess.SubprocessError):
            pass
    return {
        "available": binary is not None,
        "binary": binary,
        "version": version,
        "install_hint": "brew install grunt-lucas/porytiles/porytiles (provides porytiles-legacy)",
    }


def run_porytiles(project, src_dir, out_dir, dual_layer: bool) -> dict:
    binary = porytiles_path()
    if not binary:
        return {"ok": False, "message": "porytiles not found - brew install grunt-lucas/porytiles/porytiles"}
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    behaviors = project.metatile_behaviors_header()
    args = [binary, "compile-primary", "-o", str(out)]
    if dual_layer:
        args.append("-dual-layer")
    args += [str(src_dir), str(behaviors)]
    try:
        proc = subprocess.run(args, capture_output=True, text=True)
    except FileNotFoundError:
        return {"ok": False, "message": f"porytiles not executable: {binary}"}
    return {
        "ok": proc.returncode == 0,
        "returncode": proc.returncode,
        "command": args,
        "output": ((proc.stdout or "") + (proc.stderr or ""))[-4000:],
        "out_dir": str(out),
    }


# --- placement + collision ----------------------------------------------

def placement_to_blockdata(placement, collision=None) -> Blockdata:
    """Convert a per-cell metatile-id grid into Blockdata (collision optional)."""
    h = len(placement)
    w = len(placement[0]) if h else 0
    blocks = []
    for r, row in enumerate(placement):
        for c, mid in enumerate(row):
            coll = collision[r][c] if collision else 0
            blocks.append(Block(metatile_id=mid, collision=coll, elevation=ELEVATION_DEFAULT))
    return Blockdata(width=w, height=h, blocks=blocks)


def suggest_collision(unique_cells, placement) -> list[list[int]]:
    """Coarse, non-authoritative collision suggestion.

    Heuristic: a metatile whose mean luminance is dark is likely a wall/obstacle
    (impassable=1); lighter tiles are likely walkable ground (0). Always meant to
    be reviewed by a human in Porymap.
    """
    impassable: dict[int, int] = {}
    for i, cell in enumerate(unique_cells):
        data = cell.convert("L").tobytes()  # one luminance byte per pixel
        mean = sum(data) / len(data) if data else 255
        impassable[i] = 1 if mean < 80 else 0
    return [[impassable.get(mid, 0) for mid in row] for row in placement]


# --- orchestration ------------------------------------------------------

def image_to_map(project, image_path, name: str, full_auto: bool = False,
                 secondary_tileset: Optional[str] = None) -> dict:
    """Turn an image into a new (primary) tileset + new layout, reviewable in Porymap.

    Returns a result dict; on Porytiles failure returns {ok:False, stage:'porytiles', ...}
    with the compiler output (e.g. palette overflow) surfaced.
    """
    info = validate_image(image_path)
    unique, placement = dedup_cells(image_path)
    n = len(unique)
    if n > PRIMARY_METATILE_LIMIT:
        raise ImagingError(
            f"{n} unique metatiles exceeds the primary-tileset limit ({PRIMARY_METATILE_LIMIT}); "
            f"image is too complex/large for the MVP"
        )

    names = names_for(name)
    dual = project.is_dual_layer()
    tileset_out = project.tileset_dir(names["tileset_folder"], secondary=False)
    src_dir = tileset_out.parent / f".{names['tileset_folder']}_src"

    build_porytiles_source(unique, src_dir, dual)
    compiled = run_porytiles(project, src_dir, tileset_out, dual)
    if not compiled["ok"]:
        return {"ok": False, "stage": "porytiles", "unique_metatiles": n, **compiled}

    # placement -> blockdata (collision: passable for assisted; suggested for full_auto)
    collision = suggest_collision(unique, placement) if full_auto else None
    bd = placement_to_blockdata(placement, collision)

    # pick a secondary tileset to pair with (layouts need both); reuse an existing one
    if secondary_tileset is None:
        existing = [l for l in project.list_layouts() if l.secondary_tileset]
        secondary_tileset = existing[0].secondary_tileset if existing else "gTileset_General"

    entry = project.add_layout(
        names["layout_id"], names["layout_name"],
        info["cells_x"], info["cells_y"],
        primary_tileset=names["tileset_label"], secondary_tileset=secondary_tileset,
    )
    (project.root / entry["blockdata_filepath"]).write_bytes(bd.encode())
    (project.root / entry["border_filepath"]).write_bytes(
        encode_blocks([Block(0, 0, ELEVATION_DEFAULT)] * 4)  # 2x2 border of metatile 0
    )

    return {
        "ok": True,
        "layout": names["layout_id"],
        "layout_name": names["layout_name"],
        "tileset": names["tileset_label"],
        "tileset_dir": str(tileset_out),
        "width": info["cells_x"],
        "height": info["cells_y"],
        "unique_metatiles": n,
        "collision": "suggested+applied" if full_auto else "passable (review in Porymap)",
        "rom_build_note": (
            "Tileset is viewable in Porymap now. To build into the ROM, the new primary "
            "tileset must still be registered in C (headers.h/graphics.h/metatiles.h)."
        ),
    }
