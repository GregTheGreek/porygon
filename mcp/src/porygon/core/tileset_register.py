"""Register a generated tileset in the pokeemerald C/build files so `make` builds it.

This closes the gap Phase 3 always left manual: porygon writes a tileset's data
(tiles.png / palettes / metatiles.bin / metatile_attributes.bin), but a new tileset is
only built into the ROM once it has a C `struct Tileset`, graphics/metatiles INCBINs, and
a gbagfx build rule. There is no central registry - the struct + a layouts.json reference
is sufficient - so registration is four idempotent, append-only insertions.

Everything is DATA-DRIVEN from the generated tileset dir (tile count from tiles.png,
palette count from palettes/*.pal), modeled byte-for-byte on the shipped tilesets
(gTileset_General / gTileset_Fortree). Append-at-EOF preserves the include order
(graphics/metatiles symbols defined before headers.h references them).
"""

from __future__ import annotations

from pathlib import Path


class RegisterError(Exception):
    pass


def _c_name(label: str) -> str:
    """gTileset_PorygonBasics -> PorygonBasics."""
    return label[len("gTileset_"):] if label.startswith("gTileset_") else label


def _num_tiles(tiles_png: Path) -> int:
    from PIL import Image
    with Image.open(tiles_png) as im:
        w, h = im.size
    return (w // 8) * (h // 8)


def _headers_entry(label: str, c: str, is_secondary: bool) -> str:
    return (
        f"\nconst struct Tileset {label} =\n"
        "{\n"
        "    .isCompressed = TRUE,\n"
        f"    .isSecondary = {'TRUE' if is_secondary else 'FALSE'},\n"
        f"    .tiles = gTilesetTiles_{c},\n"
        f"    .palettes = gTilesetPalettes_{c},\n"
        f"    .metatiles = gMetatiles_{c},\n"
        f"    .metatileAttributes = gMetatileAttributes_{c},\n"
        "    .callback = NULL,\n"
        "};\n"
    )


def _graphics_entry(c: str, data_rel: str, n_palettes: int) -> str:
    pals = "\n".join(
        f'    INCBIN_U16("{data_rel}/palettes/{i:02d}.gbapal"),' for i in range(n_palettes)
    )
    return (
        f'\nconst u32 gTilesetTiles_{c}[] = INCBIN_U32("{data_rel}/tiles.4bpp.lz");\n\n'
        f"const u16 gTilesetPalettes_{c}[][16] =\n{{\n{pals}\n}};\n"
    )


def _metatiles_entry(c: str, data_rel: str) -> str:
    return (
        f'\nconst u16 gMetatiles_{c}[] = INCBIN_U16("{data_rel}/metatiles.bin");\n'
        f'const u16 gMetatileAttributes_{c}[] = INCBIN_U16("{data_rel}/metatile_attributes.bin");\n'
    )


def _gfx_rule(data_rel: str, num_tiles: int) -> str:
    # NOTE: the recipe line MUST start with a literal tab (Makefile requirement).
    return (
        f"\n$(TILESETGFXDIR)/{data_rel.split('data/tilesets/', 1)[1]}/tiles.4bpp: %.4bpp: %.png\n"
        f"\t$(GFX) $< $@ -num_tiles {num_tiles} -Wnum_tiles\n"
    )


def _externs_entry(c: str) -> str:
    return (
        f"extern const u32 gTilesetTiles_{c}[];\n"
        f"extern const u16 gTilesetPalettes_{c}[][16];\n"
    )


def _append_if_absent(path: Path, marker: str, text: str) -> bool:
    """Append text to path unless marker already present. Returns True if appended."""
    if not path.exists():
        raise RegisterError(f"expected file not found: {path}")
    body = path.read_text()
    if marker in body:
        return False
    if not body.endswith("\n"):
        body += "\n"
    path.write_text(body + text)
    return True


def _insert_before_endif(path: Path, marker: str, text: str) -> bool:
    """Insert text just before the final #endif (for include guards). Idempotent on marker."""
    if not path.exists():
        raise RegisterError(f"expected file not found: {path}")
    body = path.read_text()
    if marker in body:
        return False
    idx = body.rfind("#endif")
    if idx == -1:
        return _append_if_absent(path, marker, text)
    path.write_text(body[:idx] + text + "\n" + body[idx:])
    return True


def register_tileset(project, folder: str, label: str, is_secondary: bool = False) -> dict:
    """Idempotently register a generated tileset in the C/build files.

    folder: the tileset dir name (e.g. 'porygon_basics'); label: 'gTileset_PorygonBasics'.
    The data must already exist under data/tilesets/{primary|secondary}/<folder>/.
    """
    root = project.root
    c = _c_name(label)
    kind = "secondary" if is_secondary else "primary"
    data_rel = f"data/tilesets/{kind}/{folder}"
    ts_dir = root / data_rel
    tiles_png = ts_dir / "tiles.png"
    if not tiles_png.exists():
        raise RegisterError(f"{tiles_png} missing - generate the tileset before registering")
    num_tiles = _num_tiles(tiles_png)
    n_palettes = len(list((ts_dir / "palettes").glob("*.pal"))) or 16

    # Graphics live in graphics.h for SECONDARY tilesets (compiled in tilesets.c right
    # before headers.h) but in src/graphics.c for PRIMARY ones (a separate TU), which then
    # need extern declarations in include/tilesets.h. metatiles.h + headers.h are shared.
    graphics_file = (root / "src" / "data" / "tilesets" / "graphics.h" if is_secondary
                     else root / "src" / "graphics.c")
    targets = {
        "headers": (root / "src" / "data" / "tilesets" / "headers.h",
                    f"gTileset_{c} =", _headers_entry(label, c, is_secondary)),
        "graphics": (graphics_file,
                     f"gTilesetTiles_{c}[]", _graphics_entry(c, data_rel, n_palettes)),
        "metatiles": (root / "src" / "data" / "tilesets" / "metatiles.h",
                      f"gMetatiles_{c}[]", _metatiles_entry(c, data_rel)),
        "gfx_rule": (root / "graphics_file_rules.mk",
                     f"/{folder}/tiles.4bpp:", _gfx_rule(data_rel, num_tiles)),
    }
    written = {}
    for key, (path, marker, text) in targets.items():
        written[key] = _append_if_absent(path, marker, text)
    # Primary graphics live in another TU -> declare externs so headers.h sees them.
    if not is_secondary:
        written["externs"] = _insert_before_endif(
            root / "include" / "tilesets.h", f"gTilesetTiles_{c}[]", _externs_entry(c)
        )
        targets["externs"] = (root / "include" / "tilesets.h", "", "")

    return {
        "label": label, "c_name": c, "kind": kind, "data_rel": data_rel,
        "num_tiles": num_tiles, "palettes": n_palettes,
        "files_modified": [k for k, v in written.items() if v],
        "already_present": [k for k, v in written.items() if not v],
        "files": {k: str(v[0]) for k, v in targets.items()},
    }
