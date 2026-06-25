"""Maps-from-images: porygon's half (Pillow), no Porytiles needed."""

import json

import pytest

PIL = pytest.importorskip("PIL")  # skip if the imaging extra isn't installed
from PIL import Image  # noqa: E402

from porygon.core import imaging  # noqa: E402
from porygon.core.imaging import (  # noqa: E402
    ImagingError,
    build_porytiles_source,
    dedup_cells,
    names_for,
    placement_to_blockdata,
    run_porytiles,
    suggest_collision,
    validate_image,
)
from porygon.core.project import Project  # noqa: E402


def _png(path, cells, cell_px=16):
    """cells: 2D list of (r,g,b) - one solid color per 16x16 cell."""
    h = len(cells)
    w = len(cells[0])
    img = Image.new("RGBA", (w * cell_px, h * cell_px))
    for ry, row in enumerate(cells):
        for cx, color in enumerate(row):
            block = Image.new("RGBA", (cell_px, cell_px), color + (255,))
            img.paste(block, (cx * cell_px, ry * cell_px))
    img.save(path)
    return path


# --- naming -------------------------------------------------------------

def test_names_for():
    n = names_for("MyTown")
    assert n["tileset_label"] == "gTileset_MyTown"
    assert n["tileset_folder"] == "my_town"
    assert n["layout_id"] == "LAYOUT_MY_TOWN"
    assert n["layout_name"] == "MyTown_Layout"


# --- validate -----------------------------------------------------------

def test_validate_image_ok(tmp_path):
    p = _png(tmp_path / "ok.png", [[(0, 0, 0), (255, 255, 255)]])  # 32x16
    info = validate_image(p)
    assert info == {"width": 32, "height": 16, "cells_x": 2, "cells_y": 1}


def test_validate_image_rejects_unaligned(tmp_path):
    Image.new("RGBA", (20, 16)).save(tmp_path / "bad.png")
    with pytest.raises(ImagingError):
        validate_image(tmp_path / "bad.png")


# --- dedup --------------------------------------------------------------

def test_dedup_identical_cells_collapse(tmp_path):
    p = _png(tmp_path / "same.png", [[(10, 20, 30), (10, 20, 30)]])
    unique, placement = dedup_cells(p)
    assert len(unique) == 1
    assert placement == [[0, 0]]


def test_dedup_distinct_cells(tmp_path):
    p = _png(tmp_path / "diff.png", [[(0, 0, 0), (255, 255, 255)]])
    unique, placement = dedup_cells(p)
    assert len(unique) == 2
    assert placement == [[0, 1]]


# --- source sheet -------------------------------------------------------

def test_build_source_writes_all_layers(tmp_path):
    cells = [Image.new("RGBA", (16, 16), (1, 2, 3, 255))]
    # Porytiles requires all three layer PNGs to exist even in dual-layer mode.
    d = build_porytiles_source(cells, tmp_path / "dl", dual_layer=True)
    for layer in ("bottom.png", "middle.png", "top.png"):
        assert (d / layer).exists(), layer
    # sheet is 128px wide (8 metatiles/row)
    with Image.open(d / "bottom.png") as sheet:
        assert sheet.size == (128, 16)


# --- placement -> blockdata --------------------------------------------

def test_placement_to_blockdata(tmp_path):
    bd = placement_to_blockdata([[0, 1], [2, 3]])
    assert bd.width == 2 and bd.height == 2
    assert [b.metatile_id for b in bd.blocks] == [0, 1, 2, 3]
    assert all(b.elevation == imaging.ELEVATION_DEFAULT for b in bd.blocks)
    assert all(b.collision == 0 for b in bd.blocks)


def test_placement_applies_collision():
    bd = placement_to_blockdata([[0, 1]], collision=[[0, 1]])
    assert [b.collision for b in bd.blocks] == [0, 1]


def test_suggest_collision_dark_is_wall(tmp_path):
    dark = Image.new("RGBA", (16, 16), (0, 0, 0, 255))
    light = Image.new("RGBA", (16, 16), (240, 240, 240, 255))
    coll = suggest_collision([dark, light], [[0, 1]])
    assert coll == [[1, 0]]


# --- porytiles wrapper (no binary) -------------------------------------

def test_run_porytiles_missing_binary(tmp_path, monkeypatch):
    monkeypatch.setattr(imaging, "porytiles_path", lambda: None)
    r = run_porytiles(None, tmp_path / "src", tmp_path / "out", dual_layer=True)
    assert r["ok"] is False and "porytiles" in r["message"].lower()


def test_porytiles_status_shape():
    st = imaging.porytiles_status()
    assert "available" in st and isinstance(st["available"], bool)
    assert "install_hint" in st


# --- project integration ------------------------------------------------

def test_tiles_per_metatile_real(project):
    # vanilla pokeemerald = 8 (dual-layer)
    assert project.tiles_per_metatile() == 8
    assert project.is_dual_layer() is True


def _skeleton(root):
    (root / "data" / "layouts").mkdir(parents=True)
    (root / "data" / "layouts" / "layouts.json").write_text(
        json.dumps({"layouts_table_label": "gMapLayouts", "layouts": []})
    )
    (root / "include").mkdir()
    (root / "include" / "global.fieldmap.h").write_text("// masks\n")
    return root


def test_add_layout(tmp_path):
    p = Project(_skeleton(tmp_path))
    entry = p.add_layout("LAYOUT_MY_TOWN", "MyTown_Layout", 4, 3,
                         primary_tileset="gTileset_MyTown", secondary_tileset="gTileset_General")
    assert entry["width"] == 4 and entry["height"] == 3
    assert entry["blockdata_filepath"] == "data/layouts/MyTown/map.bin"
    assert (tmp_path / "data" / "layouts" / "MyTown").is_dir()
    # registered in layouts.json
    data = json.loads((tmp_path / "data" / "layouts" / "layouts.json").read_text())
    assert any(l["id"] == "LAYOUT_MY_TOWN" for l in data["layouts"])
    # duplicate rejected
    with pytest.raises(Exception):
        p.add_layout("LAYOUT_MY_TOWN", "MyTown_Layout", 4, 3, "x", "y")
