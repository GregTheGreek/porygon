"""The generated 'porygon basics' tileset: valid files, renders, sane palette."""

import json

import pytest

from porygon.core import basics
from porygon.core import tileset as ts
from porygon.core.project import Project


@pytest.fixture
def proj(tmp_path):
    (tmp_path / "data" / "layouts").mkdir(parents=True)
    (tmp_path / "data" / "layouts" / "layouts.json").write_text(
        json.dumps({"layouts_table_label": "gMapLayouts", "layouts": []})
    )
    return Project(tmp_path)


def test_generate_writes_valid_tileset(proj):
    info = basics.generate_basics_tileset(proj)
    d = proj.root / "data" / "tilesets" / "primary" / basics.BASICS_FOLDER
    assert (d / "tiles.png").exists()
    assert (d / "palettes" / "00.pal").exists()
    assert (d / "metatiles.bin").exists()
    assert (d / "metatile_attributes.bin").exists()
    # one metatile per vocab entry, 8 tile-entries each
    metas = ts.decode_metatiles(d, 8)
    assert len(metas) == len(basics._VOCAB) == info["metatiles"]
    assert all(len(m) == 8 for m in metas)


def test_atlas_renders_every_vocab_tile(proj):
    basics.generate_basics_tileset(proj)
    atlas = ts.render_tileset(proj, basics.BASICS_PRIMARY)
    for i in range(len(basics._VOCAB)):
        assert atlas.image_for(i) is not None, f"vocab id {i} did not render"


def test_generate_is_idempotent_without_force(proj):
    basics.generate_basics_tileset(proj)
    again = basics.generate_basics_tileset(proj)
    assert again["regenerated"] is False
    assert basics.generate_basics_tileset(proj, force=True)["regenerated"] is True


def test_palette_collision_and_water_edges():
    pal = basics.basics_palette()
    # walkable vs blocked match the visual
    assert pal["grass"]["collision"] == 0
    assert pal["bridge_h"]["collision"] == 0 and pal["bridge_v"]["collision"] == 0
    assert pal["water"]["collision"] == 1
    assert pal["rock"]["collision"] == 1 and pal["tree"]["collision"] == 1
    # water carries a full rocky-shoreline edge set for the autotile pass
    edges = pal["water"]["edges"]
    for k in ("fill", "N", "S", "E", "W", "NW", "NE", "SW", "SE"):
        assert k in edges
