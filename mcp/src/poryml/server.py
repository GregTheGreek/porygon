"""poryml MCP server: exposes the core primitives as MCP tools.

Project root resolution order:
  1. the ``root`` argument passed to a tool, if given
  2. the ``PORYML_PROJECT_ROOT`` environment variable
  3. auto-detect by walking up from the current working directory

Run with:  uv run python -m poryml.server   (stdio transport)
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from mcp.server.fastmcp import FastMCP

from poryml.core.blockdata import Blockdata
from poryml.core.project import Project

mcp = FastMCP("poryml")


def _project(root: Optional[str] = None) -> Project:
    if root:
        return Project(Path(root))
    env_root = os.environ.get("PORYML_PROJECT_ROOT")
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


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
