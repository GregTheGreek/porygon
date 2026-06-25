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

    def _map_dir(self, map_id_or_name: str) -> Path:
        for map_json in self._maps_dir().glob("*/map.json"):
            d = json.loads(map_json.read_text())
            if d.get("id") == map_id_or_name or d.get("name") == map_id_or_name:
                return map_json.parent
        raise ProjectError(f"map {map_id_or_name!r} not found")

    def read_map(self, map_id_or_name: str) -> dict:
        return json.loads((self._map_dir(map_id_or_name) / "map.json").read_text())

    def map_scripts_path(self, map_id_or_name: str):
        """Path to a map's scripts.inc, honoring shared_scripts_map."""
        d = self.read_map(map_id_or_name)
        shared = d.get("shared_scripts_map")
        map_dir = self._map_dir(shared) if shared else self._map_dir(map_id_or_name)
        return map_dir / "scripts.inc"

    def read_map_events(self, map_id_or_name: str) -> dict:
        d = self.read_map(map_id_or_name)
        return {k: d.get(k) or [] for k in ("object_events", "warp_events", "coord_events", "bg_events")}

    def _write_map(self, map_id_or_name: str, data: dict) -> Path:
        path = self._map_dir(map_id_or_name) / "map.json"
        # Match the repo style: 2-space indent + trailing newline, key order preserved.
        path.write_text(json.dumps(data, indent=2) + "\n")
        return path

    # Required fields per event kind (mirrors the mapjson schema).
    _EVENT_REQUIRED = {
        "object_events": ["graphics_id", "x", "y", "elevation", "movement_type",
                          "movement_range_x", "movement_range_y", "trainer_type",
                          "trainer_sight_or_berry_tree_id", "script", "flag"],
        "bg_events": ["type", "x", "y", "elevation"],
        "coord_events": ["type", "x", "y", "elevation", "var", "var_value", "script"],
        "warp_events": ["x", "y", "elevation", "dest_map", "dest_warp_id"],
    }

    def add_event(self, map_id_or_name: str, kind: str, event: dict) -> Path:
        """Append an event to a map. kind in object_events/bg_events/coord_events/warp_events."""
        if kind not in self._EVENT_REQUIRED:
            raise ProjectError(f"unknown event kind {kind!r}")
        missing = [f for f in self._EVENT_REQUIRED[kind] if f not in event]
        if missing:
            raise ProjectError(f"{kind} missing required fields: {', '.join(missing)}")
        d = self.read_map(map_id_or_name)
        d.setdefault(kind, [])
        if d[kind] is None:
            d[kind] = []
        d[kind].append(event)
        return self._write_map(map_id_or_name, d)

    def remove_event(self, map_id_or_name: str, kind: str, index: int) -> Path:
        d = self.read_map(map_id_or_name)
        arr = d.get(kind) or []
        if not (0 <= index < len(arr)):
            raise ProjectError(f"{kind} index {index} out of range (0..{len(arr) - 1})")
        del arr[index]
        return self._write_map(map_id_or_name, d)

    def append_script_inc(self, map_id_or_name: str, snippet: str) -> Path:
        """Append a scaffolded script block to a map's scripts.inc (creates if absent)."""
        path = self.map_scripts_path(map_id_or_name)
        existing = path.read_text() if path.exists() else ""
        sep = "" if existing.endswith("\n\n") or not existing else ("\n" if existing.endswith("\n") else "\n\n")
        path.write_text(existing + sep + snippet.rstrip() + "\n")
        return path

    # --- tilesets --------------------------------------------------------
    def read_metatile_attributes(self, attributes_path: str) -> list[MetatileAttr]:
        raw = self._resolve(attributes_path).read_bytes()
        return decode_attributes(raw)

    # --- build artifacts -------------------------------------------------
    def _artifact(self, modern_name: str, agbcc_name: str, prefer_modern: bool = True):
        """Return whichever built artifact exists, preferring modern."""
        modern = self.root / modern_name
        agbcc = self.root / agbcc_name
        order = (modern, agbcc) if prefer_modern else (agbcc, modern)
        for p in order:
            if p.exists():
                return p
        return None

    def elf_path(self):
        return self._artifact("pokeemerald_modern.elf", "pokeemerald.elf")

    def map_path(self):
        return self._artifact("pokeemerald_modern.map", "pokeemerald.map")

    def rom_path(self):
        return self._artifact("pokeemerald_modern.gba", "pokeemerald.gba")

    def debug_print_status(self) -> dict:
        """Report the project's debug configuration, vanilla- and expansion-aware.

        Vanilla pokeemerald: ``include/config.h`` with ``#define NDEBUG`` gating
        mgba_printf output. pokeemerald-expansion: an ``include/config/`` directory
        (``debug.h`` with ``DEBUG_OVERWORLD_MENU`` etc.) and no single NDEBUG flag.
        """
        vanilla = self.root / "include" / "config.h"
        expansion_dir = self.root / "include" / "config"

        if vanilla.exists():
            ndebug_defined = any(
                line.strip().startswith("#define NDEBUG")
                for line in vanilla.read_text().splitlines()
            )
            return {
                "config_found": True,
                "variant": "vanilla",
                "ndebug_defined": ndebug_defined,
                # mgba_printf etc. emit output only when NDEBUG is NOT defined.
                "debug_prints_enabled": not ndebug_defined,
            }

        if expansion_dir.is_dir():
            debug_h = expansion_dir / "debug.h"
            menu = None
            if debug_h.exists():
                for line in debug_h.read_text().splitlines():
                    s = line.strip()
                    if s.startswith("#define DEBUG_OVERWORLD_MENU"):
                        menu = s.split(None, 2)[2].split("//")[0].strip() if len(s.split(None, 2)) > 2 else None
                        break
            return {
                "config_found": True,
                "variant": "expansion",
                "debug_overworld_menu": menu,
                # Expansion has no single NDEBUG flag; mgba_printf status isn't
                # derivable from one constant, so report it as unknown.
                "debug_prints_enabled": None,
            }

        return {"config_found": False, "variant": "unknown", "debug_prints_enabled": None}

    # --- summary ---------------------------------------------------------
    def info(self) -> dict:
        layouts = self.list_layouts()
        elf = self.elf_path()
        return {
            "root": str(self.root),
            "layout_count": len(layouts),
            "map_count": len(list(self._maps_dir().glob("*/map.json"))),
            "has_modern_target": "modern" in (self.root / "Makefile").read_text()
            if (self.root / "Makefile").exists()
            else False,
            "built_elf": str(elf) if elf else None,
            "debug_prints_enabled": self.debug_print_status().get("debug_prints_enabled"),
        }
