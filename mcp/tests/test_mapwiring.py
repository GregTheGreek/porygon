"""Map wiring: warps, connections, map properties, bg events.

Unit-style tests over a tmp project with a few interlinked maps, plus a couple
of read-only checks against a real pokeemerald checkout.
"""

import json

import pytest

from porygon.core.project import Project, ProjectError


def _wiring_project(root):
    """A minimal project with a town, a route, and a house (1 warp)."""
    (root / "data" / "layouts").mkdir(parents=True)
    (root / "data" / "layouts" / "layouts.json").write_text(
        json.dumps({"layouts_table_label": "gMapLayouts", "layouts": []})
    )
    (root / "include").mkdir()
    (root / "include" / "global.fieldmap.h").write_text("// masks\n")

    maps = {
        "TestTown": {
            "id": "MAP_TEST_TOWN", "name": "TestTown", "layout": "LAYOUT_TEST_TOWN",
            "music": "MUS_LITTLEROOT", "weather": "WEATHER_SUNNY",
            "map_type": "MAP_TYPE_TOWN", "allow_running": True, "show_map_name": True,
            "connections": [{"map": "MAP_TEST_ROUTE", "offset": 0, "direction": "up"}],
            "object_events": [], "warp_events": [], "coord_events": [], "bg_events": [],
        },
        "TestRoute": {
            "id": "MAP_TEST_ROUTE", "name": "TestRoute", "layout": "LAYOUT_TEST_ROUTE",
            "object_events": [], "warp_events": [], "coord_events": [], "bg_events": [],
        },
        "TestHouse": {
            "id": "MAP_TEST_HOUSE", "name": "TestHouse", "layout": "LAYOUT_TEST_HOUSE",
            "object_events": [], "coord_events": [], "bg_events": [],
            "warp_events": [
                {"x": 3, "y": 7, "elevation": 0, "dest_map": "MAP_TEST_TOWN", "dest_warp_id": "0"}
            ],
        },
    }
    for name, data in maps.items():
        d = root / "data" / "maps" / name
        d.mkdir(parents=True)
        (d / "map.json").write_text(json.dumps(data, indent=2) + "\n")
    return root


@pytest.fixture
def proj(tmp_path):
    return Project(_wiring_project(tmp_path))


# --- warps --------------------------------------------------------------

def test_add_warp_ok(proj):
    proj.add_warp("MAP_TEST_TOWN", {
        "x": 5, "y": 6, "elevation": 0, "dest_map": "MAP_TEST_HOUSE", "dest_warp_id": "0",
    })
    warps = proj.read_map_events("MAP_TEST_TOWN")["warp_events"]
    assert len(warps) == 1 and warps[0]["dest_map"] == "MAP_TEST_HOUSE"


def test_add_warp_unknown_dest_raises(proj):
    with pytest.raises(ProjectError, match="dest_map"):
        proj.add_warp("MAP_TEST_TOWN", {
            "x": 5, "y": 6, "elevation": 0, "dest_map": "MAP_NOPE", "dest_warp_id": "0",
        })


def test_add_warp_dest_warp_id_out_of_range_raises(proj):
    # TestHouse has exactly 1 warp (valid id 0); 3 is out of range.
    with pytest.raises(ProjectError, match="out of range"):
        proj.add_warp("MAP_TEST_TOWN", {
            "x": 5, "y": 6, "elevation": 0, "dest_map": "MAP_TEST_HOUSE", "dest_warp_id": "3",
        })


def test_add_warp_missing_field_raises(proj):
    with pytest.raises(ProjectError, match="missing required"):
        proj.add_warp("MAP_TEST_TOWN", {"x": 5, "y": 6, "elevation": 0})


# --- connections --------------------------------------------------------

def test_read_connections(proj):
    conns = proj.read_connections("MAP_TEST_TOWN")
    assert conns == [{"map": "MAP_TEST_ROUTE", "offset": 0, "direction": "up"}]


def test_add_connection(proj):
    proj.edit_connection("MAP_TEST_ROUTE", "add",
                         direction="down", offset=0, dest_map="MAP_TEST_TOWN")
    conns = proj.read_connections("MAP_TEST_ROUTE")
    assert conns == [{"map": "MAP_TEST_TOWN", "offset": 0, "direction": "down"}]


