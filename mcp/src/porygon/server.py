"""porygon MCP server: exposes the core primitives as MCP tools.

Project root resolution order:
  1. the ``root`` argument passed to a tool, if given
  2. the ``PORYGON_PROJECT_ROOT`` environment variable
  3. auto-detect by walking up from the current working directory

Run with:  uv run python -m porygon.server   (stdio transport)
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from mcp.server.fastmcp import FastMCP

from porygon.core import build as buildmod
from porygon.core import emu as emumod
from porygon.core import imaging as imagingmod
from porygon.core import scripting as scriptmod
from porygon.core.blockdata import Blockdata
from porygon.core.diagnostics import SymbolResolver, parse_build_errors
from porygon.core.project import Project

mcp = FastMCP("porygon")


def _resolver(root: Optional[str] = None) -> SymbolResolver:
    project = _project(root)
    elf = project.elf_path()
    if elf is None:
        raise FileNotFoundError(
            f"no built ELF in {project.root} (looked for pokeemerald_modern.elf / "
            f"pokeemerald.elf). Build the project first (run the `build` tool or your "
            f"own build) - symbol/address resolution reads the compiled ELF."
        )
    return SymbolResolver(elf)


def _parse_addr(addr) -> int:
    """Accept an int or a hex/decimal string like '0x0806b424'."""
    if isinstance(addr, int):
        return addr
    return int(str(addr), 0)


def _project(root: Optional[str] = None) -> Project:
    if root:
        return Project(Path(root))
    env_root = os.environ.get("PORYGON_PROJECT_ROOT")
    return Project.locate(Path(env_root) if env_root else None)


@mcp.tool()
def project_info(root: Optional[str] = None) -> dict:
    """Summarize the pokeemerald project (root, layout/map counts, build targets)."""
    return _project(root).info()


@mcp.tool()
def list_maps(root: Optional[str] = None) -> list[dict]:
    """List all maps (id, name, layout)."""
    return _project(root).list_maps()


@mcp.tool()
def list_layouts(root: Optional[str] = None) -> list[dict]:
    """List all layouts with dimensions and tilesets."""
    return [l.to_dict() for l in _project(root).list_layouts()]


@mcp.tool()
def get_layout(layout: str, root: Optional[str] = None) -> dict:
    """Get one layout's metadata by id (e.g. LAYOUT_PETALBURG_CITY) or name."""
    return _project(root).get_layout(layout).to_dict()


@mcp.tool()
def read_map(map: str, root: Optional[str] = None) -> dict:
    """Read a map's map.json by id (MAP_*) or name."""
    return _project(root).read_map(map)


@mcp.tool()
def read_blockdata(layout: str, include_grid: bool = False, root: Optional[str] = None) -> dict:
    """Decode a layout's map.bin into blocks.

    By default returns a summary (dimensions, counts). Set include_grid=True to
    return the full row-major grid of {metatile_id, collision, elevation}.
    Grids can be large, so request them only when you need per-tile data.
    """
    bd = _project(root).read_layout_blockdata(layout)
    out = {
        "layout": layout,
        "width": bd.width,
        "height": bd.height,
        "block_count": len(bd.blocks),
        "unique_metatiles": len({b.metatile_id for b in bd.blocks}),
    }
    if include_grid:
        out["grid"] = bd.to_grid()
    return out


@mcp.tool()
def write_blockdata(layout: str, grid: list[list[dict]], root: Optional[str] = None) -> dict:
    """Write a row-major grid of blocks back to a layout's map.bin.

    grid is a list of rows; each cell is {metatile_id, collision, elevation}.
    Dimensions must match the layout's declared width/height. This mutates the
    project on disk - intended to be used behind a skill that shows the human a
    diff / Porymap preview first.
    """
    bd = Blockdata.from_grid(grid)
    path = _project(root).write_layout_blockdata(layout, bd)
    return {"written": str(path), "width": bd.width, "height": bd.height}


@mcp.tool()
def read_metatile_attributes(path: str, root: Optional[str] = None) -> dict:
    """Decode a tileset's metatile_attributes.bin (project-relative path)."""
    attrs = _project(root).read_metatile_attributes(path)
    return {"path": path, "count": len(attrs), "attributes": [a.to_dict() for a in attrs]}


