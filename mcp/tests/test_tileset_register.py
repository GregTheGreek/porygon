"""Idempotent, data-driven C registration of a generated tileset (the Phase-3 gap-closer)."""

import json
import shutil

import pytest

from porygon.core import basics
from porygon.core import tileset_register as reg
from porygon.core.project import Project


@pytest.fixture
def proj(tmp_path):
    (tmp_path / "data" / "layouts").mkdir(parents=True)
    (tmp_path / "data" / "layouts" / "layouts.json").write_text(
        json.dumps({"layouts_table_label": "g", "layouts": []})
    )
    (tmp_path / "include" / "constants").mkdir(parents=True)
    (tmp_path / "include" / "constants" / "metatile_behaviors.h").write_text(
        "enum { MB_NORMAL, MB_SECRET_BASE_WALL, MB_TALL_GRASS };\n"
    )
    # stub the C/build files register edits (just the structure it needs)
    (tmp_path / "src" / "data" / "tilesets").mkdir(parents=True)
    for f in ("headers.h", "graphics.h", "metatiles.h"):
        (tmp_path / "src" / "data" / "tilesets" / f).write_text(f"// {f}\n")
    (tmp_path / "src" / "graphics.c").write_text("// graphics.c\n")
    (tmp_path / "include" / "tilesets.h").write_text(
        "#ifndef GUARD_tilesets_H\n#define GUARD_tilesets_H\nextern const u32 gTilesetTiles_General[];\n#endif //GUARD_tilesets_H\n"
    )
    (tmp_path / "graphics_file_rules.mk").write_text("TILESETGFXDIR := data/tilesets\n")
    return Project(tmp_path)


def test_register_primary_inserts_all(proj):
    basics.generate_basics_tileset(proj)
    res = reg.register_tileset(proj, basics.BASICS_FOLDER, basics.BASICS_PRIMARY, is_secondary=False)
    assert set(res["files_modified"]) == {"headers", "graphics", "metatiles", "gfx_rule", "externs"}
    root = proj.root
    assert "const struct Tileset gTileset_PorygonBasics" in (root / "src/data/tilesets/headers.h").read_text()
    assert ".callback = NULL," in (root / "src/data/tilesets/headers.h").read_text()
    # primary graphics go in graphics.c, NOT graphics.h
    assert "gTilesetTiles_PorygonBasics[] = INCBIN_U32" in (root / "src/graphics.c").read_text()
    assert "PorygonBasics" not in (root / "src/data/tilesets/graphics.h").read_text()
    assert "gMetatiles_PorygonBasics[] = INCBIN_U16" in (root / "src/data/tilesets/metatiles.h").read_text()
    assert "gMetatileAttributes_PorygonBasics[]" in (root / "src/data/tilesets/metatiles.h").read_text()
    mk = (root / "graphics_file_rules.mk").read_text()
    assert "primary/porygon_basics/tiles.4bpp:" in mk
    assert "\n\t$(GFX)" in mk and "-num_tiles 64" in mk      # real tab + data-driven count
    th = (root / "include/tilesets.h").read_text()
    assert "extern const u32 gTilesetTiles_PorygonBasics[];" in th
    assert th.index("gTilesetTiles_PorygonBasics") < th.rindex("#endif")  # before the guard


def test_register_is_idempotent(proj):
    basics.generate_basics_tileset(proj)
    reg.register_tileset(proj, basics.BASICS_FOLDER, basics.BASICS_PRIMARY)
    res2 = reg.register_tileset(proj, basics.BASICS_FOLDER, basics.BASICS_PRIMARY)
    assert res2["files_modified"] == []
    # no duplicate struct
    assert (proj.root / "src/data/tilesets/headers.h").read_text().count("gTileset_PorygonBasics =") == 1


def test_register_secondary_uses_graphics_h_no_externs(proj):
    basics.generate_basics_tileset(proj)
    shutil.copytree(proj.root / "data/tilesets/primary/porygon_basics",
                    proj.root / "data/tilesets/secondary/porygon_basics")
    res = reg.register_tileset(proj, "porygon_basics", "gTileset_PorygonBasics", is_secondary=True)
    assert "gTilesetTiles_PorygonBasics[]" in (proj.root / "src/data/tilesets/graphics.h").read_text()
    assert "externs" not in res["files_modified"]           # secondary is same TU; no extern needed
    assert ".isSecondary = TRUE," in (proj.root / "src/data/tilesets/headers.h").read_text()
