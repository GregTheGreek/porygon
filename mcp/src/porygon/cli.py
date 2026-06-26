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
from porygon.core.imaging import ImagingError
from porygon.core.project import Project, ProjectError
from porygon.core.tileset import TilesetError


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


def cmd_porytiles_status(args) -> int:
    from porygon.core import imaging

    return _emit(imaging.porytiles_status(_project(args)))


def cmd_validate_image(args) -> int:
    from porygon.core import imaging

    return _emit(imaging.validate_image(args.image))


def cmd_image_to_map(args) -> int:
    from porygon.core import imaging

    return _emit(imaging.image_to_map(_project(args), args.image, args.name, full_auto=args.full_auto))


def cmd_list_tilesets(args) -> int:
    return _emit(_project(args).list_tilesets())


def cmd_tileset_atlas(args) -> int:
    from porygon.core import tileset as tilesetmod

    project = _project(args)
    atlas = tilesetmod.render_tileset(project, args.primary, args.secondary)
    out = Path(args.out)
    tilesetmod.render_atlas_sheet(atlas).save(out)
    return _emit({"written": str(out), "metatiles": len(atlas.ids)})


def cmd_add_map(args) -> int:
    path = _project(args).add_map(args.map_id, args.name, args.layout, group=args.group)
    return _emit({"written": str(path), "map": args.map_id, "name": args.name})


def cmd_image_to_existing_map(args) -> int:
    from porygon.core import imaging

    return _emit(imaging.image_to_existing_map(
        _project(args), args.image, args.name,
        primary_tileset=args.primary, secondary_tileset=args.secondary,
        link_to=args.link_to, link_dir=args.link_dir, link_offset=args.link_offset,
        link_kind=args.link_kind, full_auto=args.full_auto,
    ))


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

    sub.add_parser("porytiles-status", help="report Porytiles availability/version").set_defaults(
        func=cmd_porytiles_status
    )

    vi = sub.add_parser("validate-image", help="check an image is usable (dims multiple of 16)")
    vi.add_argument("image")
    vi.set_defaults(func=cmd_validate_image)

    im = sub.add_parser("image-to-map", help="image -> new tileset + layout (reviewable in Porymap)")
    im.add_argument("image")
    im.add_argument("name", help="base name, e.g. MyTown")
    im.add_argument("--full-auto", action="store_true", help="apply collision suggestions (no review)")
    im.set_defaults(func=cmd_image_to_map)

    sub.add_parser("list-tilesets", help="list on-disk tilesets (folder, kind, metatile count)").set_defaults(
        func=cmd_list_tilesets
    )

    ta = sub.add_parser("tileset-atlas", help="render a tileset's metatiles to a preview PNG")
    ta.add_argument("primary", help="primary tileset label, e.g. gTileset_General")
    ta.add_argument("out", help="output PNG path")
    ta.add_argument("--secondary", default=None, help="secondary tileset label to include")
    ta.set_defaults(func=cmd_tileset_atlas)

    am = sub.add_parser("add-map", help="create a walkable map.json + register it in map_groups.json")
    am.add_argument("map_id", help="e.g. MAP_MY_TOWN")
    am.add_argument("name", help="map folder/name, e.g. MyTown")
    am.add_argument("layout", help="existing layout id, e.g. LAYOUT_MY_TOWN")
    am.add_argument("--group", default=None, help="map group (default: first in group_order)")
    am.set_defaults(func=cmd_add_map)

    ie = sub.add_parser("image-to-existing-map",
                        help="image -> layout+map reusing an EXISTING tileset (builds into ROM)")
    ie.add_argument("image")
    ie.add_argument("name", help="base name, e.g. MyTown")
    ie.add_argument("--primary", default="gTileset_General", help="primary tileset label to match against")
    ie.add_argument("--secondary", default=None, help="secondary tileset label")
    ie.add_argument("--link-to", default=None, help="neighbour map id to connect to (e.g. MAP_LITTLEROOT_TOWN)")
    ie.add_argument("--link-dir", default="left",
                    choices=["up", "down", "left", "right", "dive", "emerge"],
                    help="direction of the neighbour from the new map")
    ie.add_argument("--link-offset", type=int, default=0, help="connection offset")
    ie.add_argument("--link-kind", default="connection", choices=["connection", "warp"],
                    help="how to link (connection is auto-wired both ways)")
    ie.add_argument("--full-auto", action="store_true", help="apply collision suggestions (no review)")
    ie.set_defaults(func=cmd_image_to_existing_map)

    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (ProjectError, SymbolError, ImagingError, TilesetError, FileNotFoundError, ValueError, OSError) as e:
        json.dump({"error": str(e)}, sys.stderr, indent=2)
        sys.stderr.write("\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
