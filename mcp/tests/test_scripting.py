"""Event-scripting: parsers (unit), validation + macros (real repo + tmp)."""

import json

import pytest

from porygon.core.project import Project, ProjectError
from porygon.core.scripting import (
    _parse_macro_args,
    load_macros,
    lookup_macro,
    parse_labels,
    poryscript_status,
    scaffold_script,
    validate_map_scripts,
)


# --- unit: parsers ------------------------------------------------------

def test_parse_labels_global_vs_local():
    text = "Foo_EventScript_A::\n\tlock\n\tend\nFoo_Local:\n\tstep_end\n"
    labels = parse_labels(text)
    assert labels == {"Foo_EventScript_A": True, "Foo_Local": False}


def test_parse_labels_ignores_indented_and_directives():
    text = "\tmsgbox Foo_Text\n.macro x\n.endm\nReal_Label::\n"
    assert parse_labels(text) == {"Real_Label": True}


def test_parse_macro_args():
    assert _parse_macro_args("text:req, type=MSGBOX_DEFAULT") == [
        {"name": "text", "required": True, "default": None},
        {"name": "type", "required": False, "default": "MSGBOX_DEFAULT"},
    ]
    assert _parse_macro_args("localId:req, movements:req, map") == [
        {"name": "localId", "required": True, "default": None},
        {"name": "movements", "required": True, "default": None},
        {"name": "map", "required": False, "default": None},
    ]
    assert _parse_macro_args("") == []


def test_scaffold_sign_and_npc():
    sign = scaffold_script("sign", "Town_EventScript_Sign", "Welcome!")
    assert "Town_EventScript_Sign::" in sign
    assert "msgbox Town_EventScript_Sign_Text, MSGBOX_SIGN" in sign
    assert '.string "Welcome!$"' in sign
    npc = scaffold_script("npc", "Town_EventScript_Guy")
    assert "lock" in npc and "faceplayer" in npc and "release" in npc
    with pytest.raises(ValueError):
        scaffold_script("bogus", "X")


# --- tmp project: clean + negative validation ---------------------------

def _script_project(root):
    (root / "data" / "layouts").mkdir(parents=True)
    (root / "data" / "layouts" / "layouts.json").write_text(
        json.dumps({"layouts_table_label": "gMapLayouts", "layouts": []})
    )
    (root / "include").mkdir()
    (root / "include" / "global.fieldmap.h").write_text("// masks\n")
    consts = root / "include" / "constants"
    consts.mkdir()
    (consts / "flags.h").write_text("#define FLAG_TEST 0x100\n")
    (consts / "event_objects.h").write_text("#define OBJ_EVENT_GFX_TWIN 5\n")
    (consts / "event_object_movement.h").write_text("#define MOVEMENT_TYPE_WANDER_AROUND 3\n")
    macros = root / "asm" / "macros"
    macros.mkdir(parents=True)
    (macros / "event.inc").write_text(
        "\t.macro msgbox text:req, type=MSGBOX_DEFAULT\n\t.endm\n"
        "\t.macro lock\n\t.endm\n"
    )
    mapdir = root / "data" / "maps" / "TestMap"
    mapdir.mkdir(parents=True)
    (mapdir / "map.json").write_text(json.dumps({
        "id": "MAP_TEST", "name": "TestMap", "layout": "LAYOUT_TEST",
        "object_events": [], "warp_events": [], "coord_events": [],
        "bg_events": [
            {"type": "sign", "x": 1, "y": 1, "elevation": 0,
             "player_facing_dir": "BG_EVENT_PLAYER_FACING_ANY",
             "script": "TestMap_EventScript_Sign"}
        ],
    }))
    (mapdir / "scripts.inc").write_text(
        "TestMap_EventScript_Sign::\n\tmsgbox TestMap_Text_Sign, MSGBOX_SIGN\n\tend\n"
    )
    return root


def test_validate_clean(tmp_path):
    p = Project(_script_project(tmp_path))
    r = validate_map_scripts(p, "MAP_TEST")
    assert r["ok"] is True
    assert r["error_count"] == 0


def test_validate_dangling_label(tmp_path):
    root = _script_project(tmp_path)
    mj = root / "data" / "maps" / "TestMap" / "map.json"
    d = json.loads(mj.read_text())
    d["bg_events"][0]["script"] = "TestMap_EventScript_Missing"
    mj.write_text(json.dumps(d))
    r = validate_map_scripts(Project(root), "MAP_TEST")
    assert r["ok"] is False
    assert any(f["kind"] == "dangling_label" for f in r["findings"])


def test_validate_unknown_constant(tmp_path):
    root = _script_project(tmp_path)
    p = Project(root)
    # Add an object event referencing a real gfx but a bogus flag.
    p.add_event("MAP_TEST", "object_events", {
        "graphics_id": "OBJ_EVENT_GFX_TWIN", "x": 2, "y": 2, "elevation": 3,
        "movement_type": "MOVEMENT_TYPE_WANDER_AROUND", "movement_range_x": 1,
        "movement_range_y": 1, "trainer_type": "TRAINER_TYPE_NONE",
        "trainer_sight_or_berry_tree_id": "0", "script": "TestMap_EventScript_Sign",
        "flag": "FLAG_NONEXISTENT",
    })
    r = validate_map_scripts(p, "MAP_TEST")
    bad = [f for f in r["findings"] if f["kind"] == "unknown_constant"]
    assert any("FLAG_NONEXISTENT" in f["message"] for f in bad)


def test_add_and_remove_event(tmp_path):
    p = Project(_script_project(tmp_path))
    p.add_event("MAP_TEST", "bg_events", {
        "type": "sign", "x": 9, "y": 9, "elevation": 0,
        "player_facing_dir": "BG_EVENT_PLAYER_FACING_ANY",
        "script": "TestMap_EventScript_Sign",
    })
    assert len(p.read_map_events("MAP_TEST")["bg_events"]) == 2
    p.remove_event("MAP_TEST", "bg_events", 1)
    assert len(p.read_map_events("MAP_TEST")["bg_events"]) == 1


def test_add_event_missing_field_raises(tmp_path):
    p = Project(_script_project(tmp_path))
    with pytest.raises(ProjectError):
        p.add_event("MAP_TEST", "bg_events", {"type": "sign", "x": 1})


# --- real repos: validation + macros ------------------------------------

def test_real_map_validates_clean(project):
    # A real, shipped map should have no dangling labels or unknown constants.
    r = validate_map_scripts(project, "MAP_LITTLEROOT_TOWN")
    dangling = [f for f in r["findings"] if f["kind"] == "dangling_label"]
    unknown = [f for f in r["findings"] if f["kind"] == "unknown_constant"]
    assert dangling == [], dangling
    assert unknown == [], unknown


def test_real_macro_signatures(project):
    msgbox = lookup_macro(project, "msgbox")
    assert msgbox is not None
    names = [a["name"] for a in msgbox["args"]]
    assert "text" in names
    assert any(a["name"] == "type" and a["default"] for a in msgbox["args"])

    applymovement = lookup_macro(project, "applymovement")
    am_names = [a["name"] for a in applymovement["args"]]
    assert "localId" in am_names and "movements" in am_names


def test_macros_loaded(project):
    macros = load_macros(project)
    assert len(macros) > 100  # pokeemerald has ~270
    assert "lock" in macros and "faceplayer" in macros


def test_poryscript_absent_on_real_repo(project):
    st = poryscript_status(project)
    # These repos use hand-written .inc; poryscript isn't set up.
    assert st["project_uses_poryscript"] is False
