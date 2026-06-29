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

    project = _project(args)
    elf = project.elf_path()
    if elf is None:
        raise ProjectError(
            f"no built ELF in {project.root} (looked for pokeemerald_modern.elf / "
            f"pokeemerald.elf). Build the project first (`porygon build` or your own build) "
            f"- symbol/address resolution reads the compiled ELF."
        )
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


def cmd_validate_scripts(args) -> int:
    from porygon.core import scripting

    return _emit(scripting.validate_map_scripts(_project(args), args.map))


def cmd_list_macros(args) -> int:
    from porygon.core import scripting

    m = scripting.load_macros(_project(args))
    return _emit({"count": len(m), "names": sorted(m)})


def cmd_lookup_macro(args) -> int:
    from porygon.core import scripting

    found = scripting.lookup_macro(_project(args), args.name)
    return _emit({"name": args.name, "found": False} if found is None else {"found": True, **found})


def cmd_read_events(args) -> int:
    return _emit(_project(args).read_map_events(args.map))


def cmd_scaffold_script(args) -> int:
    from porygon.core import scripting

    snippet = scripting.scaffold_script(args.kind, args.label, args.text)
    path = _project(args).append_script_inc(args.map, snippet)
    return _emit({"label": args.label, "written": str(path), "snippet": snippet})


def cmd_poryscript_status(args) -> int:
    from porygon.core import scripting

    return _emit(scripting.poryscript_status(_project(args)))


def cmd_add_event(args) -> int:
    event = json.loads(args.json)
    return _emit({"written": str(_project(args).add_event(args.map, args.kind, event))})


def cmd_remove_event(args) -> int:
    return _emit({"written": str(_project(args).remove_event(args.map, args.kind, args.index))})


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

    vs = sub.add_parser("validate-scripts", help="cross-check a map's events vs scripts.inc + constants")
    vs.add_argument("map")
    vs.set_defaults(func=cmd_validate_scripts)

    sub.add_parser("list-macros", help="list event/movement script macros").set_defaults(func=cmd_list_macros)

    lm = sub.add_parser("lookup-macro", help="show a script macro's argument signature")
    lm.add_argument("name")
    lm.set_defaults(func=cmd_lookup_macro)

    re_ = sub.add_parser("read-events", help="read a map's object/warp/coord/bg events")
    re_.add_argument("map")
    re_.set_defaults(func=cmd_read_events)

    sc = sub.add_parser("scaffold-script", help="append a boilerplate script to a map's scripts.inc")
    sc.add_argument("map")
    sc.add_argument("kind", choices=["sign", "npc"])
    sc.add_argument("label")
    sc.add_argument("--text", default="PLACEHOLDER TEXT")
    sc.set_defaults(func=cmd_scaffold_script)

    sub.add_parser("poryscript-status", help="report Poryscript availability/usage").set_defaults(
        func=cmd_poryscript_status
    )

    ae = sub.add_parser("add-event", help="append an event (JSON) to a map.json")
    ae.add_argument("map")
    ae.add_argument("kind", choices=["object_events", "bg_events", "coord_events", "warp_events"])
    ae.add_argument("json", help="event object as JSON")
    ae.set_defaults(func=cmd_add_event)

    rme = sub.add_parser("remove-event", help="remove an event by kind + index")
    rme.add_argument("map")
    rme.add_argument("kind", choices=["object_events", "bg_events", "coord_events", "warp_events"])
    rme.add_argument("index", type=int)
    rme.set_defaults(func=cmd_remove_event)

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
