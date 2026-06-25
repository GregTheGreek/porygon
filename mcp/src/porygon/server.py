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


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