@mcp.tool()
def build(target: str = "modern", dinfo: bool = True, root: Optional[str] = None) -> dict:
    """Build the ROM and return structured diagnostics.

    Runs `make modern` by default (override via $PORYGON_BUILD_CMD). Returns
    {ok, returncode, command, errors[], error_count, warning_count, raw_tail}.
    Each error is {file, line, col, severity, message, kind}. If the toolchain
    is missing, ok=False with an actionable message instead of crashing.
    """
    return buildmod.build(_project(root).root, target=target, dinfo=dinfo)


@mcp.tool()
def parse_build_log(text: str) -> list[dict]:
    """Parse pasted/captured build output into structured diagnostics.

    Use when the user pastes a `make` error log and wants it triaged to
    file:line. Handles gcc and agbcc formats and linker undefined-reference errors.
    """
    return parse_build_errors(text)


@mcp.tool()
def resolve_address(address, root: Optional[str] = None) -> dict:
    """Resolve a code address (e.g. a crash PC) to function + source file:line.

    address may be an int or a hex string like '0x0806b424'. Reads the built ELF's
    symbols + DWARF (no toolchain needed). Returns {address, function, file, line}.
    """
    return _resolver(root).resolve_address(_parse_addr(address))


@mcp.tool()
def lookup_symbol(name: str, root: Optional[str] = None) -> dict:
    """Look up a symbol's address by name from the built ELF (Thumb bit cleared)."""
    addr = _resolver(root).lookup_symbol(name)
    return {"name": name, "address": addr, "hex": f"0x{addr:08x}"}


@mcp.tool()
def emu_launch_command(gdb: bool = False, root: Optional[str] = None) -> dict:
    """Build the mGBA launch command for the project's ROM (does not spawn it).

    With gdb=True the command starts mGBA's GDB stub on port 2345. Returns the
    argv plus a gdb connect hint; the caller/user runs it (the server never opens a GUI).
    """
    project = _project(root)
    rom = project.rom_path()
    if rom is None:
        raise FileNotFoundError("no built ROM found (pokeemerald_modern.gba / pokeemerald.gba)")
    elf = project.elf_path()
    return {
        "command": emumod.launch_command(rom, gdb=gdb),
        "gdb_hint": emumod.gdb_connect_hint(elf) if (gdb and elf) else None,
        "debug_prints": project.debug_print_status(),
    }


@mcp.tool()
def validate_scripts(map: str, root: Optional[str] = None) -> dict:
    """Cross-check a map's events against its scripts.inc and the constants index.

    Flags event `script:` labels not defined in scripts.inc (dangling), undefined
    FLAG_/VAR_/ITEM_/gfx/movement constants (build failures), and unused labels.
    Run this before building to catch silent-break typos.
    """
    return scriptmod.validate_map_scripts(_project(root), map)


@mcp.tool()
def list_macros(root: Optional[str] = None) -> dict:
    """List the project's event/movement script macros (parsed from its own asm/macros)."""
    macros = scriptmod.load_macros(_project(root))
    return {"count": len(macros), "names": sorted(macros)}


@mcp.tool()
def lookup_macro(name: str, root: Optional[str] = None) -> dict:
    """Get a script macro's argument signature (name, required, default) by name."""
    found = scriptmod.lookup_macro(_project(root), name)
    if found is None:
        return {"name": name, "found": False}
    return {"found": True, **found}


@mcp.tool()
def read_map_events(map: str, root: Optional[str] = None) -> dict:
    """Read a map's object/warp/coord/bg events."""
    return _project(root).read_map_events(map)


@mcp.tool()
def add_object_event(map: str, event: dict, root: Optional[str] = None) -> dict:
    """Append an object_event (NPC/item) to a map.json (validates required fields)."""
    path = _project(root).add_event(map, "object_events", event)
    return {"written": str(path)}


@mcp.tool()
def add_sign(map: str, event: dict, root: Optional[str] = None) -> dict:
    """Append a bg_event (e.g. a sign) to a map.json (validates required fields)."""
    path = _project(root).add_event(map, "bg_events", event)
    return {"written": str(path)}


@mcp.tool()
def add_trigger(map: str, event: dict, root: Optional[str] = None) -> dict:
    """Append a coord_event (trigger) to a map.json (validates required fields)."""
    path = _project(root).add_event(map, "coord_events", event)
    return {"written": str(path)}


@mcp.tool()
def remove_event(map: str, kind: str, index: int, root: Optional[str] = None) -> dict:
    """Remove an event by kind (object_events/bg_events/coord_events/warp_events) and index."""
    path = _project(root).remove_event(map, kind, index)
    return {"written": str(path)}


