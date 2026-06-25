"""Locate and parse a pokeemerald project: layouts, maps, tilesets.

Read-only by default; writing blockdata back goes through :meth:`Project.write_layout_blockdata`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from porygon.core.attributes import MetatileAttr, decode_attributes, encode_attributes
from porygon.core.blockdata import Blockdata, decode_blocks, encode_blocks


class ProjectError(Exception):
    """Raised when a project can't be located or a path doesn't resolve."""


# Files that together strongly indicate a pret Gen-3 decomp root.
_ROOT_MARKERS = (
    "data/layouts/layouts.json",
    "include/global.fieldmap.h",
)


def find_project_root(start: Optional[Path] = None) -> Path:
    """Walk up from ``start`` (default: cwd) looking for a decomp project root."""
    start = Path(start or Path.cwd()).resolve()
    candidates = [start, *start.parents]
    for d in candidates:
        if all((d / marker).exists() for marker in _ROOT_MARKERS):
            return d
    raise ProjectError(
        f"no pokeemerald project root found at or above {start} "
        f"(looked for {', '.join(_ROOT_MARKERS)})"
    )


@dataclass
class Layout:
    id: str
    name: str
    width: int
    height: int
    primary_tileset: str
    secondary_tileset: str
    border_filepath: str
    blockdata_filepath: str

    @classmethod
    def from_json(cls, d: dict) -> "Layout":
        return cls(
            id=d["id"],
            name=d["name"],
            width=int(d["width"]),
            height=int(d["height"]),
            primary_tileset=d.get("primary_tileset", ""),
            secondary_tileset=d.get("secondary_tileset", ""),
            border_filepath=d["border_filepath"],
            blockdata_filepath=d["blockdata_filepath"],
        )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "width": self.width,
            "height": self.height,
            "primary_tileset": self.primary_tileset,
            "secondary_tileset": self.secondary_tileset,
            "border_filepath": self.border_filepath,
            "blockdata_filepath": self.blockdata_filepath,
        }


class Project:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        if not (self.root / "data" / "layouts" / "layouts.json").exists():
            raise ProjectError(f"{self.root} does not look like a decomp project")

    @classmethod
    def locate(cls, start: Optional[Path] = None) -> "Project":
        return cls(find_project_root(start))

    # --- paths -----------------------------------------------------------
    def _resolve(self, rel: str) -> Path:
        """Resolve a project-relative path, refusing escapes outside the root."""
        p = (self.root / rel).resolve()
        if self.root not in p.parents and p != self.root:
            raise ProjectError(f"path {rel} escapes project root")
        return p

    # --- layouts ---------------------------------------------------------
    def _layouts_json(self) -> dict:
        return json.loads((self.root / "data" / "layouts" / "layouts.json").read_text())

    def list_layouts(self) -> list[Layout]:
        data = self._layouts_json()
        return [Layout.from_json(l) for l in data["layouts"] if l]

    def get_layout(self, layout_id: str) -> Layout:
        for layout in self.list_layouts():
            if layout.id == layout_id or layout.name == layout_id:
                return layout
        raise ProjectError(f"layout {layout_id!r} not found")

    def read_layout_blockdata(self, layout_id: str) -> Blockdata:
        layout = self.get_layout(layout_id)
        raw = self._resolve(layout.blockdata_filepath).read_bytes()
        return Blockdata.decode(raw, layout.width, layout.height)

    def write_layout_blockdata(self, layout_id: str, blockdata: Blockdata) -> Path:
        layout = self.get_layout(layout_id)
        if (blockdata.width, blockdata.height) != (layout.width, layout.height):
            raise ProjectError(
                f"blockdata dims {blockdata.width}x{blockdata.height} != "
                f"layout dims {layout.width}x{layout.height}; update layouts.json first"
            )
        path = self._resolve(layout.blockdata_filepath)
        path.write_bytes(blockdata.encode())
        return path

    def read_layout_border(self, layout_id: str):
        """Decode a layout's border blocks (emerald border is a fixed 2x2)."""
        layout = self.get_layout(layout_id)
        raw = self._resolve(layout.border_filepath).read_bytes()
        return decode_blocks(raw)

    # --- maps ------------------------------------------------------------
    def _maps_dir(self) -> Path:
        return self.root / "data" / "maps"

    def list_maps(self) -> list[dict]:
        maps = []
        for map_json in sorted(self._maps_dir().glob("*/map.json")):
            try:
                d = json.loads(map_json.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            maps.append({"id": d.get("id"), "name": d.get("name"), "layout": d.get("layout")})
        return maps

    def read_map(self, map_id_or_name: str) -> dict:
        for map_json in self._maps_dir().glob("*/map.json"):
            d = json.loads(map_json.read_text())
            if d.get("id") == map_id_or_name or d.get("name") == map_id_or_name:
                return d
        raise ProjectError(f"map {map_id_or_name!r} not found")

    # --- tilesets --------------------------------------------------------
    def read_metatile_attributes(self, attributes_path: str) -> list[MetatileAttr]:
        raw = self._resolve(attributes_path).read_bytes()
        return decode_attributes(raw)

    # --- summary ---------------------------------------------------------
    def info(self) -> dict:
        layouts = self.list_layouts()
        return {
            "root": str(self.root),
            "layout_count": len(layouts),
            "map_count": len(list(self._maps_dir().glob("*/map.json"))),
            "has_modern_target": "modern" in (self.root / "Makefile").read_text()
            if (self.root / "Makefile").exists()
            else False,
        }