def test_add_connection_unknown_dir_raises(proj):
    with pytest.raises(ProjectError, match="direction"):
        proj.edit_connection("MAP_TEST_ROUTE", "add",
                             direction="sideways", offset=0, dest_map="MAP_TEST_TOWN")


def test_add_connection_unknown_dest_raises(proj):
    with pytest.raises(ProjectError, match="dest map"):
        proj.edit_connection("MAP_TEST_ROUTE", "add",
                             direction="down", offset=0, dest_map="MAP_NOPE")


def test_update_connection_offset(proj):
    proj.edit_connection("MAP_TEST_TOWN", "update", direction="up", offset=12)
    assert proj.read_connections("MAP_TEST_TOWN")[0]["offset"] == 12


def test_remove_connection(proj):
    proj.edit_connection("MAP_TEST_TOWN", "remove", direction="up")
    assert proj.read_connections("MAP_TEST_TOWN") == []


def test_edit_connection_missing_direction_raises(proj):
    with pytest.raises(ProjectError, match="no connection in direction"):
        proj.edit_connection("MAP_TEST_TOWN", "remove", direction="down")


# --- map properties -----------------------------------------------------

def test_set_map_properties(proj):
    proj.set_map_properties("MAP_TEST_TOWN", {"weather": "WEATHER_RAIN", "allow_running": False})
    d = proj.read_map("MAP_TEST_TOWN")
    assert d["weather"] == "WEATHER_RAIN" and d["allow_running"] is False


def test_set_map_properties_preserves_key_order(proj):
    before = list(proj.read_map("MAP_TEST_TOWN").keys())
    proj.set_map_properties("MAP_TEST_TOWN", {"music": "MUS_ROUTE101"})
    after = list(proj.read_map("MAP_TEST_TOWN").keys())
    assert before == after


def test_set_map_properties_rejects_unknown_key(proj):
    with pytest.raises(ProjectError, match="unknown/uneditable"):
        proj.set_map_properties("MAP_TEST_TOWN", {"id": "MAP_HACKED"})


# --- bg events ----------------------------------------------------------

def test_add_hidden_item(proj):
    proj.add_bg_event("MAP_TEST_ROUTE", {
        "type": "hidden_item", "x": 4, "y": 4, "elevation": 3,
        "item": "ITEM_POTION", "flag": "FLAG_HIDDEN_ITEM_TEST",
    })
    bg = proj.read_map_events("MAP_TEST_ROUTE")["bg_events"]
    assert bg[0]["type"] == "hidden_item" and bg[0]["item"] == "ITEM_POTION"


def test_add_secret_base(proj):
    proj.add_bg_event("MAP_TEST_ROUTE", {
        "type": "secret_base", "x": 4, "y": 4, "elevation": 0,
        "secret_base_id": "SECRET_BASE_RED_CAVE1_1",
    })
    assert proj.read_map_events("MAP_TEST_ROUTE")["bg_events"][0]["type"] == "secret_base"


def test_add_bg_event_missing_type_specific_field_raises(proj):
    with pytest.raises(ProjectError, match="hidden_item.*missing"):
        proj.add_bg_event("MAP_TEST_ROUTE", {
            "type": "hidden_item", "x": 4, "y": 4, "elevation": 3, "item": "ITEM_POTION",
        })


def test_add_bg_event_requires_type(proj):
    with pytest.raises(ProjectError, match="requires a 'type'"):
        proj.add_bg_event("MAP_TEST_ROUTE", {"x": 4, "y": 4, "elevation": 3})


# --- real repo (read-only) ----------------------------------------------

def test_real_map_has_connections(project):
    conns = project.read_connections("MAP_LITTLEROOT_TOWN")
    assert any(c["map"] == "MAP_ROUTE101" for c in conns)


def test_real_map_exists(project):
    assert project.map_exists("MAP_LITTLEROOT_TOWN")
    assert not project.map_exists("MAP_DEFINITELY_NOT_A_MAP")