@mcp.tool()
def add_warp(map: str, event: dict, root: Optional[str] = None) -> dict:
    """Append a warp_event (door/exit) to a map.json.

    event needs: x, y, elevation, dest_map (a MAP_ id), dest_warp_id. Validates
    that dest_map exists and dest_warp_id indexes a real warp on it.
    """
    path = _project(root).add_warp(map, event)
    return {"written": str(path)}


@mcp.tool()
def add_bg_event(map: str, event: dict, root: Optional[str] = None) -> dict:
    """Append a bg_event by its 'type': sign, hidden_item, or secret_base.

    Required fields per type (plus x/y/elevation):
    - sign: player_facing_dir, script
    - hidden_item: item, flag (forks may also accept quantity, underfoot)
    - secret_base: secret_base_id
    """
    path = _project(root).add_bg_event(map, event)
    return {"written": str(path)}


@mcp.tool()
def get_connections(map: str, root: Optional[str] = None) -> dict:
    """List a map's directional connections (neighbouring maps + offsets)."""
    return {"connections": _project(root).read_connections(map)}


@mcp.tool()
def edit_connection(map: str, action: str, direction: Optional[str] = None,
                    offset: Optional[int] = None, dest_map: Optional[str] = None,
                    index: Optional[int] = None, root: Optional[str] = None) -> dict:
    """Add/update/remove a map connection (up/down/left/right/dive/emerge).

    - add: needs direction, offset, dest_map
    - update: locate by direction (or index); set offset and/or dest_map
    - remove: locate by direction (or index)
    Validates dest_map exists.
    """
    path = _project(root).edit_connection(
        map, action, direction=direction, offset=offset, dest_map=dest_map, index=index
    )
    return {"written": str(path)}


@mcp.tool()
def set_map_properties(map: str, properties: dict, root: Optional[str] = None) -> dict:
    """Update top-level map metadata: weather, music, map_type, battle_scene,
    region_map_section, and flags (requires_flash, allow_cycling, allow_escaping,
    allow_running, show_map_name, floor_number). Rejects unknown/structural keys.
    """
    path = _project(root).set_map_properties(map, properties)
    return {"written": str(path)}


@mcp.tool()
def scaffold_script(map: str, kind: str, label: str, text: str = "PLACEHOLDER TEXT",
                    root: Optional[str] = None) -> dict:
    """Append a boilerplate script (kind: 'sign' or 'npc') to a map's scripts.inc.

    Returns the label to wire into a map event. Claude should then refine the
    generated .inc (dialogue, logic) and validate_scripts to confirm.
    """
    snippet = scriptmod.scaffold_script(kind, label, text)
    path = _project(root).append_script_inc(map, snippet)
    return {"label": label, "written": str(path), "snippet": snippet}


@mcp.tool()
def poryscript_status(root: Optional[str] = None) -> dict:
    """Report whether Poryscript is available and whether the project uses it."""
    return scriptmod.poryscript_status(_project(root))


@mcp.tool()
def compile_poryscript(pory_path: str, inc_path: str, root: Optional[str] = None) -> dict:
    """Compile a .pory to a .inc (only if poryscript is available for this project)."""
    return scriptmod.compile_poryscript(_project(root), pory_path, inc_path)


@mcp.tool()
def porytiles_status(root: Optional[str] = None) -> dict:
    """Report whether Porytiles (the tileset compiler) is installed + its version."""
    return imagingmod.porytiles_status(_project(root))


@mcp.tool()
def validate_image(image_path: str, root: Optional[str] = None) -> dict:
    """Check an image is usable for map generation (dims a multiple of 16px)."""
    return imagingmod.validate_image(image_path)


@mcp.tool()
def image_to_map(image_path: str, name: str, full_auto: bool = False,
                 root: Optional[str] = None) -> dict:
    """Turn an image into a NEW tileset + NEW layout, reviewable in Porymap.

    porygon dedups 16x16 cells + records placement; Porytiles compiles the tileset.
    full_auto=False (default) leaves collision passable for human review; full_auto=True
    applies a coarse collision suggestion. Requires Porytiles installed (check
    porytiles_status first). Best for tile-aligned / pixel-art images; complex images
    make Porytiles error on palette overflow (surfaced). The generated tileset is
    viewable in Porymap but needs C registration to build into the ROM.
    """
    return imagingmod.image_to_map(_project(root), image_path, name, full_auto=full_auto)


@mcp.tool()
def list_tilesets(root: Optional[str] = None) -> list[dict]:
    """List on-disk tilesets (folder, kind primary/secondary, metatile count).

    Use this to pick an existing tileset ('asset pack') to recreate a map into with
    image_to_existing_map - choose one whose art covers the source's terrain.
    """
    return _project(root).list_tilesets()


