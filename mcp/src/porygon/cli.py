"""`porygon` CLI: thin wrapper over porygon.core that emits JSON.

Usable standalone (and in tests) without any MCP/Claude involvement, e.g.:

    porygon --root ~/code/.../pokeemerald info
    porygon list-layouts
    porygon read-blockdata LAYOUT_PETALBURG_CITY --grid
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from porygon.core.diagnostics import SymbolError
from porygon.core.project import Project, ProjectError


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


def _resolver(args):
    from porygon.core.diagnostics import SymbolResolver

    elf = _project(args).elf_path()
    if elf is None:
        raise ProjectError("no built ELF found (pokeemerald_modern.elf / pokeemerald.elf)")
    return SymbolResolver(elf)


def cmd_build(args) -> int:
    from porygon.core import build as buildmod

    return _emit(buildmod.build(_project(args).root, target=args.target, dinfo=not args.no_dinfo))


def cmd_parse_log(args) -> int:
    from porygon.core.diagnostics import parse_build_errors

    text = sys.stdin.read() if args.file == "-" else open(args.file).read()
    return _emit(parse_build_errors(text))


def cmd_resolve_address(args) -> int:
    return _emit(_resolver(args).resolve_address(int(str(args.address), 0)))


def cmd_lookup_symbol(args) -> int:
    addr = _resolver(args).lookup_symbol(args.name)
    return _emit({"name": args.name, "address": addr, "hex": f"0x{addr:08x}"})


def cmd_emu_command(args) -> int:
    from porygon.core import emu as emumod

    project = _project(args)
    rom = project.rom_path()
    if rom is None:
        raise ProjectError("no built ROM found (pokeemerald_modern.gba / pokeemerald.gba)")
    return _emit(
        {
            "command": emumod.launch_command(rom, gdb=args.gdb),
            "gdb_hint": emumod.gdb_connect_hint(project.elf_path()) if args.gdb else None,
            "debug_prints": project.debug_print_status(),
        }
    )


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="porygon", description="pokeemerald deterministic primitives")
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

    bd = sub.add_parser("build", help="build the ROM and report diagnostics")
    bd.add_argument("--target", default="modern", help="make target (default: modern)")
    bd.add_argument("--no-dinfo", action="store_true", help="omit DINFO=1 (debug symbols)")
    bd.set_defaults(func=cmd_build)

    pl = sub.add_parser("parse-log", help="parse a build log into structured diagnostics")
    pl.add_argument("file", nargs="?", default="-", help="log file, or - for stdin (default)")
    pl.set_defaults(func=cmd_parse_log)

    ad = sub.add_parser("resolve-address", help="address -> function + file:line (from built ELF)")
    ad.add_argument("address", help="e.g. 0x0806b424")
    ad.set_defaults(func=cmd_resolve_address)

    ls = sub.add_parser("lookup-symbol", help="symbol name -> address (from built ELF)")
    ls.add_argument("name")
    ls.set_defaults(func=cmd_lookup_symbol)

    ec = sub.add_parser("emu-command", help="print the mGBA launch command for the ROM")
    ec.add_argument("--gdb", action="store_true", help="start mGBA's GDB stub (:2345)")
    ec.set_defaults(func=cmd_emu_command)

    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (ProjectError, SymbolError, FileNotFoundError, ValueError, OSError) as e:
        json.dump({"error": str(e)}, sys.stderr, indent=2)
        sys.stderr.write("\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
