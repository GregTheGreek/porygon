"""Phase 6: stamp/terrain map composition. Pure-unit (no tileset binaries; preview off)."""

import json

import pytest

from porygon.core import compose
from porygon.core.blockdata import Block, Blockdata
from porygon.core.compose import ComposeError
from porygon.core.project import Project

# Tree block ids from the shipped general+petalburg terrain palette.
TREE = {468, 469, 476, 477}
GRASS = 1


def _proj(root):
    """Skeleton with a 4x4 source map (distinct metatile ids) + a neighbour to link to."""
    (root / "data" / "layouts").mkdir(parents=True)
    src_layout = {
        "id": "LAYOUT_SRC", "name": "Src_Layout", "width": 4, "height": 4,
        "primary_tileset": "gTileset_General", "secondary_tileset": "gTileset_Petalburg",
        "border_filepath": "data/layouts/Src/border.bin",
        "blockdata_filepath": "data/layouts/Src/map.bin",
    }
    (root / "data" / "layouts" / "layouts.json").write_text(
        json.dumps({"layouts_table_label": "gMapLayouts", "layouts": [src_layout]})
    )
    (root / "include").mkdir()
    (root / "include" / "global.fieldmap.h").write_text("// masks\n")
    (root / "include" / "fieldmap.h").write_text(
        "#define NUM_TILES_IN_PRIMARY 512\n#define NUM_METATILES_IN_PRIMARY 512\n"
        "#define NUM_PALS_IN_PRIMARY 6\n#define NUM_TILES_PER_METATILE 8\n"
    )
    # source blockdata: id = 520 + (y*4 + x); first 8 cells collision 1, rest 0
    blocks = [Block(metatile_id=520 + i, collision=(1 if i < 8 else 0), elevation=3) for i in range(16)]
    srcdir = root / "data" / "layouts" / "Src"
    srcdir.mkdir(parents=True)
    (srcdir / "map.bin").write_bytes(Blockdata(4, 4, blocks).encode())
    (srcdir / "border.bin").write_bytes(b"\x00\x00" * 4)

    maps = root / "data" / "maps"
    maps.mkdir(parents=True)
    (maps / "map_groups.json").write_text(
        json.dumps({"group_order": ["gMapGroup_Town"], "gMapGroup_Town": ["Src", "Neighbour"]}, indent=2) + "\n"
    )
    for nm, mid in [("Src", "MAP_SRC"), ("Neighbour", "MAP_NEIGHBOUR")]:
        d = maps / nm
        d.mkdir()
        (d / "map.json").write_text(json.dumps({
            "id": mid, "name": nm, "layout": "LAYOUT_SRC",
            "connections": [], "object_events": [], "warp_events": [],
            "coord_events": [], "bg_events": [],
        }, indent=2) + "\n")
    return Project(root)


@pytest.fixture
def proj(tmp_path):
    return _proj(tmp_path)


# --- stamps -------------------------------------------------------------

def test_extract_and_resolve_stamp_crops_blocks(proj):
    compose.extract_stamp(proj, "blk", "MAP_SRC", 1, 1, 2, 2)
    recipe = compose.load_stamps(proj)["blk"]
    st = compose.resolve_stamp(proj, "blk", recipe)
    assert st.width == 2 and st.height == 2
    # src id = 520 + (y*4+x): (1,1)->525 (2,1)->526 / (1,2)->529 (2,2)->530
    assert [[b.metatile_id for b in row] for row in st.blocks] == [[525, 526], [529, 530]]


def test_extract_stamp_writes_project_file_and_lists(proj):
    res = compose.extract_stamp(proj, "myhouse", "MAP_SRC", 0, 0, 3, 3, door=(1, 2))
    assert (proj.root / ".porygon" / "stamps.json").exists()
    assert res["recipe"]["primary_tileset"] == "gTileset_General"
    names = {s["name"] for s in compose.list_stamps(proj)}
    assert "myhouse" in names  # project stamp shows up alongside shipped ones


def test_extract_stamp_out_of_bounds_raises(proj):
    with pytest.raises(ComposeError, match="out of bounds"):
        compose.extract_stamp(proj, "toobig", "MAP_SRC", 2, 2, 4, 4)


def test_resolve_stamp_tileset_mismatch_raises(proj):
    recipe = {"source_map": "MAP_SRC", "rect": [0, 0, 2, 2],
              "primary_tileset": "gTileset_General", "secondary_tileset": "gTileset_Cave"}
    with pytest.raises(ComposeError, match="tileset"):
        compose.resolve_stamp(proj, "x", recipe)


# --- composition --------------------------------------------------------

def _spec(**kw):
    base = {"name": "TestTown", "primary_tileset": "gTileset_General",
            "secondary_tileset": "gTileset_Petalburg", "width": 6, "height": 6,
            "base_terrain": "grass"}
    base.update(kw)
    return base


def test_compose_terrain_and_border(proj):
    res = compose.compose_map(proj, _spec(border_terrain="tree", border_thickness=1), preview=False)
    assert res["ok"] and res["map"] == "MAP_TEST_TOWN"
    bd = proj.read_layout_blockdata("LAYOUT_TEST_TOWN")
    assert bd.get(0, 0).metatile_id in TREE          # border ring is tree
    assert bd.get(3, 0).metatile_id in TREE
    assert bd.get(2, 2).metatile_id == GRASS         # interior is grass
    # registered as a walkable map
    assert proj.map_exists("MAP_TEST_TOWN")
    assert "TestTown" in proj.read_map_groups()["gMapGroup_Town"]