@mcp.tool()
def add_map(name: str, layout: str, map_id: Optional[str] = None,
            group: Optional[str] = None, root: Optional[str] = None) -> dict:
    """Create a walkable map: write data/maps/<name>/map.json and register it in
    map_groups.json (the build auto-generates its MAP_ constant). layout must exist.
    map_id defaults to MAP_<NAME_UPPER>.
    """
    project = _project(root)
    mid = map_id or imagingmod.names_for(name)["map_id"]
    path = project.add_map(mid, name, layout, group=group)
    return {"written": str(path), "map": mid, "name": name}


@mcp.tool()
def image_to_existing_map(image_path: str, name: str,
                          primary_tileset: str = "gTileset_General",
                          secondary_tileset: Optional[str] = None,
                          link_to: Optional[str] = None, link_dir: str = "left",
                          link_offset: int = 0, link_kind: str = "connection",
                          full_auto: bool = False, root: Optional[str] = None) -> dict:
    """Recreate a map from an image using an EXISTING tileset, then register a walkable
    map and (with link_to) wire it to a neighbour both ways so you can walk in and back.

    Matches each 16x16 cell to the visually-closest metatile in primary_tileset (+
    optional secondary). No Porytiles, no new tileset - because it references already-
    registered tilesets, a normal `make` builds it into the ROM with no C edits. Returns
    the new map id, a match_preview.png path, and a low-confidence-cell report to review
    in Porymap. link_dir is the neighbour's direction from the new map.
    """
    return imagingmod.image_to_existing_map(
        _project(root), image_path, name,
        primary_tileset=primary_tileset, secondary_tileset=secondary_tileset,
        link_to=link_to, link_dir=link_dir, link_offset=link_offset,
        link_kind=link_kind, full_auto=full_auto,
    )


@mcp.tool()
def list_stamps(root: Optional[str] = None) -> list[dict]:
    """List available stamp prefabs (multi-tile objects: house, lab, mart, ...) for compose_map.

    Stamps are recipes resolved against this project's own maps at compose time. Use this
    to see the object vocabulary before writing a MapSpec.
    """
    from porygon.core import compose

    return compose.list_stamps(_project(root))


@mcp.tool()
def extract_stamp(name: str, source_map: str, x: int, y: int, w: int, h: int,
                  door: Optional[list] = None, root: Optional[str] = None) -> dict:
    """Record a new stamp from a rectangle of an existing map (saved to <root>/.porygon/stamps.json).

    Use to grow the object library from this project's own buildings. door is an optional
    [dx,dy] offset within the stamp.
    """
    from porygon.core import compose

    return compose.extract_stamp(_project(root), name, source_map, x, y, w, h,
                                 door=tuple(door) if door else None)


@mcp.tool()
def compose_map(spec: dict, root: Optional[str] = None) -> dict:
    """Compose a walkable map from a high-level MapSpec (terrain regions + object stamps).

    For FOREIGN / imperfect source images where image_to_existing_map fragments buildings:
    you (vision) describe the scene as a MapSpec and this places multi-tile stamps as units
    so houses/labs stay coherent, then registers a walkable map and wires a reciprocal
    connection. Builds into the ROM with no C edits (existing tilesets + auto-generated
    MAP_ constant). MapSpec keys: name, primary_tileset, secondary_tileset, width, height,
    base_terrain, border_terrain, border_thickness, regions[], objects[], decorations[], link.
    Returns the map id, a match_preview.png to review, and any warnings. Call list_stamps and
    list_maps first to choose objects and a neighbour to link to.
    """
    from porygon.core import compose as composemod

    return composemod.compose_map(_project(root), spec)


@mcp.tool()
def init_basics_tileset(root: Optional[str] = None, force: bool = False) -> dict:
    """Generate the 'porygon basics' tileset (gTileset_PorygonBasics) into the project.

    A small, deliberately simple tileset (grass, water + rocky shoreline, bridge_h/bridge_v,
    forest, tall_grass, sand, path, rock, flower, sign, ledge, cliff, building) for rendering
    ANY image as a legible LOWFI map - it sidesteps emerald's per-tileset gaps (e.g. no bridges
    in the building tileset). Run this once, then compose_map with primary_tileset
    'gTileset_PorygonBasics'. Terrain classes incl. bridge_h/bridge_v (walkable) and rock.
    """
    from porygon.core import basics

    return basics.generate_basics_tileset(_project(root), force=force)


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
