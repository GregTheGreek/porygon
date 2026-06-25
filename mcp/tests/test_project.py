"""Project parsing against a real checkout."""

import pytest

from porygon.core.project import ProjectError


def test_info(project):
    info = project.info()
    assert info["layout_count"] > 0
    assert info["map_count"] > 0


def test_layout_bin_size_holds_declared_grid(project):
    # A map.bin must contain AT LEAST the declared grid. A few upstream
    # "unused" layouts have trailing bytes beyond it (handled via Blockdata.trailing),
    # so the invariant is >=, not ==.
    for layout in project.list_layouts():
        size = project._resolve(layout.blockdata_filepath).stat().st_size
        assert size >= layout.width * layout.height * 2, f"{layout.id} map.bin too small for dims"


def test_get_layout_by_id_and_name(project):
    first = project.list_layouts()[0]
    assert project.get_layout(first.id).id == first.id
    assert project.get_layout(first.name).id == first.id


def test_get_missing_layout_raises(project):
    with pytest.raises(ProjectError):
        project.get_layout("LAYOUT_DOES_NOT_EXIST")


def test_list_and_read_map(project):
    maps = project.list_maps()
    assert maps
    named = next(m for m in maps if m["id"])
    got = project.read_map(named["id"])
    assert got["id"] == named["id"]


def test_resolve_rejects_escape(project):
    with pytest.raises(ProjectError):
        project._resolve("../../../etc/passwd")
