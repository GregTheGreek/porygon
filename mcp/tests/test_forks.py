"""Fork robustness: vanilla vs pokeemerald-expansion layouts.

These build a minimal project skeleton in a tmp dir, so they run anywhere
(no real checkout needed) and pin the variant-detection behavior.
"""

import json

from porygon.core.project import Project


def _skeleton(root):
    """Minimal tree that Project accepts as a decomp root."""
    (root / "data" / "layouts").mkdir(parents=True)
    (root / "data" / "layouts" / "layouts.json").write_text(
        json.dumps({"layouts_table_label": "gMapLayouts", "layouts": []})
    )
    (root / "include").mkdir()
    (root / "include" / "global.fieldmap.h").write_text("// masks\n")
    return root


def test_vanilla_debug_status(tmp_path):
    root = _skeleton(tmp_path)
    (root / "include" / "config.h").write_text("#define NDEBUG\n#define LOG_HANDLER 2\n")
    st = Project(root).debug_print_status()
    assert st["variant"] == "vanilla"
    assert st["ndebug_defined"] is True
    assert st["debug_prints_enabled"] is False


def test_vanilla_debug_enabled_when_ndebug_commented(tmp_path):
    root = _skeleton(tmp_path)
    (root / "include" / "config.h").write_text("// #define NDEBUG\n")
    st = Project(root).debug_print_status()
    assert st["debug_prints_enabled"] is True


def test_expansion_debug_status(tmp_path):
    root = _skeleton(tmp_path)
    cfg = root / "include" / "config"
    cfg.mkdir()
    (cfg / "debug.h").write_text(
        "#define DEBUG_OVERWORLD_MENU            DISABLED_ON_RELEASE // overworld menu\n"
    )
    st = Project(root).debug_print_status()
    assert st["variant"] == "expansion"
    assert st["debug_overworld_menu"] == "DISABLED_ON_RELEASE"
    assert st["debug_prints_enabled"] is None  # not derivable from one flag


def test_unknown_config_does_not_crash(tmp_path):
    root = _skeleton(tmp_path)
    st = Project(root).debug_print_status()
    assert st["config_found"] is False
    assert st["variant"] == "unknown"


def test_expansion_skeleton_is_a_valid_project(tmp_path):
    # An expansion-style fork is still a usable project (root detection, parsing).
    root = _skeleton(tmp_path)
    (root / "include" / "config").mkdir()
    (root / "include" / "config" / "debug.h").write_text("#define DEBUG_OVERWORLD_MENU TRUE\n")
    p = Project(root)
    assert p.list_layouts() == []
    assert p.info()["layout_count"] == 0
