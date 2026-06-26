"""Creating a walkable map: add_map + map_groups.json registration."""

import json

import pytest

from porygon.core.project import Project, ProjectError


def _proj(root):
    """Skeleton project: one layout, a map group, and one existing neighbour map."""
    (root / "data" / "layouts").mkdir(parents=True)
    (root / "data" / "layouts" / "layouts.json").write_text(json.dumps({
        "layouts_table_label": "gMapLayouts",
        "layouts": [{
            "id": "LAYOUT_X", "name": "XTown_Layout", "width": 4, "height": 3,
            "primary_tileset": "gTileset_General", "secondary_tileset": "gTileset_General",
            "border_filepath": "data/layouts/XTown/border.bin",
            "blockdata_filepath": "data/layouts/XTown/map.bin",
        }],
    }))
    (root / "include").mkdir()
    (root / "include" / "global.fieldmap.h").write_text("// masks\n")

    maps = root / "data" / "maps"
    maps.mkdir(parents=True)
    (maps / "map_groups.json").write_text(json.dumps({
        "group_order": ["gMapGroup_Town", "gMapGroup_Indoor"],
        "gMapGroup_Town": ["ExistingTown"],
        "gMapGroup_Indoor": [],
    }, indent=2) + "\n")
    nb = maps / "ExistingTown"
    nb.mkdir()
    (nb / "map.json").write_text(json.dumps({
        "id": "MAP_EXISTING_TOWN", "name": "ExistingTown", "layout": "LAYOUT_X",
        "connections": [], "object_events": [], "warp_events": [],
        "coord_events": [], "bg_events": [],
    }, indent=2) + "\n")
    return Project(root)


@pytest.fixture
def proj(tmp_path):
    return _proj(tmp_path)


def test_add_map_creates_json_and_registers(proj):
    path = proj.add_map("MAP_NEW_TOWN", "NewTown", "LAYOUT_X")
    assert path.exists()
    d = json.loads(path.read_text())
    assert d["id"] == "MAP_NEW_TOWN" and d["layout"] == "LAYOUT_X"
    assert d["connections"] == [] and d["warp_events"] == []
    # registered under the default (first) group
    groups = proj.read_map_groups()
    assert "NewTown" in groups["gMapGroup_Town"]
    assert proj.map_exists("MAP_NEW_TOWN")


def test_add_map_into_named_group(proj):
    proj.add_map("MAP_NEW_HOUSE", "NewHouse", "LAYOUT_X", group="gMapGroup_Indoor")
    assert "NewHouse" in proj.read_map_groups()["gMapGroup_Indoor"]


def test_add_map_unknown_layout_raises(proj):
    with pytest.raises(ProjectError, match="layout"):
        proj.add_map("MAP_NEW_TOWN", "NewTown", "LAYOUT_NOPE")


def test_add_map_unknown_group_raises(proj):
    with pytest.raises(ProjectError, match="group"):
        proj.add_map("MAP_NEW_TOWN", "NewTown", "LAYOUT_X", group="gMapGroup_Nope")


def test_add_map_duplicate_raises(proj):
    proj.add_map("MAP_NEW_TOWN", "NewTown", "LAYOUT_X")
    with pytest.raises(ProjectError, match="already exists"):
        proj.add_map("MAP_NEW_TOWN", "NewTown", "LAYOUT_X")


def test_list_tilesets_empty_ok(proj):
    # no tilesets on disk in the skeleton -> empty list, not an error
    assert proj.list_tilesets() == []
