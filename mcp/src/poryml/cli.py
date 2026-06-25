"""`poryml` CLI: thin wrapper over poryml.core that emits JSON.

Usable standalone (and in tests) without any MCP/Claude involvement, e.g.:

    poryml --root ~/code/.../pokeemerald info
    poryml list-layouts
    poryml read-blockdata LAYOUT_PETALBURG_CITY --grid
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from poryml.core.project import Project, ProjectError


def _project(args) -> Project:
    return Project.locate(Path(args.root) if args.root else None)


def _emit(obj) -> int:
    json.dump(obj, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


def cmd_info(args) -> int:
    return _emit(_project(args).info())


def cmd_list_maps(args) -> int:
    return _emit(_project(args).list_maps())


def cmd_list_layouts(args) -> int:
    return _emit([l.to_dict() for l in _project(args).list_layouts()])


def cmd_get_layout(args) -> int:
    return _emit(_project(args).get_layout(args.layout).to_dict())


def cmd_read_map(args) -> int:
    return _emit(_project(args).read_map(args.map))


def cmd_read_blockdata(args) -> int:
    bd = _project(args).read_layout_blockdata(args.layout)
    out = {
        "layout": args.layout,
        "width": bd.width,
        "height": bd.height,
        "block_count": len(bd.blocks),
        "unique_metatiles": len({b.metatile_id for b in bd.blocks}),
    }
    if args.grid:
        out["grid"] = bd.to_grid()
    return _emit(out)


def cmd_read_attributes(args) -> int:
    attrs = _project(args).read_metatile_attributes(args.path)
    return _emit({"path": args.path, "count": len(attrs), "attributes": [a.to_dict() for a in attrs]})


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="poryml", description="pokeemerald deterministic primitives")
    p.add_argument("--root", help="project root (default: auto-detect from cwd)")
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("info", help="project summary").set_defaults(func=cmd_info)
    sub.add_parser("list-maps", help="list all maps").set_defaults(func=cmd_list_maps)
    sub.add_parser("list-layouts", help="list all layouts").set_defaults(func=cmd_list_layouts)

    gl = sub.add_parser("get-layout", help="show one layout")
    gl.add_argument("layout")
    gl.set_defaults(func=cmd_get_layout)

    rm = sub.add_parser("read-map", help="read a map.json by id or name")
    rm.add_argument("map")
    rm.set_defaults(func=cmd_read_map)

    rb = sub.add_parser("read-blockdata", help="decode a layout's map.bin")
    rb.add_argument("layout")
    rb.add_argument("--grid", action="store_true", help="include full block grid")
    rb.set_defaults(func=cmd_read_blockdata)

    ra = sub.add_parser("read-attributes", help="decode a metatile_attributes.bin")
    ra.add_argument("path", help="project-relative path to metatile_attributes.bin")
    ra.set_defaults(func=cmd_read_attributes)

    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except ProjectError as e:
        json.dump({"error": str(e)}, sys.stderr, indent=2)
        sys.stderr.write("\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