def test_compose_places_stamp_with_collision(proj):
    compose.extract_stamp(proj, "blk", "MAP_SRC", 0, 0, 2, 2)  # ids 520,521 / 524,525, coll 1
    res = compose.compose_map(proj, _spec(objects=[{"stamp": "blk", "x": 2, "y": 3}]), preview=False)
    assert res["stamps_placed"] == [{"stamp": "blk", "x": 2, "y": 3, "width": 2, "height": 2, "as": "object"}]
    bd = proj.read_layout_blockdata("LAYOUT_TEST_TOWN")
    assert bd.get(2, 3).metatile_id == 520 and bd.get(2, 3).collision == 1
    assert bd.get(3, 4).metatile_id == 525           # bottom-right of the stamp


def test_compose_reciprocal_link(proj):
    compose.compose_map(proj, _spec(link={"to": "MAP_NEIGHBOUR", "dir": "up", "offset": 2}), preview=False)
    new_conns = proj.read_connections("MAP_TEST_TOWN")
    assert new_conns == [{"map": "MAP_NEIGHBOUR", "offset": 2, "direction": "up"}]
    back = proj.read_connections("MAP_NEIGHBOUR")
    assert back == [{"map": "MAP_TEST_TOWN", "offset": -2, "direction": "down"}]


def test_compose_out_of_bounds_stamp_warns_not_raises(proj):
    compose.extract_stamp(proj, "blk", "MAP_SRC", 0, 0, 4, 4)
    res = compose.compose_map(proj, _spec(objects=[{"stamp": "blk", "x": 4, "y": 4}]), preview=False)
    assert res["stamps_placed"] == [] and any("out of bounds" in w for w in res["warnings"])


def test_compose_into_new_group(proj):
    compose.compose_map(proj, _spec(name="GroupedTown", group="aa_image_toMap"), preview=False)
    groups = proj.read_map_groups()
    assert "aa_image_toMap" in groups["group_order"]
    assert "GroupedTown" in groups["aa_image_toMap"]


def test_edge_key_cases():
    # args are (n_land, e_land, s_land, w_land); "land" = neighbour is a different class
    assert compose._edge_key(True, False, False, True) == "NW"
    assert compose._edge_key(True, True, False, False) == "NE"
    assert compose._edge_key(False, False, True, True) == "SW"
    assert compose._edge_key(False, True, True, False) == "SE"
    assert compose._edge_key(True, False, False, False) == "N"
    assert compose._edge_key(False, True, False, False) == "E"
    assert compose._edge_key(False, False, True, False) == "S"
    assert compose._edge_key(False, False, False, True) == "W"
    assert compose._edge_key(False, False, False, False) is None  # interior -> fill


def test_compose_water_autotiles_shoreline(proj):
    # a water region in a grass field gets banked edges + corners; interior stays fill
    compose.compose_map(proj, _spec(width=8, height=8,
                                    regions=[{"terrain": "water", "rect": [2, 2, 4, 4]}]), preview=False)
    bd = proj.read_layout_blockdata("LAYOUT_TEST_TOWN")
    edges = compose.terrain_palette("gTileset_General", "gTileset_Petalburg")["water"]["edges"]
    assert bd.get(2, 2).metatile_id == edges["NW"]
    assert bd.get(5, 2).metatile_id == edges["NE"]
    assert bd.get(2, 5).metatile_id == edges["SW"]
    assert bd.get(5, 5).metatile_id == edges["SE"]
    assert bd.get(3, 2).metatile_id == edges["N"]      # top side
    assert bd.get(2, 3).metatile_id == edges["W"]      # left side
    assert bd.get(3, 3).metatile_id == edges["fill"]   # interior
    assert bd.get(3, 3).collision == 1                 # water still impassable


def test_compose_no_autotile_without_edges(proj):
    # grass/tree define no `edges`, so the autotile pass must leave them untouched
    compose.compose_map(proj, _spec(border_terrain="tree", border_thickness=1), preview=False)
    bd = proj.read_layout_blockdata("LAYOUT_TEST_TOWN")
    assert bd.get(2, 2).metatile_id == GRASS  # plain grass interior, not rewritten


def test_region_stamp_blits_verbatim_and_skips_autotile(proj):
    compose.extract_stamp(proj, "blk", "MAP_SRC", 0, 0, 2, 2)  # ids 520,521 / 524,525
    res = compose.compose_map(proj, _spec(width=8, height=8,
                                          regions=[{"stamp": "blk", "rect": [3, 3]}]), preview=False)
    assert {"stamp": "blk", "x": 3, "y": 3, "width": 2, "height": 2, "as": "region"} in res["stamps_placed"]
    bd = proj.read_layout_blockdata("LAYOUT_TEST_TOWN")
    assert bd.get(3, 3).metatile_id == 520   # verbatim real geometry, not filled/autotiled
    assert bd.get(4, 4).metatile_id == 525


def test_compose_unknown_terrain_raises(proj):
    with pytest.raises(ComposeError, match="unknown terrain"):
        compose.compose_map(proj, _spec(base_terrain="lava"), preview=False)


def test_compose_unknown_stamp_raises(proj):
    with pytest.raises(ComposeError, match="unknown stamp"):
        compose.compose_map(proj, _spec(objects=[{"stamp": "nope", "x": 0, "y": 0}]), preview=False)


def test_compose_unsupported_tileset_pair_raises(proj):
    with pytest.raises(ComposeError, match="no terrain palette"):
        compose.compose_map(proj, _spec(primary_tileset="gTileset_Building",
                                        secondary_tileset="gTileset_GenericBuilding"), preview=False)


# --- shipped library loads ----------------------------------------------

def test_shipped_stamps_and_terrain_load(proj):
    shipped = compose.load_stamps(proj)
    assert {"house", "lab", "mart"} <= set(shipped)
    pal = compose.terrain_palette("gTileset_General", "gTileset_Petalburg")
    assert pal["grass"]["metatile_id"] == GRASS and "block" in pal["tree"]
